/**
 * Single tool_use execution inside the agentic loop (permissions, hooks, registry, side effects).
 * Extracted so the loop can batch parallel read-only tools safely.
 *
 * Public API surface — implementation lives in `runAgenticToolUseBody.ts`.
 */

import { getAgentContext } from '../agents/agentContext'
import {
  registerToolStopController,
  releaseToolStopController,
} from './toolStopRegistry'
import {
  mergeAbortSignals,
  runWithToolStopScope,
} from './toolExecutionScope'
import {
  buildPausedToolResultBlock,
  isInterruptForHITL,
  recordPendingHITL,
} from '../orchestration/hitl'
import type { PermissionRulePayload } from './permissionRuleMatch'
import { runAgenticToolUseScoped } from './runAgenticToolUseBody'
import { applyToolMiddleware } from '../orchestration/toolMiddleware'
import { recordToolEffectiveInput } from '../orchestration/toolRuntime/state'
import { asAgentId } from '../tools/ids'

/**
 * Shared shape for `tool_result` events crossing every IPC and worker
 * boundary in the agent stack. Defined here (next to `AgenticToolCallbacks`
 * which is the canonical source-of-truth callback) so every duplicate
 * inline `{ id, name, success, output?, error?, ... }` literal in the
 * subagent / teammate / skill-fork / streaming paths can import this
 * single type instead of drifting in lockstep.
 *
 * The `error*` fields are populated by `buildToolFailure(...)` at the
 * tool layer; legacy tools that still emit only `error` leave them
 * undefined and the renderer falls back to the plain string view.
 */
export interface ToolResultEventPayload {
  id: string
  name: string
  success: boolean
  output?: string
  error?: string
  /** Tool-self-declared or heuristically classified error bucket. */
  toolErrorClass?: string
  /** Single-line failure headline (mirrors `ToolErrorInput.what`). */
  errorWhat?: string
  /** Attempted inputs / paths (mirrors `ToolErrorInput.tried`). */
  errorTried?: string[]
  /** Lookup hints (mirrors `ToolErrorInput.context`). */
  errorContext?: Record<string, string | number | null | undefined>
  /** Recovery hints, normalised to an array (mirrors `ToolErrorInput.next`). */
  errorNext?: string[]
}

type AgenticToolCallbacks = {
  onToolStart: (toolUse: { id: string; name: string; input: Record<string, unknown> }) => void
  onToolResult: (toolResult: ToolResultEventPayload) => void
}

export type InlineSkillSessionState = {
  skillName?: string
  allowedTools?: string[]
  model?: string
  effort?: import('../skills/skillEffort').SkillEffort
} | null

export type RunAgenticToolUseParams = {
  toolUse: {
    id: string
    name: string
    input: Record<string, unknown>
    thoughtSignature?: string
    /**
     * Stream-time pre-baked rejection from the C-grade watcher's synthetic
     * tool_use (see `streamWriteInputWatcher.ts`). When present, the body
     * surfaces it directly instead of Zod-validating the intentionally
     * partial/empty `input` — mirrors `streamingToolExecutor.addTool`.
     */
    preflightError?: string
  }
  signal: AbortSignal
  callbacks: AgenticToolCallbacks
  diffPermissionMode: 'default' | 'bypassPermissions'
  permissionDefaultMode: 'allow' | 'ask' | 'deny'
  /** Settings → Permissions: per-tool overrides (first match wins). */
  permissionRules?: PermissionRulePayload[]
  discoveryExclude: Set<string>
  getInlineSkillSession: () => InlineSkillSessionState
  setInlineSkillSession: (s: InlineSkillSessionState) => void
}

export async function runAgenticToolUse(
  params: RunAgenticToolUseParams,
): Promise<Record<string, unknown>> {
  const {
    toolUse,
    signal,
    callbacks,
    diffPermissionMode,
    permissionDefaultMode,
    permissionRules,
    discoveryExclude,
    getInlineSkillSession,
    setInlineSkillSession,
  } = params

  const toolStop = new AbortController()
  registerToolStopController(toolUse.id, toolStop)
  const effectiveSignal = mergeAbortSignals(signal, toolStop.signal)

  // ToolRuntimeState tracking now happens at the batch layer for all three
  // paths: `DefaultToolRuntimePort.executeToolBatch` (orchestrated),
  // `executeFallbackBatchWithWiring` (fallback), and `StreamingToolExecutor`
  // (streaming) each register / mark running / mark terminal around this call,
  // so every tool contributes to global runtime visibility.

  try {
    // P1 (audit §3.1 wire-up) — every per-tool execution now flows through
    // the tool-middleware chain in `electron/orchestration/toolMiddleware.ts`.
    // When no middleware is registered the chain is a single-pass passthrough
    // (zero cost). Registered middleware can transform `toolInput`, cache /
    // memoize / approve / log per-tool calls — see `toolMiddleware.ts` for
    // the contract.
    //
    // The middleware's `next(effectiveInput?)` replaces the original input
    // when called with an argument. We thread the substituted input into
    // `runAgenticToolUseScoped` so a middleware can e.g. inject a workspace
    // context header, normalise a path, or rewrite a bash command — all
    // without touching the tool implementations themselves.
    const agentCtx = getAgentContext()
    const middlewareCtx = {
      toolName: toolUse.name,
      toolInput: toolUse.input,
      toolUseId: toolUse.id,
      agentId: asAgentId(agentCtx?.agentId ?? 'main'),
      ...(agentCtx?.sessionAgentType ? { agentType: agentCtx.sessionAgentType } : {}),
      ...(agentCtx?.streamConversationId?.trim()
        ? { conversationId: agentCtx.streamConversationId.trim() }
        : {}),
    }
    const result = await runWithToolStopScope(toolUse.id, toolStop, () =>
      applyToolMiddleware(middlewareCtx, (effectiveInput) => {
        // Audit A-6 wire-up — register the substituted input in
        // ToolRuntimeState so `DefaultToolRuntimePort` 's
        // `history.record` fingerprints the actually-executed input
        // (not the pre-substitution one). When middleware doesn't
        // substitute, `effectiveInput === toolUse.input` (the same
        // reference) so the call is effectively a no-op store; the
        // fingerprint result is identical either way. This keeps
        // cross-agent repeat-failure detection aligned with what
        // really ran.
        try {
          recordToolEffectiveInput(toolUse.id, effectiveInput)
        } catch (e) {
          // Telemetry must never break the tool call.
          console.warn('[runAgenticToolUse] recordToolEffectiveInput failed:', e)
        }
        return runAgenticToolUseScoped({
          ...params,
          signal: effectiveSignal,
          // Forward the middleware-substituted input to the actual tool
          // (identical to the original when no middleware overrode it).
          toolUse: { ...toolUse, input: effectiveInput },
          callbacks,
          diffPermissionMode,
          permissionDefaultMode,
          permissionRules,
          discoveryExclude,
          getInlineSkillSession,
          setInlineSkillSession,
        })
      }),
    )
    return result
  } catch (err) {
    // Durable HITL: a tool (today: AskUserQuestion; tomorrow: permission "ask"
    // wrapper) signals "pause the loop and persist state" by throwing
    // `InterruptForHITL`. We do NOT propagate this as a tool-error because:
    //   1. Anthropic requires every tool_use block to be paired with a tool_result in the
    //      next user message — a bare throw leaves the assistant message dangling.
    //   2. The model would otherwise see "AskUserQuestion errored" and may retry, which is
    //      exactly the bug we're trying to fix.
    // Instead: synthesise a paused placeholder tool_result, record the interrupt in the
    // module-level registry, and let the batch complete normally. `toolExec.ts` checks
    // the registry after the batch and triggers the kernel-level pause flow.
    if (isInterruptForHITL(err)) {
      const conversationId = getAgentContext()?.streamConversationId
      // P1 audit fix: derive `kind` from the question payload instead of
      // hardcoding 'ask_user_question'. The deep permission gate in
      // `runAgenticToolUseBody.ts` throws with `question = { kind:
      // 'permission_ask', … }`, but the previous hardcode marked it as
      // an AskUserQuestion. Downstream `toolExec.ts` then keyed off the
      // tag to decide which UI to surface (the auxiliary
      // `ask_user_question` stream event is intentionally skipped for
      // `permission_ask` because that path has its own permission UI),
      // so a permission ask was incorrectly forwarded to the
      // AskUserQuestion dialog with a payload of the wrong shape.
      // Default to 'ask_user_question' for legacy / unknown shapes
      // (notably `AskUserQuestionTool` which throws with a bare
      // `{ questions, metadata }` and no kind tag — the historical
      // default is correct there).
      const questionKind = (
        err.question &&
        typeof err.question === 'object' &&
        (err.question as { kind?: unknown }).kind === 'permission_ask'
      )
        ? 'permission_ask'
        : 'ask_user_question'
      recordPendingHITL(conversationId, {
        toolUseId: err.toolUseId,
        question: err.question,
        kind: questionKind,
        recordedAt: Date.now(),
      })
      return buildPausedToolResultBlock(toolUse.id)
    }
    throw err
  } finally {
    releaseToolStopController(toolUse.id)
  }
}
