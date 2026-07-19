/**
 * P0-3 — Layered context-recovery wrapper.
 *
 * Today's PTL/413 recovery (`maybeRunReactiveCompactRecovery`) does a single
 * combined step:
 *
 *   1. drain collapse store (free)
 *   2. clamp tool result sizes (free)
 *   3. micro-compact (free)
 *   4. autoCompact LLM summarization (1 LLM call)
 *   5. retry stream
 *
 * All four happen together before the single retry. If drain (step 1) alone
 * was enough to bring the request under the API's token cap, we still paid
 * for the LLM summarization in step 4.
 *
 * This module adds a CHEAPER first attempt:
 *
 *   Layer A (this module): drain-only — when the collapse store has
 *   queued summaries (typical for long-running sessions where preModel's
 *   `autoFoldOldestMessagesForContextCollapse` previously folded segments),
 *   consume them, prepend the recap to apiMessages, retry the stream. ZERO
 *   extra LLM calls.
 *
 *   Layer B (existing `maybeRunReactiveCompactRecovery`): falls through to
 *   the full clamp + micro-compact + LLM-summary path. Identical behaviour
 *   to today.
 *
 * Failure mode this prevents:
 *   - Long-running session has accumulated ~3 drain summaries in the
 *     collapse store via auto-fold.
 *   - Stream returns PTL.
 *   - Today: full reactiveCompactAfterApiError fires → 1 LLM call → retry.
 *     Even if drain alone would've sufficed, the LLM summary cost is paid.
 *   - With this layer: drain → retry. If retry succeeds, we save the LLM
 *     call entirely.
 *
 * Safety:
 *   - This layer is a strict superset of "do nothing" — when the collapse
 *     store is empty (fresh sessions, never-folded sessions) we no-op and
 *     the caller falls through to the existing recovery path.
 *   - We mutate `state.apiMessages` only when the drain actually produced
 *     content (`drainContextCollapseForReactiveCompact` returns the original
 *     reference when summaries are empty).
 *   - Aborts during the layer fall through transparently to the post-stream
 *     abort guard, same as today.
 *
 * Telemetry: emits `P2_Q_context_length_drain_only_recovery` AppendixA stage
 * id with `{ recovered: boolean }` so dashboards can measure how often the
 * cheaper layer actually succeeds. Operators can decide based on real data
 * whether to extend with finer layers (clamp-only, microCompact-only).
 */

import type { LoopState } from '../loopShared'
import { recordTransition } from '../loopShared'
import {
  consumeContextCollapseSummaries,
  hasContextCollapseSummaries,
} from '../../../context/contextCollapseStore'
import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../../../constants/sideChannelKinds'
import { QUERY_PROFILER_LABELS } from '../../queryProfiler'

interface MinimalStreamResult {
  contextLengthExceeded: boolean
  accumulatedText: string
  toolUseBlocks: Array<unknown>
  thinkingBlocks: Array<unknown>
  lastStreamEndMs: number
}

/**
 * Outcome union:
 *   - `recovered` — drain + retry succeeded, caller continues with the
 *     fresh stream result. `apiMessages` already mutated; partial pre-drain
 *     output cleared.
 *   - `fall_through` — drain didn't help (still PTL) OR drain wasn't
 *     applicable (no summaries in store). Caller MUST proceed to the next
 *     recovery layer (reactive compact). The result returned is either the
 *     unchanged input or the post-retry result.
 *   - `aborted` — abort signal fired during the layer; caller falls through
 *     to the post-stream abort guard.
 */
export type DrainOnlyRecoveryOutcome<R extends MinimalStreamResult> =
  | { kind: 'recovered'; result: R }
  | { kind: 'fall_through'; result: R }
  | { kind: 'aborted'; result: R }

/**
 * Attempt a drain-only recovery from a PTL/contextLengthExceeded stream
 * result. No-op when:
 *   - `result.contextLengthExceeded` is false (nothing to recover from);
 *   - `state.collapseConversationKey` is empty (no key to consult the
 *     collapse store with);
 *   - the collapse store has no queued summaries for the conversation key
 *     (drain would be a no-op anyway);
 *   - the abort signal has already fired (fall straight through).
 */
export async function tryDrainOnlyContextRecovery<R extends MinimalStreamResult>(
  state: LoopState,
  result: R,
  runStreamWithRetry: () => Promise<R>,
): Promise<DrainOnlyRecoveryOutcome<R>> {
  if (!result.contextLengthExceeded) {
    return { kind: 'fall_through', result }
  }
  if (state.signal.aborted) {
    return { kind: 'aborted', result }
  }
  const key = state.collapseConversationKey?.trim()
  if (!key) {
    return { kind: 'fall_through', result }
  }
  // Peek first so we don't burn the queue when we'd be a no-op. The
  // alternative — call consume() unconditionally — would silently empty
  // the store on every PTL even when the recovery doesn't run, which
  // would defeat the entire point of having queued summaries.
  if (!hasContextCollapseSummaries(key)) {
    return { kind: 'fall_through', result }
  }

  const endCp = state.profiler.startCheckpoint(QUERY_PROFILER_LABELS.reactiveCompact)
  try {
    const summaries = consumeContextCollapseSummaries(key)
    if (summaries.length === 0) {
      // Race with another consumer (extremely rare); fall through.
      return { kind: 'fall_through', result }
    }
    // Build the synthetic user message exactly the way
    // `drainContextCollapseForReactiveCompact` builds it so the wire format
    // matches the existing recovery path. Inline here (rather than calling
    // the existing helper) because the helper consumes the queue itself
    // and we've already drained.
    const body = summaries
      .map((s, i) => `### Collapsed segment ${i + 1}\n${s}`)
      .join('\n\n')
    const injected = {
      role: 'user' as const,
      content: wrapSideChannelBody(
        SIDE_CHANNEL_KIND.contextCollapseDrain,
        `[Context collapse summaries — prior segments folded offline. Treat as authoritative recap of earlier conversation; do NOT respond as if the user just narrated this.]\n\n${body}`,
      ),
      _convertedFromSystem: true,
      _sideChannelKind: SIDE_CHANNEL_KIND.contextCollapseDrain,
    }
    state.apiMessages = [
      injected as unknown as (typeof state.apiMessages)[number],
      ...state.apiMessages,
    ]
    state.loopContextManager.clearUsageSnapshot()
    // Audit Bug-5 fix — use the dedicated 'collapse_drain' transition so
    // telemetry can distinguish the free drain layer from the full
    // reactive_compact layer (which costs an extra LLM call). See
    // loopEvents.ts KNOWN_LOOP_TRANSITIONS.
    recordTransition(state, 'collapse_drain')
    state.appendixReport('P2_Q_context_length_drain_only_recovery', {
      iteration: state.iteration,
      summaries: summaries.length,
    })
    if (state.callbacks.onContextCompact) {
      try {
        // 'collapse_drain' level matches the transition tag so any renderer
        // that branches on `level` sees the same classification.
        state.callbacks.onContextCompact({ level: 'collapse_drain' })
      } catch (e) {
        console.warn('[Agentic Loop] onContextCompact (drain-only) threw:', e)
      }
    }

    // Wipe partial pre-drain stream output, mirroring the order
    // `maybeRunReactiveCompactRecovery` uses: clear AFTER the recovery
    // mutation is committed, BEFORE the retry overwrites `result`.
    result.accumulatedText = ''
    result.toolUseBlocks.length = 0
    result.thinkingBlocks.length = 0

    const retried = await runStreamWithRetry()

    if (state.signal.aborted) {
      // Aborts win over recovery outcomes — let the post-stream guard
      // surface the abort.
      return { kind: 'aborted', result: retried }
    }
    if (retried.contextLengthExceeded) {
      // Drain wasn't enough; caller must proceed to full reactive compact.
      state.appendixReport('P2_Q_context_length_drain_only_recovery', {
        iteration: state.iteration,
        summaries: summaries.length,
        recovered: false,
      })
      return { kind: 'fall_through', result: retried }
    }
    state.appendixReport('P2_Q_context_length_drain_only_recovery', {
      iteration: state.iteration,
      summaries: summaries.length,
      recovered: true,
    })
    return { kind: 'recovered', result: retried }
  } finally {
    endCp()
  }
}
