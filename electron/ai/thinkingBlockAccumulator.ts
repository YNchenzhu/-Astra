/**
 * Per-content-block `type:'thinking'` stream accumulator.
 *
 * Shared by:
 *   - `anthropicCompatHttp.ts` — raw SSE consumer for Anthropic-compat
 *     gateways (DeepSeek / packycode / Zhipu / etc.)
 *   - `providers/anthropic.ts` — official `@anthropic-ai/sdk` MessageStream,
 *     subscribed via the `'streamEvent'` channel.
 *
 * Why a shared helper: the SDK previously exposed thinking deltas through
 * its higher-level `'thinking'` event which collapsed all blocks into a
 * single text stream and drove `onThinkingBlock` only at `finalMessage()`
 * resolution. That meant `[thinking-A, text, thinking-B]` ended with both
 * complete events firing in a single tick AFTER all deltas — and the
 * renderer's "walk backwards to find the most recent thinking block"
 * targeting heuristic (see `src/stores/chat/mainStreamRouter.ts`) then
 * stamped both complete events onto the same trailing block. By routing
 * the SDK through the same per-index accumulator as the HTTP-compat path,
 * `onThinkingBlock` fires at the wire-level `content_block_stop` — before
 * the next block opens — so the renderer's targeting stays unambiguous.
 *
 * Semantics preserved verbatim from the previous inline implementation in
 * `anthropicCompatHttp.ts`:
 *
 *   - `content_block_start` with `type:'thinking'` seeds an accumulator
 *     at the given `index`. The block may already carry initial `thinking`
 *     text + `signature` (some gateways inline the whole block here when
 *     no deltas follow); we capture those so a later `content_block_stop`
 *     still flushes a populated block.
 *   - `content_block_delta` with `thinking_delta` appends to the
 *     accumulator at `index`, lazily creating it if `content_block_start`
 *     was skipped by the gateway. Fires `onThinkingStart` on the very
 *     first thinking_delta of the stream (or after each previous
 *     `onThinkingComplete` boundary).
 *   - `content_block_delta` with `signature_delta` appends to the
 *     accumulator's `signature` (append rather than overwrite — defensive
 *     against future API versions that split the signature across
 *     multiple deltas; Anthropic currently sends one).
 *   - `content_block_stop` flushes the matching accumulator via
 *     `onThinkingBlock` (only if the block has non-empty thinking text;
 *     empty blocks aren't echoed because the wire would reject them on
 *     replay). Also fires `onThinkingComplete` IF thinking was active —
 *     the trailing-edge bracket marker some consumers depend on
 *     (see `compatibleClient.ts`'s tool-boundary path).
 *   - `flushAll()` is the EOS safety net: some gateways close the
 *     connection without emitting `content_block_stop`. The streaming
 *     callsite should invoke this in its `finally`/post-loop branch.
 */

import type { StreamCallbacks } from './client'
import { estimateTextTokens } from '../context/tokenCounter'

interface ThinkingBlockAccumulator {
  thinking: string
  signature?: string
  startedAtMs: number
}

/**
 * Approximate token count for the canonical thinking-block payload.
 *
 * Delegates to the shared {@link estimateTextTokens} so the CJK-aware
 * weighting (Han/kana/Hangul counted denser than the ASCII /4 divisor)
 * applies here too — a Chinese reasoning chain was previously displayed at
 * ~1/4 of its real token cost. Real tokenizers are still deliberately
 * avoided (vendor BPEs would bloat the bundle for a cosmetic display field).
 */
function estimateThinkingTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.max(1, estimateTextTokens(text))
}

/**
 * Structural subset of the Anthropic SSE wire event shape that this
 * accumulator consumes. Both wire-level paths satisfy it:
 *
 *   - Raw SSE frames (`anthropicCompatHttp.ts` parses
 *     `event:` / `data:` lines into this shape).
 *   - SDK `MessageStream.on('streamEvent', ev)` payloads from
 *     `@anthropic-ai/sdk` (already in this shape).
 *
 * Fields not relevant to thinking (`text_delta`, `input_json_delta`,
 * `tool_use` content blocks, etc.) are intentionally untyped — the
 * accumulator's `handle()` ignores any event it doesn't recognise.
 */
export interface ThinkingStreamEvent {
  type?: string
  index?: number
  content_block?: { type?: string; thinking?: string; signature?: string }
  delta?: { type?: string; thinking?: string; signature?: string }
}

export type ThinkingStreamCallbacks = Pick<
  StreamCallbacks,
  'onThinkingDelta' | 'onThinkingStart' | 'onThinkingComplete' | 'onThinkingBlock'
>

export interface ThinkingStreamAccumulator {
  /**
   * Feed a single stream event. Safe to call for every event from the
   * source — non-thinking events are silently skipped (except
   * `content_block_stop`, which is used as the boundary marker for
   * `onThinkingComplete`).
   */
  handle: (event: ThinkingStreamEvent) => void
  /**
   * Flush any thinking blocks that never received a `content_block_stop`.
   * Should be called in the streaming consumer's EOS branch (after the
   * stream loop exits, in a `finally` if practical).
   */
  flushAll: () => void
}

/**
 * EventEmitter-like surface this helper subscribes to. Matches both the
 * `@anthropic-ai/sdk` `MessageStream` shape (which exposes `.on('streamEvent', ...)`)
 * and any test-only fake EventEmitter we want to drive in unit tests.
 *
 * The `event` parameter is `unknown` because the SDK types it loosely as
 * `Record<string, unknown> | null | undefined`; the accumulator's `handle`
 * already defends against malformed payloads by checking `event.type` etc.
 */
export interface ThinkingSdkStreamLike {
  on: (event: 'streamEvent', listener: (event: unknown) => void) => void
}

/**
 * Wire an SDK MessageStream's `streamEvent` channel into a fresh per-index
 * thinking accumulator. Single source of truth for the SDK-path wiring;
 * tested against a fake EventEmitter so the contract "the SDK MUST surface
 * `content_block_start/delta/stop` for thinking blocks via streamEvent"
 * is explicit and exercisable.
 *
 * Caller is still responsible for invoking `flushAll()` after the stream
 * resolves (`finalMessage()` returns or EOS arrives) so any block that
 * never received `content_block_stop` still flushes.
 *
 * @returns the accumulator instance (so callers can call `flushAll()` later).
 */
export function attachThinkingAccumulatorToSdkStream(
  stream: ThinkingSdkStreamLike,
  callbacks: ThinkingStreamCallbacks,
): ThinkingStreamAccumulator {
  const acc = createThinkingStreamAccumulator(callbacks)
  stream.on('streamEvent', (event) => {
    if (!event || typeof event !== 'object') return
    acc.handle(event as ThinkingStreamEvent)
  })
  return acc
}

export function createThinkingStreamAccumulator(
  callbacks: ThinkingStreamCallbacks,
): ThinkingStreamAccumulator {
  const accumulators = new Map<number, ThinkingBlockAccumulator>()
  let thinkingActive = false

  const emitBlock = (acc: ThinkingBlockAccumulator): void => {
    if (acc.thinking.length === 0) return
    if (!callbacks.onThinkingBlock) return
    callbacks.onThinkingBlock({
      thinking: acc.thinking,
      ...(acc.signature ? { signature: acc.signature } : {}),
      thinkingTimeMs: Math.max(0, Date.now() - acc.startedAtMs),
      thinkingTokens: estimateThinkingTokens(acc.thinking),
    })
  }

  const ensure = (index: number): ThinkingBlockAccumulator => {
    const existing = accumulators.get(index)
    if (existing) return existing
    const fresh: ThinkingBlockAccumulator = { thinking: '', startedAtMs: Date.now() }
    accumulators.set(index, fresh)
    return fresh
  }

  const handle = (event: ThinkingStreamEvent): void => {
    const type = event.type
    if (type === 'content_block_start') {
      const idx = event.index
      const block = event.content_block
      if (typeof idx !== 'number' || !block || block.type !== 'thinking') return
      const initialThinking = typeof block.thinking === 'string' ? block.thinking : ''
      const initialSignature =
        typeof block.signature === 'string' && block.signature.length > 0
          ? block.signature
          : undefined
      accumulators.set(idx, {
        thinking: initialThinking,
        ...(initialSignature ? { signature: initialSignature } : {}),
        startedAtMs: Date.now(),
      })
      return
    }
    if (type === 'content_block_delta') {
      const idx = event.index
      const delta = event.delta
      if (typeof idx !== 'number' || !delta) return
      const dType = delta.type
      if (dType === 'thinking_delta' && typeof delta.thinking === 'string') {
        if (!thinkingActive) {
          thinkingActive = true
          callbacks.onThinkingStart?.()
        }
        callbacks.onThinkingDelta?.(delta.thinking)
        ensure(idx).thinking += delta.thinking
      } else if (dType === 'signature_delta' && typeof delta.signature === 'string') {
        const acc = ensure(idx)
        acc.signature = (acc.signature ?? '') + delta.signature
      }
      return
    }
    if (type === 'content_block_stop') {
      const idx = event.index
      if (typeof idx === 'number') {
        const acc = accumulators.get(idx)
        if (acc) {
          emitBlock(acc)
          accumulators.delete(idx)
        }
      }
      if (thinkingActive) {
        callbacks.onThinkingComplete?.()
        thinkingActive = false
      }
      return
    }
  }

  const flushAll = (): void => {
    if (accumulators.size > 0) {
      for (const acc of accumulators.values()) {
        emitBlock(acc)
      }
      accumulators.clear()
    }
    // Fire the trailing onThinkingComplete bracket if the stream closed
    // mid-thinking (no content_block_stop ever arrived to reset the
    // active flag). Preserves the pre-refactor behavior of
    // anthropicCompatHttp.ts, which had a separate tail block doing
    // exactly this after the EOS accumulator drain.
    if (thinkingActive) {
      callbacks.onThinkingComplete?.()
      thinkingActive = false
    }
  }

  return { handle, flushAll }
}
