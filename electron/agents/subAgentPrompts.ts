/**
 * Sub-agent prompt strings and small prompt-fragment builders.
 *
 * Centralizes the static prompt constants and the inline `<...>` template
 * fragments that used to live inside `runSubAgent`. Pure string builders only
 * — no side effects, no imports of runtime state. Extracted as part of the
 * subAgentRunner file split so prompt copy lives in one place.
 */

/** Prepended so the model sees it before the long role-specific prompt. */
export const SUB_AGENT_OUTPUT_LEAD = `[SUB-AGENT → PARENT — HARD RULE]
Your **final** assistant message (the one the parent reads as your result) must **begin** with the deliverable: the first line should be a markdown heading (\`##\`/\`###\`), a \`VERDICT:\` line, a \`\`\` fenced check block, or \`**Summary**\` — not intent narration.
Forbidden as the opening (including long paragraphs before any heading): "我将…/我先…/让我…/我来…/好的。/现在已理解…/可以交付…", "Let me…/I'll…/I will…/Now that I understand…". Tools already performed the steps; do not restate the plan in prose before the report.`

/**
 * Appended to every sub-agent system prompt (recency). Host may also strip obvious filler; still follow this.
 */
export const SUB_AGENT_PARENT_OUTPUT_DISCIPLINE = `=== SUB-AGENT → PARENT: ZERO PROCESS PLAY-BY-PLAY ===
The parent needs **only** the outcome document: plan sections, exploration summary, verification checks + VERDICT, etc.

**BAD (never emit as your final reply):** A long story of what you did or will do before the real sections — e.g. checking the working directory "to understand project state", then "制定全面的开发计划", then "我先检查…让我查看…我来详细查看…好的。项目处于…原型…现在我已完全理解…可以交付规划文档了" followed only then by \`### Implementation Plan\`. That entire preamble is **forbidden**; start at \`### Implementation Plan\` (or your role's required first heading).

**GOOD:** First token group of the final message is the first heading or fence or VERDICT line; evidence and commands live **under** those sections.

Between tool calls, keep assistant text minimal; the judged output is the **last** text-only turn.`

/** Stable header for the coordinator's worker-tool-surface block. */
export const COORDINATOR_TOOL_SURFACE_HEADER = '# Sub-agent tool surface (coordinator context)'

/** Spawn-depth rejection message (returned as the failed sub-agent output). */
export function buildAgentDepthRejectionMessage(maxDepth: number, currentDepth: number): string {
  return (
    `Agent spawn rejected: maximum nested agent depth (${maxDepth}) would be exceeded. ` +
    `Current depth=${currentDepth}. Override via POLE_MAX_AGENT_DEPTH env var for research.`
  )
}

/** Wrap the parent's inherited user-context as the first volatile block. */
export function wrapInheritedParentContext(parentUserCtx: string): string {
  return `<inherited-parent-context>\n${parentUserCtx}\n</inherited-parent-context>`
}

/** One semantic-retrieval hit (structural; mirrors `queryWorkspaceIndex` output). */
export interface WorkspaceRetrievalHit {
  filePath: string
  startLine: number
  endLine: number
  score: number
  text: string
}

/**
 * Build the `<retrieved-workspace-context>` block from semantic hits. Returns
 * `null` when there are no hits so callers can skip pushing an empty block.
 */
export function buildWorkspaceRetrievalBlock(hits: WorkspaceRetrievalHit[]): string | null {
  if (hits.length === 0) return null
  return [
    '<retrieved-workspace-context>',
    'These code snippets were selected by semantic similarity to your task. They are CONTEXT, not the only files you should read.',
    ...hits.map((h) => {
      const loc = `${h.filePath}:${h.startLine}-${h.endLine}`
      return `\n--- ${loc} (score ${h.score.toFixed(3)}) ---\n${h.text}`
    }),
    '</retrieved-workspace-context>',
  ].join('\n')
}

/** Notice injected when semantic recall did not finish within its budget. */
export function buildRetrievalIncompleteNotice(opts: {
  recalled: number
  workspaceEnabled: boolean
  budgetMs: number
}): string {
  const { recalled, workspaceEnabled, budgetMs } = opts
  return (
    `<retrieval-incomplete-notice>\n` +
    `Semantic recall (memory${workspaceEnabled ? ' + workspace index' : ''}) did not finish within the ` +
    `${budgetMs}ms budget; ${recalled === 0 ? 'NO' : 'only partial'} background context was attached. ` +
    `Do NOT assume the context above is exhaustive — use Read / Grep / Glob to gather what you need for the task.\n` +
    `</retrieval-incomplete-notice>`
  )
}
