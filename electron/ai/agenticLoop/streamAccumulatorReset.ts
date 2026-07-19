/**
 * `onStreamingFallback` accumulator-reset contract.
 *
 * When the streaming attempt is abandoned mid-flight (most commonly an
 * Anthropic HTTP 529 → non-streaming `messages.create` retry, see
 * `electron/ai/providers/anthropic.ts`), every per-stream content
 * accumulator MUST be cleared before the fallback's emissions land. The
 * fallback path replays the *new* response's blocks in full via fresh
 * `onTextDelta` / `onThinkingBlock` / `onToolUse` / etc. — if the failed
 * attempt's partial blocks remain in the same locals, they'll be merged
 * twice and the final `thinkingBlocks` / `toolUseBlocks` payloads sent
 * upstream will be corrupted.
 *
 * Why this matters NOW: Step 3 of the thinking-block accumulator work
 * (`electron/ai/thinkingBlockAccumulator.ts`) moved SDK-path thinking
 * emissions OUT of the `finalMessage()` walk and INTO per-`content_block_stop`
 * dispatch. The historical SDK behaviour was "no `onThinkingBlock`
 * during streaming, only at `finalMessage()` resolution" — so partial
 * thinking blocks could never land in `localThinking` before a 529
 * threw on `finalMessage()`. The new behaviour can deliver several
 * `onThinkingBlock` calls *before* the 529 occurs. Without resetting
 * `localThinking`, those partial blocks would double-count against the
 * fallback's fresh emissions. This helper makes that contract explicit
 * and testable rather than living as five inline `length = 0` lines.
 */

/**
 * Mutable arrays owned by `runStreamPhase`'s `streamPass` closure that
 * accumulate parsed wire content as the stream progresses. Cleared as a
 * group on `onStreamingFallback` so the non-streaming retry's emissions
 * rebuild clean state.
 *
 * Note: `accumulatedText` (a string primitive) is reset separately at the
 * callsite — primitives can't share the "truncate via .length = 0"
 * pattern. The handler in `stream.ts` does `accText = ''` immediately
 * before calling this helper.
 */
export interface StreamAccumulatorRefs {
  toolUses: unknown[]
  serverToolUses: unknown[]
  codeExecResults: unknown[]
  thinking: unknown[]
}

/**
 * Truncate every accumulator in place. The references are preserved so
 * any closure that captured them (i.e. the `runStreamPass` callbacks
 * registered with the provider) continues to see the now-empty array
 * and resumes pushing onto it.
 */
export function resetStreamAccumulators(refs: StreamAccumulatorRefs): void {
  refs.toolUses.length = 0
  refs.serverToolUses.length = 0
  refs.codeExecResults.length = 0
  refs.thinking.length = 0
}
