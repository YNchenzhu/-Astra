/**
 * BestOfN tool — Cursor 3 `/best-of-n` parity.
 *
 * Runs one task N ways in parallel, each in its own isolated git worktree via a
 * worker-isolated sub-agent, scores the finished attempts (verification verdict
 * + diff + tests), and cherry-picks the winning commit back into the main repo.
 *
 * The model-facing result is a comparison table (ranked candidates with score,
 * verdict, diff size, and the winner highlighted) plus a structured
 * `bestOfNManifest` JSON block a richer renderer can consume.
 */

import { buildTool } from './buildTool'
import { bestOfNToolInputZod } from './toolInputZod'
import type { BestOfNResult } from '../orchestration/bestOfN'

// Audit H2: every heavy dependency is imported LAZILY inside `call()` (dynamic
// `import()`), NOT at module top level. `registryBuiltinTools` imports this
// file to build `builtinTools`; a static import of `bestOfNSubAgent` would pull
// in `subAgentRunner` → `tools/registry` → `registryBuiltinTools`, closing a
// circular dependency. Deferring to call-time keeps the static module graph of
// `builtinTools` free of the agent/sub-agent machinery (mirrors why the Agent
// tool lives in `registryAgentTools`, not here).

const DEFAULT_N = 3

function fmtVerdict(v: { verdict: string } | undefined): string {
  return v ? v.verdict : '—'
}

function fmtDiff(diff: { filesChanged: number; insertions: number; deletions: number } | undefined): string {
  if (!diff) return '—'
  if (diff.filesChanged === 0) return '∅'
  return `${diff.filesChanged}f +${diff.insertions} -${diff.deletions}`
}

function buildComparisonTable(res: BestOfNResult): string {
  const winnerIdx = res.winner?.attempt.attemptIndex
  const rows = res.ranked.map((r, rank) => {
    const a = r.attempt
    const isWinner = a.attemptIndex === winnerIdx
    const score = Number.isFinite(r.score) ? r.score.toFixed(1) : '✗ excluded'
    const status = a.error ? `error: ${a.error.slice(0, 40)}` : 'ok'
    return `| ${rank + 1}${isWinner ? ' 🏆' : ''} | #${a.attemptIndex} | ${score} | ${fmtVerdict(a.verification)} | ${fmtDiff(a.diff)} | ${status} |`
  })
  return [
    '| rank | attempt | score | verdict | diff | status |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

export const bestOfNTool = buildTool({
  name: 'BestOfN',
  searchHint: 'best of n parallel attempts compare explore strategies worktree pick winner cherry-pick',
  description:
    'Run ONE task N ways in parallel, each in an isolated git worktree, then score the results ' +
    'and cherry-pick the winning commit back into the working tree. Use for high-uncertainty changes ' +
    'where exploring multiple strategies beats a single attempt (tricky refactors, perf tuning, ' +
    'ambiguous bugs).\n' +
    '- `task`: the work to attempt (the same prompt is given to every attempt).\n' +
    '- `n` (optional): number of parallel attempts (default 3, capped at 6).\n' +
    '- `variants` (optional): per-attempt strategy hints; `variants[i]` steers attempt i toward a ' +
    'different approach (e.g. ["minimal diff", "use a state machine", "favor readability"]).\n' +
    '- `agent_type` (optional): worker agent type for each attempt (default "general-purpose").\n' +
    '- `verify` (optional): run the Verification agent in each worktree to score on PASS/FAIL (default true).\n' +
    '- `integrate` (optional): cherry-pick the winner into the working tree (default true).\n' +
    'Returns a ranked comparison table and a structured manifest. Requires the sub-agent worker for isolation.',
  inputSchema: [
    { name: 'task', type: 'string', description: 'The task each attempt should perform.', required: true },
    { name: 'n', type: 'number', description: 'Parallel attempts (default 3, max 6).', required: false },
    {
      name: 'variants',
      type: 'array',
      description: 'Optional per-attempt strategy hints; variants[i] steers attempt i.',
      required: false,
    },
    { name: 'agent_type', type: 'string', description: 'Worker agent type (default "general-purpose").', required: false },
    { name: 'verify', type: 'boolean', description: 'Run Verification per attempt to score (default true).', required: false },
    { name: 'integrate', type: 'boolean', description: 'Cherry-pick the winner into the working tree (default true).', required: false },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,
  zInputSchema: bestOfNToolInputZod,

  async call(input, ctx) {
    const [{ runBestOfN }, { createSubAgentRunAttempt }, { subAgentWorkerAvailable }, { getAgentContext }] =
      await Promise.all([
        import('../orchestration/bestOfN'),
        import('../orchestration/bestOfNSubAgent'),
        import('../agents/subAgentWorkerClient'),
        import('../agents/agentContext'),
      ])

    // Worktree isolation REQUIRES the worker path; without it, parallel
    // attempts would share the global workspace and clobber each other.
    if (!subAgentWorkerAvailable()) {
      return {
        success: false,
        error:
          'BestOfN requires the sub-agent worker (for per-attempt worktree isolation), which is not available in this build. ' +
          'Run a single attempt directly instead.',
      }
    }

    const n = typeof input.n === 'number' ? input.n : DEFAULT_N
    const conversationId = getAgentContext()?.streamConversationId

    // Audit M2: the winner is integrated by a raw `git cherry-pick` that never
    // passes through the PolicyEngine / diff-review the write/edit tools use. So
    // we gate auto-integration on the session's permission posture here: only
    // cherry-pick into the user's working tree when permissions are permissive
    // (`allow` / `bypassPermissions`). Under `ask` / `deny` (incl. plan mode,
    // which denies mutations), we keep the winner branch and hand back the
    // exact command to merge it after review. The model's `integrate:false`
    // still wins regardless.
    const userWantsIntegrate = input.integrate !== false
    const permPermits =
      ctx?.permissionMode === 'bypassPermissions' ||
      ctx?.permissionDefaultMode === 'allow' ||
      ctx?.permissionDefaultMode === undefined
    const integrationGatedByPermission = userWantsIntegrate && !permPermits

    const runAttempt = createSubAgentRunAttempt({
      ...(typeof input.agent_type === 'string' ? { agentType: input.agent_type } : {}),
      ...(typeof input.verify === 'boolean' ? { verify: input.verify } : {}),
    })

    let res: BestOfNResult
    try {
      res = await runBestOfN({
        task: input.task,
        n,
        ...(Array.isArray(input.variants) ? { variants: input.variants } : {}),
        runAttempt,
        integrateWinner: userWantsIntegrate && permPermits,
        // Keep every worktree when we won't auto-integrate, so a permission-
        // gated winner can still be merged by hand.
        ...(integrationGatedByPermission ? { keepWorktrees: true } : {}),
        ...(typeof conversationId === 'string' && conversationId.trim()
          ? { conversationId: conversationId.trim() }
          : {}),
        ...(ctx?.abortSignal ? { signal: ctx.abortSignal } : {}),
      })
    } catch (e) {
      return { success: false, error: `BestOfN failed: ${(e as Error).message}` }
    }

    const table = buildComparisonTable(res)
    const winnerLine = res.winner
      ? `Winner: attempt #${res.winner.attempt.attemptIndex} (score ${res.winner.score.toFixed(1)})` +
        (res.integrated ? ' — cherry-picked into the working tree.' : ' — NOT integrated (see notes).')
      : 'No eligible winner (every attempt errored or produced nothing).'
    const allNotes = [...res.notes]
    if (integrationGatedByPermission && res.winner?.attempt.commitSha) {
      allNotes.push(
        `auto-integration skipped (permission mode requires review). To apply the winner after ` +
          `reviewing it, run: \`git cherry-pick -x ${res.winner.attempt.commitSha}\` ` +
          `(winner worktree kept at ${res.winner.attempt.worktreePath ?? 'n/a'}).`,
      )
    }
    const notes = allNotes.length > 0 ? `\n\nNotes:\n${allNotes.map((x) => `- ${x}`).join('\n')}` : ''

    // Structured manifest for a richer renderer / the comparison UI.
    const manifest = {
      bestOfNManifest: {
        winnerAttemptIndex: res.winner?.attempt.attemptIndex ?? null,
        integrated: res.integrated,
        ranked: res.ranked.map((r) => ({
          attemptIndex: r.attempt.attemptIndex,
          score: Number.isFinite(r.score) ? r.score : null,
          verdict: r.attempt.verification?.verdict ?? null,
          diff: r.attempt.diff ?? null,
          error: r.attempt.error ?? null,
          reasons: r.reasons,
        })),
      },
    }

    return {
      success: !!res.winner,
      output: `${winnerLine}\n\n${table}${notes}\n\n<!-- ${JSON.stringify(manifest)} -->`,
      ...(res.winner ? {} : { error: 'BestOfN produced no usable winner.' }),
    }
  },
})
