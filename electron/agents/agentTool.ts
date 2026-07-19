/**
 * Agent tool — registers the Agent tool in the tool registry.
 *
 * When the main AI calls the Agent tool, it spawns a sub-agent with the
 * specified type and prompt. The sub-agent runs its own agentic loop
 * with filtered tools and a specialized system prompt.
 */

import type { Tool, ToolResult } from '../tools/types'
import { buildTool } from '../tools/buildTool'
import { agentToolInputZod } from '../tools/toolInputZod'
import { getAgentContext } from './agentContext'
import { getAgentToolPrompt } from './agentPrompt'
import { buildForkedMessages } from './forkSubagent'
import { runSubAgent, findAgentDefinition } from './subAgentRunner'
import type {
  AgentDefinitionUnion,
  SubAgentEvent,
  SubAgentResult,
  ActiveAgent,
} from './types'
import type { BrowserWindow } from 'electron'
import type { AgentId } from '../tools/ids'
import { asAgentId } from '../tools/ids'
import { makeUniqueTeammateAgentId } from './teamAgentIdFormat'
import {
  getActiveAgents as listActiveAgents,
  getActiveAgent,
  sendToAgent as registrySendToAgent,
  clearActiveAgentTimeout,
} from './activeAgentRegistry'
import {
  spawnAndTrackAgent,
  unspawnAndUntrackAgent,
} from './agentLifecycle'
import { evaluatePreAgentSpawn } from '../orchestration/preAgentGate'
import {
  getToolStopControllerFromScope,
  getToolUseIdFromStopScope,
  mergeWithParentToolStop,
} from '../ai/toolExecutionScope'
import { releaseToolStopController, retainToolStopController } from '../ai/toolStopRegistry'
import { isAgentToolTargetReadOnly } from './agentSpawnReadOnly'
import { getPermissionMode } from '../ai/interactionState'
import {
  resolveSubAgentPermissionOverride,
  OPENCLAUDE_BACKGROUND_SUBAGENT_TIMEOUT_MS,
} from './resolveSubAgentPermissionOverride'
import { resolveSubAgentModelFromEnv } from './subAgentModelEnv'
import { resolveAgentModelAlias } from './resolveAgentModelAlias'
import { MAX_SUB_AGENT_TEXT_BUFFER } from '../constants/toolLimits'
import { getMultiAgentOrchestrator } from './multiAgentOrchestratorSingleton'
// Streaming sub-agent text deltas into `taskRuntimeStore` (via the
// agent→parent-tool_use alias `subAgentRunner.linkAlias` already sets up at
// run start) gives `TaskOutput`:
//   1. live progress readback while a long sub-agent is still running
//      (previously TaskOutput showed only the initial "Tool start: Agent"
//      meta chunk because runAgenticToolUse only appended the final JSON
//      wrapper at completion);
//   2. a clean text view of the deliverable post-completion (no need to
//      JSON-parse `result.output` out of the SubAgentResult wrapper).
// The final JSON wrapper that `runAgenticToolUse` appends still lands in
// the same record after completion, so existing consumers keep working.
import { taskRuntimeStore } from '../tools/TaskRuntimeStore'
import { coalesceForIpc } from '../ai/streamCoalescer'
import { requestSubAgentTerminalWake } from './mainAgentWakeup'
import { parseVerdict, recordVerificationVerdict } from '../planning/verificationGateState'

// ========== Active Agent Tracking ==========

export function getActiveAgents(): Map<string, ActiveAgent> {
  return listActiveAgents()
}

export { getActiveAgent }

export function sendToAgent(idOrName: string, message: string): boolean {
  return registrySendToAgent(idOrName, message)
}

let mainWindowRef: BrowserWindow | null = null
let spawnedAgentCounter = 0

function nextSpawnedAgentId(prefix: 'agent-bg' | 'agent-fg'): AgentId {
  spawnedAgentCounter++
  return asAgentId(`${prefix}-${Date.now()}-${spawnedAgentCounter}`)
}

/**
 * S4 — choose the spawned sub-agent's id.
 *
 * When the caller supplied both `name` and `teamName`, mint a
 * deterministic upstream-style id (`<name>@<teamName>`) so SendMessage
 * by NAME hits a stable target across resumes / restarts. Otherwise
 * fall back to the legacy synthetic prefix (`agent-bg-<ts>-<n>` /
 * `agent-fg-<ts>-<n>`) — non-team sub-agents have no NAME-routing
 * obligation so the opaque id keeps logs / UI distinct.
 *
 * Uniqueness for teammate ids is enforced by walking up to 1024
 * suffixed candidates (`name-2@team`, `name-3@team`, …) so two
 * concurrent spawns of the same NAME on the same team don't collide.
 */
function chooseSpawnedAgentId(args: {
  name: string | undefined
  teamName: string | undefined
  prefix: 'agent-bg' | 'agent-fg'
}): AgentId {
  const trimmedName = (args.name ?? '').trim()
  const trimmedTeam = (args.teamName ?? '').trim()
  if (!trimmedName || !trimmedTeam) {
    return nextSpawnedAgentId(args.prefix)
  }
  return makeUniqueTeammateAgentId(trimmedName, trimmedTeam, (candidate) => {
    return getActiveAgent(candidate) !== undefined
  })
}

/** Buffer streamed text so the parent can read it via TeamStatus (not in main apiMessages). */
function recordSubAgentTextForParent(agentId: AgentId | undefined, chunk: string): void {
  if (!agentId || !chunk) return
  // Mirror into the `taskRuntimeStore` record at the parent's tool_use_id
  // (resolved through the alias `subAgentRunner.linkAlias` set in
  // `runSubAgent`). Independent of `getActiveAgent` so this works for both
  // foreground and background sub-agents — and so even sub-agents whose
  // ActiveAgent row never registered (e.g. fork-mode skill spawns) still
  // surface their text through `TaskOutput`.
  try {
    taskRuntimeStore.append(agentId, 'text', chunk)
  } catch {
    /* taskRuntimeStore append is best-effort; never break event emission */
  }
  const ag = getActiveAgent(agentId)
  if (!ag) return
  let s = (ag.latestTextOutput ?? '') + chunk
  if (s.length > MAX_SUB_AGENT_TEXT_BUFFER) s = s.slice(-MAX_SUB_AGENT_TEXT_BUFFER)
  ag.latestTextOutput = s
}

function finalizeSubAgentTextFromResult(agentId: AgentId | undefined, finalOutput: string | undefined): void {
  if (!agentId || finalOutput == null || !String(finalOutput).trim()) return
  const ag = getActiveAgent(agentId)
  if (!ag) return
  ag.latestTextOutput = String(finalOutput)
}

export function setMainWindow(win: BrowserWindow): void {
  mainWindowRef = win
}

/** Emit sub-agent stream events to the renderer (Agent tool, fork skills, etc.). */
export function emitSubAgentStreamEvent(event: SubAgentEvent): void {
  // In-process side effects run on every event (full fidelity). They feed
  // the parent's `<system-reminder>` injection buffer and the runtime
  // task store; coalescing them here would change parent-context shape.
  if (event.type === 'subagent_text' && 'agentId' in event && 'text' in event) {
    const t = (event as { agentId?: AgentId; text?: string }).text
    if (typeof t === 'string' && t.length > 0) {
      recordSubAgentTextForParent((event as { agentId?: AgentId }).agentId, t)
    }
  }
  if (event.type === 'subagent_complete' && 'agentId' in event && 'result' in event) {
    const r = (event as { agentId?: AgentId; result?: SubAgentResult }).result
    const out = r && typeof r.output === 'string' ? r.output : ''
    finalizeSubAgentTextFromResult((event as { agentId?: AgentId }).agentId, out)
  }
  if (!mainWindowRef) return
  const conversationId = getAgentContext()?.streamConversationId
  const parentToolUseId = getToolUseIdFromStopScope()
  const base =
    conversationId !== undefined && conversationId !== null && String(conversationId).trim()
      ? { ...event, conversationId: String(conversationId).trim() }
      : event
  const payload =
    parentToolUseId && String(parentToolUseId).trim()
      ? { ...(base as Record<string, unknown>), parentToolUseId: String(parentToolUseId).trim() }
      : base
  // Per-token deltas (`subagent_text` / `subagent_thinking_delta`) are
  // coalesced into ≤60Hz IPC bursts so 3+ concurrent sub-agents don't
  // flood the main-process event loop. Non-delta events flush the
  // pending buffer first and are forwarded immediately; renderer
  // ordering is preserved. See `electron/ai/streamCoalescer.ts`.
  coalesceForIpc(payload as Record<string, unknown>, (final) => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send('ai:stream-event', final)
    }
  })
}

/**
 * Build a short, human-readable digest of a sub-agent run for the parent
 * model. The digest summarizes:
 *   - top tool invocations (name × count)
 *   - failed tool calls (name + short error)
 *   - termination flags (truncated / max-iterations / aborted)
 *
 * Returns empty string when the run had no tool calls and no special flags
 * (no useful preface to add).
 */
export function formatSubAgentProcessDigest(result: SubAgentResult): string {
  const lines: string[] = []
  const counts = result.toolUseCounts
  const failures = result.toolFailures

  // Top tool invocations — show up to 6, sorted by count desc.
  if (counts && Object.keys(counts).length > 0) {
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
    const top = sorted.slice(0, 6).map(([name, n]) => `${name}×${n}`)
    const more = sorted.length > 6 ? `, +${sorted.length - 6} more` : ''
    lines.push(`Tools: ${top.join(', ')}${more}`)
  }

  // Failures — short list with bullet markers.
  if (failures && failures.length > 0) {
    const formatted = failures
      .slice(0, 5)
      .map((f) => `  - ${f.name}: ${f.error.slice(0, 120)}`)
    lines.push(`Failures (${failures.length}):`)
    lines.push(...formatted)
    if (failures.length > 5) lines.push(`  - … ${failures.length - 5} more failure(s) elided`)
  }

  // Termination flags — only emit when at least one fired.
  //
  // Output-aware framing: `result.success` is now true whenever the run
  // delivered a usable final report, EVEN IF it crossed an iteration / token
  // budget (the graceful wind-down or the final-summary rescue produced a
  // complete deliverable). In that case these flags are informational, not a
  // "the fork is broken" signal — so we say so explicitly instead of leaving
  // the parent to read "reached max iterations" as a failure.
  const flagBits: string[] = []
  if (result.reachedMaxIterations) flagBits.push('reached max iterations')
  if (result.aborted) flagBits.push('aborted (timeout or user stop)')
  if (result.truncated) flagBits.push('truncated (token budget)')
  if (flagBits.length > 0) {
    const suffix = result.success
      ? ' — a complete report was still produced below; treat these as informational'
      : ''
    lines.push(`Termination: ${flagBits.join(', ')}${suffix}`)
  }

  // Graceful wind-down — the report below was produced under a FORCED
  // tool-free "write your report now" turn triggered when the run approached a
  // soft budget line (read-only tool/token pressure, or the iteration cap),
  // NOT a self-chosen final reply. Symmetric with the rescue hint below;
  // distinct because wind-down fired while the agent was still alive (so the
  // report is usually more complete than a post-mortem rescue). Emitting this
  // lets the parent judge whether the report's "Unfinished work" items still
  // need follow-up. `success` stays true — this is not a failure.
  const windDown = result.windDown
  if (windDown) {
    const where =
      windDown.trigger === 'iterations' &&
      typeof windDown.iteration === 'number' &&
      typeof windDown.maxIterations === 'number'
        ? ` at iteration ${windDown.iteration}/${windDown.maxIterations}`
        : ''
    lines.push(
      `Graceful wind-down: the run hit ${windDown.trigger} budget pressure${where} and was forced to ` +
        `write its report in one tool-free turn; the output below is that budget-driven report, ` +
        `not a self-chosen completion — check its "Unfinished work" section before assuming the task is fully done.`,
    )
  }

  // Final-summary rescue — surfaces that the body below was produced by
  // a no-tool follow-up call after the main run died, NOT a clean reply.
  // Without this hint, the parent can mistake a rescued summary for an
  // intentional final report and skip the obvious next steps.
  const rescue = result.finalSummaryRescue
  if (rescue) {
    if (rescue.outcome === 'completed') {
      lines.push(
        `Final-summary rescue: a no-tool follow-up turn produced ${rescue.chars} chars in ${rescue.durationMs}ms; ` +
          `the output below is that rescue summary, not a normal completion.`,
      )
    } else if (rescue.outcome === 'timeout') {
      lines.push(
        `Final-summary rescue: timed out after ${rescue.durationMs}ms — the inline output is the best partial text available.`,
      )
    } else {
      lines.push(
        `Final-summary rescue: failed (${rescue.outcome}) after ${rescue.durationMs}ms — the inline output is the best partial text available.`,
      )
    }
  }

  // Char-cap truncation: distinct from token-budget `truncated`. Tells the
  // parent agent the inline `output` only carries the trailing window of
  // the sub-agent's full report, and points to the recovery path
  // (`TaskOutput` against this agent's task id) so it can paginate the
  // missing earlier sections instead of reasoning off the tail alone.
  if (result.outputCharTruncated && typeof result.outputOriginalCharCount === 'number') {
    const original = result.outputOriginalCharCount
    const taskIdHint = result.taskOutputTaskId || result.agentId
    lines.push(
      `Output truncation: kept trailing window of ${original}-char report; ` +
        `call \`TaskOutput\` with task_id="${taskIdHint}" (offset/limit) for the full text.`,
    )
  }

  // Layer D — fork-incomplete directive for the parent agent.
  //
  // Symptom this fixes: parent dispatches a sub-agent, the fork either
  // fails outright (`success === false`), runs out of iterations, gets
  // aborted, or is truncated. The parent then writes a text-only ack
  // ("好的，子代理失败了。我会综合分析。") and the noTools branch
  // terminates the loop. The user is left with an obviously incomplete
  // task and no clear path forward.
  //
  // Embedding a `<fork-incomplete-directive>` in the tool_result body
  // gives the parent a tool-use-shaped instruction it cannot misread.
  //
  // Output-aware gate (reuses the now output-aware `success`): the directive
  // fires ONLY when the run genuinely lacks a usable deliverable
  // (`success === false` — a user cancel, or a limit hit with NO report). A
  // run that crossed a budget but still produced a complete report via the
  // graceful wind-down / final-summary rescue reports `success === true`, so
  // it does NOT get the heavy "re-dispatch / continue / ask" directive — the
  // parent already has usable findings (whose own "Unfinished work" section
  // tells it what, if anything, still needs doing). This removes the previous
  // "success:true yet 'did NOT finish cleanly'" contradiction on the backstop
  // path. The termination flags above still surface the raw budget facts.
  const forkIncomplete = result.success === false
  if (forkIncomplete) {
    const reasons: string[] = []
    if (result.reachedMaxIterations) reasons.push('the sub-agent hit its max-iterations cap')
    if (result.aborted) reasons.push('the sub-agent was aborted')
    if (result.truncated) reasons.push("the sub-agent's output was truncated")
    // Fallback for a failure with no budget flag set (e.g. model_error / a
    // thrown tool exception): still name it so the directive isn't vague.
    if (reasons.length === 0) reasons.push('the sub-agent reported success=false')
    const reasonsLine = reasons.join('; ')

    const directive = [
      '<fork-incomplete-directive>',
      `This sub-agent fork did NOT finish cleanly — ${reasonsLine}. Do not stop the conversation just because the fork returned. On your next turn you must do exactly ONE of:`,
      '1. Re-dispatch the same task with a tighter scope, fixed inputs, or a different agent type if the previous attempt is recoverable.',
      '2. Call tools yourself (Read / Edit / Bash / Grep / TodoWrite / etc.) to make progress on the original user request without the fork.',
      '3. If neither is feasible, ask the user a concrete clarifying question — do not write a free-form "summary of failures" turn that ends the loop.',
      '</fork-incomplete-directive>',
    ].join('\n')
    lines.push(directive)
  }

  if (lines.length === 0) return ''
  return [
    `[Sub-agent process digest — ${result.agentType} (${result.totalToolUses} tool calls, ${result.totalDurationMs}ms)]`,
    ...lines,
  ].join('\n')
}

/**
 * Create the Agent tool. Called at registration time.
 *
 * @param getAllAgents Live accessor for all registered agents; used by
 *   `execute` + `isConcurrencySafe` so newly-synced custom agents become
 *   spawnable immediately (no rebuild needed for routing).
 * @param getVisibleAgents Optional live accessor for the subset of agents
 *   that should appear in the Agent tool's *description* shown to the main
 *   AI. Defaults to `getAllAgents`. The Settings panel's "hide from main"
 *   toggle uses this to remove a custom agent from the routing prompt
 *   without actually unregistering it.
 */
export function createAgentTool(
  getAllAgents: () => AgentDefinitionUnion[],
  getVisibleAgents?: () => AgentDefinitionUnion[],
): Tool {
  const visibleForPrompt = getVisibleAgents ?? getAllAgents
  return buildTool({
    name: 'Agent',
    description: getAgentToolPrompt(visibleForPrompt(), true),
    searchHint:
      'subagent sub-agent Explore Plan Debug Verification Coordinator general-purpose statusline-setup claude-code-guide fork delegate parallel worker ToolSearch not required',
    // Sub-agent results carry the JSON-stringified `SubAgentResult`
    // (success/agentId/output/totalTokens/...). The inner `output` field is
    // already capped at `SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS` (80_000), so
    // the wrapped payload sits at ~80k–82k chars in the common path.
    // Without this override the registry default (50_000) kicks in and the
    // parent agent only sees a 2k preview of the JSON wrapper — effectively
    // dropping ~96% of the sub-agent's reported output. 100_000 leaves
    // ~20k headroom for JSON escaping + metadata while still keeping the
    // disk-spill safety net for pathological >100k payloads.
    maxResultChars: 100_000,
    zInputSchema: agentToolInputZod,
    inputSchema: [
      { name: 'description', type: 'string', description: 'A short (3-5 word) description of the task', required: true },
      {
        name: 'prompt',
        type: 'string',
        description:
          'The task for the agent to perform (alias: task). The agent cannot see the conversation — this prompt is its ONLY source of intent. It MUST carry the user\'s key constraints verbatim: exact quantities with their units/measure words (e.g. "30 种工具" = 30 distinct tools, not 30 invocations), scope, target objects, and the acceptance criterion. Quote the user\'s original phrasing for anything precision-critical rather than paraphrasing it.',
        required: true,
      },
      {
        name: 'task',
        type: 'string',
        description:
          'Alias for `prompt` — accepted because Claude Code\'s built-in Task tool uses this name; the runtime maps `task` → `prompt` when only `task` is supplied. Use `prompt` for new code.',
      },
      {
        name: 'subagent_type',
        type: 'string',
        description:
          'The type of agent to use. For bug fixes or code changes, pass "general-purpose" explicitly. Omit only when you intentionally want the host default fork behaviour and no allowed_subagent_types allowlist conflicts.',
      },
      {
        name: 'thoroughness',
        type: 'string',
        description:
          'For Explore: quick | medium | very thorough — how deep to search the codebase (optional).',
      },
      { name: 'model', type: 'string', description: 'Optional model override for the agent' },
      { name: 'run_in_background', type: 'boolean', description: 'Set to true to run this agent in the background' },
      { name: 'name', type: 'string', description: 'Optional name for this agent instance' },
      { name: 'team_name', type: 'string', description: 'Optional team (TeamCreate) to associate; inherits parent team when omitted.' },
      {
        name: 'allowed_subagent_types',
        type: 'array',
        description:
          'Optional allowlist of agentType strings; rejects spawn if resolved type is not listed (alias: allowedAgentTypes).',
        items: { type: 'string', description: 'agentType' },
      },
      {
        name: 'allowedAgentTypes',
        type: 'array',
        description:
          'Alias for `allowed_subagent_types` (camelCase). Either form is accepted; prefer the snake_case canonical name.',
        items: { type: 'string', description: 'agentType' },
      },
    ],
    isReadOnly: true,
    isConcurrencySafe: (input) => isAgentToolTargetReadOnly(input, getAllAgents()),
    async call(input, _ctx): Promise<ToolResult> {
      const raw = input as Record<string, unknown>
      normalizeAgentToolInput(raw)
      const {
        description,
        prompt,
        subagent_type,
        model: modelOverride,
        run_in_background: runInBackgroundInput,
        name,
        team_name,
        allowed_subagent_types,
        allowedAgentTypes,
      } = raw as {
        description: string
        prompt: string
        subagent_type?: string
        model?: string
        run_in_background?: boolean
        name?: string
        team_name?: string
        allowed_subagent_types?: unknown
        allowedAgentTypes?: unknown
      }

      const parentCtx = getAgentContext()
      if (!parentCtx) {
        return { success: false, error: 'No active agent context. The Agent tool can only be used within an agentic loop.' }
      }

      const allAgents = getAllAgents()
      const rawType = typeof subagent_type === 'string' ? subagent_type.trim() : ''

      // §2.5 / §3.3 — omitted `subagent_type` uses implicit fork definition when present (maxTurns 200, etc.).
      const agentDef = rawType
        ? findAgentDefinition(rawType, allAgents)
        : findAgentDefinition('fork', allAgents) ?? findAgentDefinition('general-purpose', allAgents)

      if (!agentDef) {
        const availableTypes = allAgents.map(a => a.agentType).join(', ')
        return {
          success: false,
          error: `Unknown agent type: "${subagent_type || 'fork'}". Available types: ${availableTypes}`,
        }
      }

      const allowedRaw = allowed_subagent_types ?? allowedAgentTypes
      const allowedList: string[] = Array.isArray(allowedRaw)
        ? allowedRaw.map((x) => String(x).trim()).filter(Boolean)
        : typeof allowedRaw === 'string'
          ? allowedRaw
              .split(/[,|]/g)
              .map((s) => s.trim())
              .filter(Boolean)
          : []
      if (allowedList.length > 0) {
        const canon = agentDef.agentType
        const ok = allowedList.some(
          (t) => t === canon || t.toLowerCase() === canon.toLowerCase(),
        )
        if (!ok) {
          return {
            success: false,
            error: `Agent type "${canon}" is not in allowed_subagent_types (${allowedList.join(', ')}).`,
          }
        }
      }

      const policy = agentDef.parentPolicy ?? 'inherit'

      let forkMessages: Array<Record<string, unknown>> | undefined
      const wantsForkTranscript =
        (!rawType || agentDef.agentType === 'fork') && policy !== 'isolated'
      if (wantsForkTranscript) {
        const built = buildForkedMessages(prompt)
        if (!built.ok) {
          return { success: false, error: built.error }
        }
        forkMessages = built.messages
      }

      const teamName =
        policy === 'isolated'
          ? (typeof team_name === 'string' && team_name.trim()) || undefined
          : (typeof team_name === 'string' && team_name.trim()) || parentCtx.teamId

      const convId =
        typeof parentCtx.streamConversationId === 'string' && parentCtx.streamConversationId.trim()
          ? parentCtx.streamConversationId.trim()
          : parentCtx.streamConversationId

      const gate = evaluatePreAgentSpawn({
        conversationId: convId,
        parentSessionAgentType: parentCtx.sessionAgentType,
        targetDef: agentDef,
      })
      if (!gate.ok) {
        return { success: false, error: gate.error }
      }

      const run_in_background =
        typeof runInBackgroundInput === 'boolean'
          ? runInBackgroundInput
          : agentDef.background === true

      // Enforce concurrency ceiling before any spawn (dead-code fix).
      const orchestrator = getMultiAgentOrchestrator()
      const parentKernelId = parentCtx.agentId ? String(parentCtx.agentId) : 'main-chat'
      try {
        orchestrator.enforceConcurrencyLimit(parentKernelId)
      } catch (ceilingErr) {
        const msg = ceilingErr instanceof Error ? ceilingErr.message : String(ceilingErr)
        return { success: false, error: msg }
      }

      const agentDefForRun =
        run_in_background && agentDef.timeout === undefined
          ? ({
              ...agentDef,
              timeout: OPENCLAUDE_BACKGROUND_SUBAGENT_TIMEOUT_MS,
            } as AgentDefinitionUnion)
          : agentDef

      const parentEffectivePermissionMode = getPermissionMode()
      const permissionModeOverride = resolveSubAgentPermissionOverride({
        agentDef: agentDefForRun,
        runInBackground: run_in_background,
        parentEffectiveMode: parentEffectivePermissionMode,
      })

      // Resolve upstream-style short aliases (`sonnet` / `opus` / `haiku` /
      // `inherit`) to a real provider model id. Without this, any agent
      // definition copied from the upstream ecosystem would send a literal
      // "sonnet" to the provider and fail against OpenAI / Gemini / Zhipu / …
      // (see `resolveAgentModelAlias` for the matrix and fallback rules).
      let model = resolveAgentModelAlias(
        agentDef.model,
        parentCtx.model,
        parentCtx.config.id,
      )
      const envSubModel = resolveSubAgentModelFromEnv()
      if (envSubModel) model = envSubModel
      // `modelOverride` comes from the tool_use input (explicit invocation). It
      // may itself be an alias, so route it through the same resolver.
      if (modelOverride) {
        model = resolveAgentModelAlias(
          modelOverride,
          parentCtx.model,
          parentCtx.config.id,
        )
      }

      const abortController = new AbortController()
      // Foreground: parent stream + optional per–tool_use stop (UI stop). Background: tool stop only
      // so the main chat can finish while the worker keeps running until stopped or timeout.
      const toolStopSignal = getToolStopControllerFromScope()?.signal
      if (!run_in_background) {
        const merged = mergeWithParentToolStop(parentCtx.signal)
        if (merged.aborted) {
          abortController.abort()
        } else {
          merged.addEventListener('abort', () => abortController.abort(), { once: true })
        }
      } else if (toolStopSignal) {
        if (toolStopSignal.aborted) {
          abortController.abort()
        } else {
          toolStopSignal.addEventListener('abort', () => abortController.abort(), { once: true })
        }
      }

      const handleEvent = (event: SubAgentEvent): void => {
        emitSubAgentStreamEvent(event)
      }

      const subParams = {
        config: parentCtx.config,
        model,
        agentDef: agentDefForRun,
        prompt,
        description,
        name,
        teamName,
        parentMessages: forkMessages,
        appendParentPrompt: !forkMessages,
        parentSystemPrompt: forkMessages ? parentCtx.systemPrompt : undefined,
        signal: abortController.signal,
        onEvent: handleEvent,
        permissionModeOverride,
      }

      if (run_in_background) {
        const agentId: AgentId = chooseSpawnedAgentId({
          name,
          teamName,
          prefix: 'agent-bg',
        })

        // Worktree isolation: when the agent definition requests it, try to
        // allocate a dedicated worktree via the orchestrator (no-op if no
        // allocator is configured yet).
        const worktreePath =
          agentDef.isolation === 'worktree'
            ? await orchestrator.allocateWorktreeFor({
                parentConversationId: parentCtx.streamConversationId,
                childKernelId: String(agentId),
                agentType: agentDefForRun.agentType,
              })
            : undefined

        const activeAgent: ActiveAgent = {
          agentId,
          agentType: agentDefForRun.agentType,
          agentDef: agentDefForRun,
          description,
          name,
          teamName,
          parentAgentId: parentCtx.agentId,
          streamConversationId:
            typeof parentCtx.streamConversationId === 'string' &&
            parentCtx.streamConversationId.trim()
              ? parentCtx.streamConversationId.trim()
              : parentCtx.streamConversationId,
          messages: [],
          pendingMessages: [],
          abortController,
          startTime: Date.now(),
          status: 'running',
          resolve: () => {},
          tokenCount: 0,
          tokenBudgetExceeded: false,
          // P1-1: snapshot the spawn-time permission mode for the
          // Running Agents panel. `permissionModeOverride` is the
          // resolved effective mode (agent-def → parent inheritance →
          // 'default' fallback) and matches what the sub-agent's ALS
          // chain will read via `getPermissionMode()` for tool gating.
          ...(permissionModeOverride !== undefined
            ? { permissionModeSnapshot: permissionModeOverride }
            : {}),
        }
        // Track in both `activeAgentRegistry` (handles/timeout/mailbox/budget)
        // AND `MultiAgentOrchestrator` (tree cascade / worktree / concurrency)
        // atomically via the lifecycle facade — see `agentLifecycle.ts`.
        const tracked = spawnAndTrackAgent(activeAgent, {
          ...(worktreePath ? { worktreePath } : {}),
        })
        if (!tracked.ok) {
          return { success: false, error: tracked.error }
        }

        const scopedToolUseId = getToolUseIdFromStopScope()
        if (scopedToolUseId) {
          retainToolStopController(scopedToolUseId)
        }

        // B6 — eager linkAlias closes the race window where a parent that
        // immediately polls TaskOutput by `agentId` (instead of the canonical
        // `taskOutputTaskId`) would get "Task not found" because
        // `subAgentRunner.linkAlias` had not yet executed in its own
        // microtask. linkAlias is idempotent (Map.set), so the same call
        // inside `runSubAgent` is a harmless no-op overwrite.
        const bgParentToolUseId = scopedToolUseId?.trim() || ''
        if (bgParentToolUseId) {
          try {
            taskRuntimeStore.linkAlias(agentId, bgParentToolUseId)
          } catch {
            /* linkAlias is best-effort — never sink the spawn */
          }
          // B5 — heartbeat: tell the parent (via TaskOutput) that the
          // sub-agent IS dispatched and currently booting, before any model
          // tokens arrive. Without this beat, an early `TaskOutput` poll
          // returns zero items and reads as "(no output)" → the parent
          // misreads "still loading" as "produced nothing". The beat lands
          // on the same runtime record (resolved through the alias).
          try {
            taskRuntimeStore.append(
              bgParentToolUseId,
              'meta',
              `Sub-agent dispatched (agentType=${agentDefForRun.agentType}, model=${model}, id=${agentId}); booting…\n`,
            )
          } catch {
            /* heartbeat is best-effort */
          }
        }

        // Only team members need to stay alive after their agentic loop ends
        // (they participate in the SendMessage/mailbox protocol). Fire-and-forget
        // background sub-agents must terminate naturally — otherwise they hang
        // forever in `waitForAgentMailboxOrAbort` after the model stops emitting
        // tool_use, `subagent_complete` is never fired, and the UI shows
        // "running" indefinitely while the agent is in fact idle. Matches the
        // existing convention in `sendMessageDiskRecovery.ts`.
        const stayRunningForSendMessage = Boolean(teamName?.trim())
        runSubAgent({
          ...subParams,
          agentIdOverride: agentId,
          stayRunningForSendMessage,
          ...(worktreePath ? { workspaceOverride: worktreePath } : {}),
        })
          .then((result) => {
            clearActiveAgentTimeout(activeAgent)
            activeAgent.status = result.success ? 'completed' : 'failed'
            activeAgent.endedAt = Date.now()
            if (!result.success) {
              const errMsg =
                typeof (result as { error?: string }).error === 'string'
                  ? (result as { error?: string }).error
                  : ''
              if (errMsg) activeAgent.terminalError = errMsg
            }
            activeAgent.resolve(result)
            // A2 — flip the runtime record's terminal status NOW (the agentic
            // loop deferred this via `deferredRuntimeStoreCompletion`). Without
            // this call, `TaskOutput` would forever show `Status: completed`
            // (set incorrectly at spawn time) regardless of the sub-agent's
            // real outcome — the root cause of "parent thinks sub-agent
            // produced no useful output".
            if (bgParentToolUseId) {
              try {
                if (result.success) {
                  taskRuntimeStore.append(
                    bgParentToolUseId,
                    'meta',
                    `Sub-agent ${agentId} finished (durationMs=${result.totalDurationMs}, tokens=${result.totalTokens}, toolUses=${result.totalToolUses}).\n`,
                  )
                  taskRuntimeStore.markCompleted(bgParentToolUseId)
                } else {
                  taskRuntimeStore.markFailed(
                    bgParentToolUseId,
                    `Sub-agent ${agentId} failed${
                      typeof (result as { error?: string }).error === 'string'
                        ? `: ${(result as { error?: string }).error}`
                        : ''
                    }`,
                  )
                }
              } catch {
                /* terminal mark is best-effort — registry is the source of truth */
              }
            }
            // Wake-up (audit 2026-06): the spawning main turn has usually
            // ended by the time a background sub-agent finishes — nothing
            // else re-triggers the main agent. The renderer-side
            // auto-resume controller applies all safety guards
            // (idle-only, draft protection, debounce, rolling cap).
            requestSubAgentTerminalWake({
              agentId: String(agentId),
              success: result.success,
              ...(teamName ? { teamName } : {}),
            })
            // AGENT-02: reduced from 30s to 5s to free concurrency slots sooner.
            setTimeout(() => unspawnAndUntrackAgent(agentId), 5000)
          })
          .catch((err) => {
            clearActiveAgentTimeout(activeAgent)
            activeAgent.status = 'failed'
            activeAgent.endedAt = Date.now()
            const crashMsg =
              err instanceof Error ? err.message : String(err ?? 'sub-agent crashed')
            activeAgent.terminalError = crashMsg
            activeAgent.resolve({
              success: false,
              agentId,
              agentType: agentDefForRun.agentType,
              output: '',
              totalTokens: 0,
              totalDurationMs: Date.now() - activeAgent.startTime,
              totalToolUses: 0,
            })
            // A2 — propagate crash to the runtime record so TaskOutput shows
            // `Status: failed` with a real error message, not the stale
            // `Status: completed` left by the spawn-time markCompleted bug.
            if (bgParentToolUseId) {
              try {
                const msg = err instanceof Error ? err.message : String(err ?? 'sub-agent crashed')
                taskRuntimeStore.markFailed(bgParentToolUseId, `Sub-agent ${agentId} crashed: ${msg}`)
              } catch {
                /* terminal mark is best-effort */
              }
            }
            // Wake-up (audit 2026-06): crashes need the wake MORE than
            // successes — the main agent must decide whether to retry.
            requestSubAgentTerminalWake({
              agentId: String(agentId),
              success: false,
              ...(teamName ? { teamName } : {}),
            })
            // BUG-S1 fix: align with success path (5s) so the crash path
            // does not occupy MAX_CONCURRENT_AGENTS slots for 30s. Terminal
            // history is persisted by `unregisterActiveAgent` regardless,
            // so the diagnostic data is not lost.
            setTimeout(() => unspawnAndUntrackAgent(agentId), 5000)
          })
          .finally(() => {
            if (scopedToolUseId) {
              releaseToolStopController(scopedToolUseId)
            }
            // Orchestrator unregister now lives inside `unspawnAndUntrackAgent`
            // (called from the .then/.catch above) — see `agentLifecycle.ts`.
          })

        return {
          success: true,
          // A1 — tell the agentic loop NOT to mark the runtime record
          // terminal yet. The .then/.catch above will flip status when the
          // sub-agent actually finishes (or crashes). Without this flag the
          // runtime record was set to `completed` at spawn time, which is
          // the root cause of the user's symptom "parent agent asserts
          // sub-agent has no output while it's still working".
          deferredRuntimeStoreCompletion: true,
          output: JSON.stringify({
            agentId,
            status: 'running',
            agentType: agentDefForRun.agentType,
            description,
            teamName: teamName || null,
            ...(bgParentToolUseId ? { taskOutputTaskId: bgParentToolUseId } : {}),
          }),
        }
      }

      // Register foreground sub-agent with MultiAgentOrchestrator so
      // interruptTree / pauseTree / resumeTree cascade correctly.
      const fgAgentId = chooseSpawnedAgentId({
        name,
        teamName,
        prefix: 'agent-fg',
      })
      const fgOrchestratorId = String(fgAgentId)

      // Worktree isolation: when the agent definition requests it, try to
      // allocate a dedicated worktree via the orchestrator (no-op if no
      // allocator is configured yet).
      const fgWorktreePath =
        agentDef.isolation === 'worktree'
          ? await orchestrator.allocateWorktreeFor({
              parentConversationId: parentCtx.streamConversationId,
              childKernelId: fgOrchestratorId,
              agentType: agentDefForRun.agentType,
            })
          : undefined

      // BUG-A1 fix: foreground sub-agents must also be registered with the
      // active-agent registry. Without this they bypass MAX_CONCURRENT_AGENTS,
      // do not appear in `agents:list-active`, and cannot be aborted via
      // `agents:abort-active`. Registration also gives them the 2x-timeout
      // failsafe in `cleanupStaleAgents`.
      const fgActiveAgent: ActiveAgent = {
        agentId: fgAgentId,
        agentType: agentDefForRun.agentType,
        agentDef: agentDefForRun,
        description,
        name,
        teamName,
        parentAgentId: parentCtx.agentId,
        streamConversationId:
          typeof parentCtx.streamConversationId === 'string' &&
          parentCtx.streamConversationId.trim()
            ? parentCtx.streamConversationId.trim()
            : parentCtx.streamConversationId,
        messages: [],
        pendingMessages: [],
        abortController,
        startTime: Date.now(),
        status: 'running',
        resolve: () => {},
        tokenCount: 0,
        tokenBudgetExceeded: false,
        // P1-1: see background-spawn site above for rationale.
        ...(permissionModeOverride !== undefined
          ? { permissionModeSnapshot: permissionModeOverride }
          : {}),
      }
      // Track in both registries atomically — see `agentLifecycle.ts`.
      const fgTracked = spawnAndTrackAgent(fgActiveAgent, {
        ...(fgWorktreePath ? { worktreePath: fgWorktreePath } : {}),
      })
      if (!fgTracked.ok) {
        return { success: false, error: fgTracked.error }
      }

      try {
        const result = await runSubAgent({
          ...subParams,
          agentIdOverride: fgAgentId,
          ...(fgWorktreePath ? { workspaceOverride: fgWorktreePath } : {}),
        })

        clearActiveAgentTimeout(fgActiveAgent)
        fgActiveAgent.status = result.success ? 'completed' : 'failed'
        fgActiveAgent.endedAt = Date.now()
        if (!result.success) {
          const errMsg =
            typeof (result as { error?: string }).error === 'string'
              ? (result as { error?: string }).error
              : ''
          if (errMsg) fgActiveAgent.terminalError = errMsg
        }

        // Success is now the single, output-aware authority (see
        // `subAgentRunner.ts`): `result.success` is already true whenever the
        // run delivered a usable report — INCLUDING the "hit maxIter / budget
        // but the graceful wind-down or final-summary rescue still produced a
        // complete report" case that the old `partialSuccess` heuristic
        // (`result.output.length > 50 && !truncated && (maxIter||aborted)`)
        // tried to approximate at this layer. Reusing `result.success` here
        // makes the tool_result's `success` flag and the digest's
        // `forkIncomplete` directive (`!result.success`) perfectly dual — they
        // can no longer disagree ("success:true yet 'did not finish cleanly'").
        const isSuccess = result.success

        // Verification closed loop — when a foreground Verification
        // sub-agent finishes, parse its terminal `VERDICT: PASS|FAIL|PARTIAL`
        // and record it against the PARENT (main) conversation. A PASS/PARTIAL
        // clears the `verification_gate`; a FAIL keeps it pending with the
        // report excerpt so the gate can quote what broke. Background
        // verification is not captured here (it returns immediately with
        // status=running); foreground is the Verification agent's default.
        if (agentDefForRun.agentType === 'Verification') {
          const parentConv =
            typeof parentCtx.streamConversationId === 'string'
              ? parentCtx.streamConversationId.trim()
              : undefined
          if (parentConv && typeof result.output === 'string') {
            const verdict = parseVerdict(result.output)
            if (verdict) {
              try {
                recordVerificationVerdict(parentConv, verdict, result.output)
              } catch (e) {
                console.warn('[agentTool] recordVerificationVerdict threw:', e)
              }
            }
          }
        }

        const taskOutputTaskId = getToolUseIdFromStopScope()?.trim()
        const payload =
          taskOutputTaskId && taskOutputTaskId.length > 0
            ? { ...result, taskOutputTaskId }
            : result

        // Sub-agent process digest — a short, human-readable preface that
        // tells the parent model what tools were used and which failed.
        // Without this, the parent only saw the final `output` and could not
        // judge whether a partial failure made the result unreliable, or
        // whether retrying with different args would help. The full
        // structured payload still follows for any consumer that wants it.
        const digest = formatSubAgentProcessDigest(result)
        const wrappedOutput = digest
          ? `${digest}\n\n---\n${JSON.stringify(payload)}`
          : JSON.stringify(payload)

        return {
          success: isSuccess,
          output: wrappedOutput,
          error: isSuccess ? undefined : `Agent ${agentDef.agentType} failed`,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        clearActiveAgentTimeout(fgActiveAgent)
        fgActiveAgent.status = 'failed'
        fgActiveAgent.endedAt = Date.now()
        fgActiveAgent.terminalError = message
        return { success: false, error: `Agent execution failed: ${message}` }
      } finally {
        // BUG-A4 fix: explicit unregister path for foreground agents.
        // 5s grace period mirrors the background success path so the UI
        // can show the terminal row briefly before it fades from the
        // active list. `unspawnAndUntrackAgent` drops BOTH the registry
        // entry AND the orchestrator edge (replacing the prior
        // `getUnifiedOrchestrator().unregisterAgent` + `unregisterActiveAgent`
        // pair).
        setTimeout(() => unspawnAndUntrackAgent(fgAgentId), 5000)
      }
    },
  })
}

// Re-export registry helpers for IPC / tests (preserved public surface).
export { registerActiveAgent, unregisterActiveAgent } from './activeAgentRegistry'

/**
 * Normalize Agent tool input **in place** so execute + validators see `description` / `prompt`.
 * Maps `task` → `prompt` when prompt is empty; derives `description` from the first line of `prompt` when missing.
 */
export function normalizeAgentToolInput(input: Record<string, unknown>): void {
  const taskRaw = input.task
  if (typeof taskRaw === 'string' && taskRaw.trim()) {
    const p = input.prompt
    if (typeof p !== 'string' || !p.trim()) {
      input.prompt = taskRaw.trim()
    }
  }

  const promptStr =
    typeof input.prompt === 'string'
      ? input.prompt
      : input.prompt === undefined || input.prompt === null
        ? ''
        : String(input.prompt)
  input.prompt = promptStr

  const descRaw = input.description
  const descStr = typeof descRaw === 'string' ? descRaw.trim() : ''
  if (!descStr) {
    const firstLine = promptStr.split(/\r?\n/)[0]?.trim() ?? ''
    input.description = firstLine
  } else {
    input.description = typeof descRaw === 'string' ? descRaw : String(descRaw)
  }

  if (typeof input.subagent_type !== 'string') {
    delete input.subagent_type
  }
  if (typeof input.model !== 'string') {
    delete input.model
  }
  if (typeof input.run_in_background !== 'boolean') {
    delete input.run_in_background
  }
  if (typeof input.name !== 'string') {
    delete input.name
  }
  if (typeof input.team_name !== 'string') {
    delete input.team_name
  }

  const th = input.thoroughness
  if (typeof th === 'string' && th.trim()) {
    const p = typeof input.prompt === 'string' ? input.prompt : ''
    input.prompt = `${p}\n\n[Thoroughness: ${th.trim()}]`
  }
  delete input.thoroughness
}
