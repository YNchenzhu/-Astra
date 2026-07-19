/**
 * P2 — Image strip-retry recovery (extracted from `stream.ts`).
 *
 * upstream §10.5 Layer 5: when the withheld signal classifies as
 * `stream:image_too_large` AND the stream produced no content, retry
 * once with image blocks physically removed from the transcript. Pole's
 * reactive-compact-free analog to upstream's image-error reactive-compact
 * strip pattern — we strip rather than compact because the failure is
 * about payload shape (the API rejected a too-large image) not size.
 *
 * Single-shot: if the second attempt fails, we let the withheld signal
 * promote to a typed `image_error` termination via
 * `withheldSignalPromotion`. The retry overwrites `result`, so a
 * successful strip-retry naturally satisfies the `producedSomething`
 * check in the promotion block.
 *
 * Phase 3 (upstream alignment): kind comparison replaces the
 * `isWithheldMediaSizeError(string)` regex. Providers populate
 * `withheldStreamSignal` at the catch boundary via `onLoopSignal`, so
 * by the time we get here the classification is already typed.
 *
 * Contract: caller passes the runStreamWithRetry closure as a
 * dependency so this module doesn't import the heavy stream machinery.
 * The streamResult shape is opaque (the caller knows the concrete type).
 */

import type { LoopState } from '../loopShared'
import { recordTransition } from '../loopShared'
import { stripImageBlocks } from '../../../context/stripImageBlocks'
import { QUERY_PROFILER_LABELS } from '../../queryProfiler'

/**
 * Generic "produced something / nothing" check on a stream-pass result.
 * Kept narrow so this module doesn't depend on the runStreamPhase-local
 * result type definition.
 */
interface MinimalStreamResult {
  accumulatedText: string
  toolUseBlocks: ReadonlyArray<unknown>
  thinkingBlocks: ReadonlyArray<unknown>
}

/**
 * Run the image strip-retry if the trigger conditions are met.
 *
 * Returns:
 *   - the original `result` unchanged when the trigger conditions are
 *     not met or no images were actually present to strip;
 *   - the updated `result` from a successful retry when stripping
 *     happened and a fresh stream pass returned new content / error.
 */
export async function maybeRunImageStripRetry<R extends MinimalStreamResult>(
  state: LoopState,
  result: R,
  runStreamWithRetry: () => Promise<R>,
): Promise<R> {
  if (
    state.withheldStreamSignal?.kind !== 'stream:image_too_large' ||
    state.signal.aborted ||
    result.accumulatedText.trim().length > 0 ||
    result.toolUseBlocks.length > 0 ||
    result.thinkingBlocks.length > 0
  ) {
    return result
  }

  const endStripCp = state.profiler.startCheckpoint(
    QUERY_PROFILER_LABELS.reactiveCompact,
  )
  try {
    const { messages: strippedMessages, strippedCount } = stripImageBlocks(
      state.apiMessages,
    )
    state.appendixReport('P2_Q_strip_retry_image', {
      iteration: state.iteration,
      strippedCount,
    })
    if (strippedCount > 0) {
      state.apiMessages = strippedMessages
      state.loopContextManager.clearUsageSnapshot()
      recordTransition(state, 'strip_retry')
      if (state.callbacks.onContextCompact) {
        state.callbacks.onContextCompact({ level: 'stripped_image' })
      }
      // Reset withholding (both string carrier AND typed signal)
      // before retry so a clean failure (or success) post-retry is
      // observed by the promotion block. If the retry *also* fails,
      // `runStreamWithRetry` re-populates both slots.
      state.withheldStreamError = null
      state.withheldStreamSignal = null
      return await runStreamWithRetry()
    }
    // strippedCount === 0: the signal classified as image_too_large
    // but no image blocks were actually present in apiMessages —
    // fall through to standard promotion (the signal becomes a typed
    // `image_error` termination there).
    return result
  } finally {
    endStripCp()
  }
}
