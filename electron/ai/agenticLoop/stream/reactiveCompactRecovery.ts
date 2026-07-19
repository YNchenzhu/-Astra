/**
 * P2 — Reactive compact recovery (extracted from `stream.ts`).
 *
 * Triggered when the API returned `context_length_exceeded`
 * (`result.contextLengthExceeded === true`). Runs one compact pass via
 * `reactiveCompactAfterApiError`, then retries the stream once. Three
 * outcomes:
 *
 *   1. Compact + retry succeeded with usable result → `{ kind: 'ok' }`,
 *      caller continues with the updated `result`.
 *   2. Compact + retry STILL returned 413 → `{ kind: 'terminal' }` with
 *      `prompt_too_long` reason. The caller wraps the result with its
 *      StreamPhase-local mutable bag and returns to the iteration body.
 *   3. Compact ITSELF threw (non-abort) → `{ kind: 'terminal' }` with
 *      `model_error`. Aborts fall through to the post-stream abort
 *      guard so `aborted_streaming` wins over `model_error`.
 *
 * P1 audit fix (preserved): wipe partial pre-compact stream output
 * ONLY after compact succeeds. Pre-fix behaviour wiped them
 * unconditionally before the try block, which left them cleared while
 * `contextLengthExceeded` was still true on a compact throw — the
 * downstream branches then ran against a malformed `result` and the
 * iteration silently terminated as `'completed'` with empty output.
 *
 * upstream reference: `services/compact/reactiveCompact.ts` +
 * `query.ts` ~line 853-922 (the reactive compact retry block).
 */

import type { LoopState } from '../loopShared'
import { recordTransition } from '../loopShared'
import {
  getAgentContext,
} from '../../../agents/agentContext'
import { reactiveCompactAfterApiError } from '../../../context/reactiveCompact'
import { injectInvokedSkillsIntoLastUserMessage } from '../../../skills/invokedSkillsRegistry'
import { postCompactCleanup } from '../../../agents/postCompactCleanup'
import { buildCompactSideAttachmentIds } from '../../agenticLoopHelpers'
import { QUERY_PROFILER_LABELS } from '../../queryProfiler'
import { createTerminalResult, runTerminationCleanup } from '../../queryTermination'

interface MinimalStreamResult {
  contextLengthExceeded: boolean
  accumulatedText: string
  toolUseBlocks: Array<unknown>
  thinkingBlocks: Array<unknown>
  lastStreamEndMs: number
}

/**
 * Outcome union:
 *   - `ok` — compact succeeded (or wasn't triggered). Caller continues
 *     with the (possibly mutated) `result`.
 *   - `terminal` — compact failed past recovery; caller must terminate
 *     the stream phase. `kind` of failure is encoded in `reason`.
 *
 * `result` is always returned so the caller can weave it into the
 * StreamOutput shape (the StreamPhase-local mutable bag carries the
 * other fields like `streamMaxOutTokens`).
 */
export type ReactiveCompactRecoveryOutcome<R extends MinimalStreamResult> =
  | { kind: 'ok'; result: R }
  | { kind: 'terminal'; result: R; reason: 'prompt_too_long' | 'model_error' }

/**
 * Inspect `result.contextLengthExceeded` and run the recovery flow if
 * set. No-op (returns `{ kind: 'ok' }`) when there's nothing to do.
 *
 * Caller passes the `iterationModel` (used by `reactiveCompactAfterApiError`)
 * and the `runStreamWithRetry` closure (so this module doesn't import
 * the heavy stream pass machinery).
 */
export async function maybeRunReactiveCompactRecovery<R extends MinimalStreamResult>(
  state: LoopState,
  result: R,
  systemPrompt: string,
  iterationModel: string,
  runStreamWithRetry: () => Promise<R>,
): Promise<ReactiveCompactRecoveryOutcome<R>> {
  if (!result.contextLengthExceeded) {
    return { kind: 'ok', result }
  }

  const endReactiveCp = state.profiler.startCheckpoint(
    QUERY_PROFILER_LABELS.reactiveCompact,
  )
  // Turn-level attempt telemetry (audit §五.2) — there is no cross-iteration
  // "already attempted" latch by design, so expose how many LLM compact
  // passes this turn has burned for dashboards / appendix-A traces.
  state.reactiveCompactAttempts += 1
  state.appendixReport('P2_Q_context_length_reactive', {
    iteration: state.iteration,
    attempt: state.reactiveCompactAttempts,
  })

  try {
    state.loopContextManager.evaluate(
      state.apiMessages,
      systemPrompt,
      state.toolTokensForContext,
      iterationModel,
    )
    const estBefore = state.loopContextManager.getState().estimatedTokens
    const msgLen = state.apiMessages.length

    const { messages: compacted } = await reactiveCompactAfterApiError(
      state.apiMessages,
      systemPrompt,
      {
        config: state.config,
        model: iterationModel,
        systemPrompt,
        messages: state.apiMessages,
        signal: state.signal,
        collapseConversationKey: state.collapseConversationKey,
        permissionRules: state.permissionRules,
        ...(state.activeInlineSkillSession?.skillName
          ? { activeSkillName: state.activeInlineSkillSession.skillName }
          : {}),
        ...buildCompactSideAttachmentIds(),
      },
    )

    let apiMessages = compacted
    apiMessages = injectInvokedSkillsIntoLastUserMessage(
      apiMessages,
      getAgentContext()?.agentId,
    )

    state.loopContextManager.evaluate(
      apiMessages,
      systemPrompt,
      state.toolTokensForContext,
      iterationModel,
    )
    const estAfter = state.loopContextManager.getState().estimatedTokens
    const credit = Math.max(0, estBefore - estAfter)
    const cid = getAgentContext()?.streamConversationId?.trim() ?? 'na'

    postCompactCleanup('reactive', {
      dedupeKey: `${cid}|reactive|${msgLen}|${estBefore}`,
      outputBudgetCeilingExtension: credit > 0 ? credit : undefined,
    })

    state.apiMessages = apiMessages
    state.loopContextManager.clearUsageSnapshot()
    recordTransition(state, 'reactive_compact')
    if (state.callbacks.onContextCompact) {
      state.callbacks.onContextCompact({ level: 'reactive_compact' })
    }

    // P1 audit fix: wipe partial pre-compact stream output AFTER compact
    // succeeds, BEFORE the retry overwrites `result`. See file header
    // for the original incident this fixes.
    result.accumulatedText = ''
    result.toolUseBlocks.length = 0
    result.thinkingBlocks.length = 0

    // Retry after reactive compact.
    const retried = await runStreamWithRetry()

    if (retried.contextLengthExceeded) {
      state.callbacks.onError(
        'Prompt or context is still too large after compaction.',
      )
      state.callbacks.onMessageEnd(state.totalUsage)
      state.terminationResult = createTerminalResult('prompt_too_long', {
        turnCount: state.iteration,
        totalUsage: state.totalUsage,
        errorDetail: 'Context still too large after reactive compact',
      })
      await runTerminationCleanup(state.terminationResult)
      return { kind: 'terminal', result: retried, reason: 'prompt_too_long' }
    }

    return { kind: 'ok', result: retried }
  } catch (err) {
    // P1 audit fix: a `reactiveCompactAfterApiError` throw (or any
    // synchronous error in the surrounding setup) used to swallow into
    // a `console.warn` while the loop continued with `contextLengthExceeded`
    // still true and `result` partially mutated. Surface a typed
    // `model_error` termination so the iteration body short-circuits.
    // Aborts are handled separately — let them fall through to the
    // post-stream abort guard so `aborted_streaming` wins over
    // `model_error`.
    // Gap B fix (2026-06 silent-stop audit): ONLY a genuine user-signal
    // abort is benign here. The previous `|| err.name === 'AbortError'`
    // clause also swallowed a SPURIOUS AbortError whose source is NOT our
    // user signal (e.g. an inner fetch/timeout that rejects with
    // AbortError while `state.signal.aborted` is still false). That
    // mis-classification returned `kind:'ok'` with `contextLengthExceeded`
    // still true and partial output left in place, which downstream can
    // fall through to a `completed` termination with empty output — a true
    // silent stop. A real user cancel always flips `state.signal.aborted`
    // synchronously before the throw is observed here, so gating on the
    // signal alone is both correct and stricter.
    const aborted = state.signal.aborted
    if (!aborted) {
      const detail =
        err instanceof Error
          ? err.message
          : String(err ?? 'reactive compact failed')
      console.warn('[Agentic Loop] Reactive compact failed:', err)
      state.callbacks.onError(`Reactive compact failed: ${detail}`)
      state.callbacks.onMessageEnd(state.totalUsage)
      state.terminationResult = createTerminalResult('model_error', {
        turnCount: state.iteration,
        totalUsage: state.totalUsage,
        errorDetail: `reactive_compact_failed: ${detail}`,
      })
      await runTerminationCleanup(state.terminationResult)
      // Clear partial output before returning so the caller's final
      // StreamOutput is unambiguous (matches the legacy inline body).
      result.accumulatedText = ''
      result.toolUseBlocks.length = 0
      result.thinkingBlocks.length = 0
      return { kind: 'terminal', result, reason: 'model_error' }
    }
    console.warn('[Agentic Loop] Reactive compact aborted:', err)
    return { kind: 'ok', result }
  } finally {
    endReactiveCp()
  }
}
