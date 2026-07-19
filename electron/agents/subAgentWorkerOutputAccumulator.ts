/**
 * Worker-path sub-agent output accumulator.
 *
 * Extracted from the inline `outputText` / `lastFinalText` /
 * `iterationStartOutputLen` / `toolsThisTurn` locals in
 * `subAgentWorkerClient.ts` so the text-accumulation state machine is
 * unit-testable and stays in lockstep with the in-process path
 * (`subAgentRunner.ts` — `onTextDelta` / `onMessageEnd` /
 * `onStreamingFallback`).
 *
 * Audit 2026-06 (worker streaming-fallback rollback): the worker client
 * previously had NO handler for the `streaming_fallback` LoopEvent, so a
 * mid-stream provider failure (Anthropic 529 → non-streaming retry)
 * left the abandoned partial deltas in `outputText`. The retry then
 * replayed the full response on top, and any run without a tool-free
 * final turn returned "half old + full new" duplicate text to the
 * parent agent. The in-process path already rolled this back via
 * `onStreamingFallback` (subAgentRunner.ts ~L1577); {@link onStreamingFallback}
 * is the worker-side equivalent.
 *
 * Semantics mirror the in-process runner exactly:
 *   - `onTextDelta`        — append to the run-wide buffer.
 *   - `onToolStart`        — count a tool call in the current turn.
 *   - `onMessageEnd`       — when the turn had zero tool calls, the text
 *                            emitted since the turn started is the
 *                            candidate final report (`lastFinalText`).
 *                            Resets the per-turn window either way.
 *   - `onStreamingFallback`— discard text emitted since the turn started
 *                            (the partial stream the provider abandoned);
 *                            the non-streaming retry re-emits the full
 *                            response into the same window.
 */
export class WorkerOutputAccumulator {
  private buffer = ''
  private finalText = ''
  private turnStartLen = 0
  private turnToolCount = 0

  onTextDelta(text: string): void {
    if (text) this.buffer += text
  }

  onToolStart(): void {
    this.turnToolCount++
  }

  /**
   * Close the current turn. Returns the turn's tool count and the
   * tool-free final text (empty string when the turn used tools or
   * produced no text) so the caller can run budget checks against the
   * pre-reset values.
   */
  onMessageEnd(): { finalText: string; toolsThisTurn: number } {
    const toolsThisTurn = this.turnToolCount
    const finalText =
      toolsThisTurn === 0 ? this.buffer.slice(this.turnStartLen).trim() : ''
    if (finalText) this.finalText = finalText
    this.turnStartLen = this.buffer.length
    this.turnToolCount = 0
    return { finalText, toolsThisTurn }
  }

  /**
   * Roll the buffer back to the start of the current turn, discarding
   * the partial deltas of an abandoned stream. Returns the number of
   * characters dropped (0 when nothing was buffered this turn).
   */
  onStreamingFallback(): number {
    const dropped = this.buffer.length - this.turnStartLen
    if (dropped <= 0) return 0
    this.buffer = this.buffer.slice(0, this.turnStartLen)
    return dropped
  }

  /** Full accumulated text across every turn (post-rollback view). */
  get outputText(): string {
    return this.buffer
  }

  /** Most recent tool-free final turn's text ('' when none captured). */
  get lastFinalText(): string {
    return this.finalText
  }

  /**
   * Promote a host-side final-summary rescue's text to `lastFinalText` so the
   * shared output resolver's top-priority tier picks it up — identical to the
   * in-process path's `ctx.lastFinalText = rescueResult.text` (subAgentRunner).
   * Used by the worker client when a budget-aborted / max-iterations run had no
   * clean tool-free final turn and the rescue produced the report instead.
   */
  setRescueFinalText(text: string): void {
    const t = text.trim()
    if (t) this.finalText = t
  }

  /** Tool calls observed in the current (unclosed) turn. */
  get toolsThisTurn(): number {
    return this.turnToolCount
  }
}
