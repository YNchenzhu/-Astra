/**
 * Unit tests for `createThinkingStreamAccumulator`.
 *
 * This file owns the contract that BOTH the HTTP-compat path
 * (`anthropicCompatHttp.ts`) and the SDK path (`providers/anthropic.ts`)
 * depend on. Most importantly, the multi-block regression test below
 * documents the SDK-path corner case the helper exists to fix: a response
 * with `[thinking-A, text, thinking-B]` MUST emit `onThinkingBlock(A)`
 * before any of B's deltas are seen, otherwise the renderer's
 * walk-backwards targeting collides on the trailing thinking block.
 */

import { describe, it, expect } from 'vitest'
import {
  attachThinkingAccumulatorToSdkStream,
  createThinkingStreamAccumulator,
  type ThinkingStreamCallbacks,
  type ThinkingStreamEvent,
  type ThinkingSdkStreamLike,
} from './thinkingBlockAccumulator'

type RecordedEvent =
  | { kind: 'start' }
  | { kind: 'delta'; text: string }
  | { kind: 'complete' }
  | { kind: 'block'; thinking: string; signature?: string; hasTimeMs: boolean; hasTokens: boolean }

function makeRecorder(): { events: RecordedEvent[]; callbacks: ThinkingStreamCallbacks } {
  const events: RecordedEvent[] = []
  const callbacks: ThinkingStreamCallbacks = {
    onThinkingStart: () => {
      events.push({ kind: 'start' })
    },
    onThinkingDelta: (text) => {
      events.push({ kind: 'delta', text })
    },
    onThinkingComplete: () => {
      events.push({ kind: 'complete' })
    },
    onThinkingBlock: (b) => {
      events.push({
        kind: 'block',
        thinking: b.thinking,
        ...(b.signature ? { signature: b.signature } : {}),
        hasTimeMs: typeof b.thinkingTimeMs === 'number',
        hasTokens: typeof b.thinkingTokens === 'number',
      })
    },
  }
  return { events, callbacks }
}

// ── Wire-event factories (kept verbose so each test reads as a wire trace) ──

const startThinking = (index: number, initial?: { thinking?: string; signature?: string }): ThinkingStreamEvent => ({
  type: 'content_block_start',
  index,
  content_block: { type: 'thinking', ...(initial ?? {}) },
})

const startNonThinking = (index: number, type: string): ThinkingStreamEvent => ({
  type: 'content_block_start',
  index,
  content_block: { type },
})

const thinkingDelta = (index: number, text: string): ThinkingStreamEvent => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'thinking_delta', thinking: text },
})

const signatureDelta = (index: number, sig: string): ThinkingStreamEvent => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'signature_delta', signature: sig },
})

const textDelta = (index: number): ThinkingStreamEvent => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'text_delta' },
})

const stop = (index: number): ThinkingStreamEvent => ({
  type: 'content_block_stop',
  index,
})

// ── Single-block sanity ────────────────────────────────────────────────────

describe('createThinkingStreamAccumulator: single block', () => {
  it('accumulates thinking_delta + signature_delta and flushes on content_block_stop', () => {
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)
    acc.handle(startThinking(0))
    acc.handle(thinkingDelta(0, 'step 1, '))
    acc.handle(thinkingDelta(0, 'step 2'))
    acc.handle(signatureDelta(0, 'sig-abc'))
    acc.handle(stop(0))

    expect(r.events).toEqual([
      { kind: 'start' },
      { kind: 'delta', text: 'step 1, ' },
      { kind: 'delta', text: 'step 2' },
      { kind: 'block', thinking: 'step 1, step 2', signature: 'sig-abc', hasTimeMs: true, hasTokens: true },
      { kind: 'complete' },
    ])
  })

  it('does NOT emit onThinkingBlock for an empty block (start → stop, no deltas)', () => {
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)
    acc.handle(startThinking(0))
    acc.handle(stop(0))

    expect(r.events.filter((e) => e.kind === 'block')).toEqual([])
    // No thinking_delta fired → thinkingActive was never set → no onThinkingComplete.
    expect(r.events.filter((e) => e.kind === 'complete')).toEqual([])
  })

  it('emits a block from eager content_block_start payload even without any deltas', () => {
    // Some gateways inline the entire thinking text + signature in
    // content_block_start (no subsequent thinking_delta / signature_delta).
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)
    acc.handle(startThinking(0, { thinking: 'pre-baked thought', signature: 'sig-eager' }))
    acc.handle(stop(0))

    expect(r.events.filter((e) => e.kind === 'block')).toEqual([
      { kind: 'block', thinking: 'pre-baked thought', signature: 'sig-eager', hasTimeMs: true, hasTokens: true },
    ])
  })

  it('lazily creates an accumulator when content_block_start was skipped by the gateway', () => {
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)
    // No start; just deltas + stop.
    acc.handle(thinkingDelta(0, 'cold open'))
    acc.handle(signatureDelta(0, 'sig-late'))
    acc.handle(stop(0))

    expect(r.events.filter((e) => e.kind === 'block')).toEqual([
      { kind: 'block', thinking: 'cold open', signature: 'sig-late', hasTimeMs: true, hasTokens: true },
    ])
  })

  it('appends consecutive signature_deltas (defensive against split signatures)', () => {
    // Today Anthropic sends one signature_delta per block. We append rather
    // than overwrite so any future split delivery still produces the
    // concatenated authentic signature.
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)
    acc.handle(startThinking(0))
    acc.handle(thinkingDelta(0, 'thought'))
    acc.handle(signatureDelta(0, 'sig-'))
    acc.handle(signatureDelta(0, 'part-'))
    acc.handle(signatureDelta(0, 'two'))
    acc.handle(stop(0))

    const block = r.events.find((e) => e.kind === 'block')
    expect(block).toMatchObject({ thinking: 'thought', signature: 'sig-part-two' })
  })
})

// ── Multi-block scenarios (the corner case the helper exists to fix) ───────

describe('createThinkingStreamAccumulator: multiple thinking blocks per response', () => {
  it('emits onThinkingBlock for the first block BEFORE the second block opens (SDK-path regression)', () => {
    // Response shape: [thinking-A, text, thinking-B].
    //
    // The old SDK path collected deltas into a flat 'thinking' stream and
    // only emitted onThinkingBlock at finalMessage(), AFTER all blocks'
    // deltas had streamed. The renderer's "walk backwards to find the
    // most recent thinking block" then stamped BOTH _complete events
    // onto thinking-B, losing A's canonical text + signature.
    //
    // With per-stop semantics, onThinkingBlock(A) fires BEFORE any of B's
    // deltas arrive — giving the renderer the chance to settle A before
    // B opens, so each block ends up with its own correct payload.
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)

    // ── Block A (index 0) ──
    acc.handle(startThinking(0))
    acc.handle(thinkingDelta(0, 'A1 '))
    acc.handle(thinkingDelta(0, 'A2'))
    acc.handle(signatureDelta(0, 'sig-A'))
    acc.handle(stop(0))

    // ── Text block in between (index 1) — helper must ignore ──
    acc.handle(startNonThinking(1, 'text'))
    acc.handle(textDelta(1))
    acc.handle(stop(1))

    // ── Block B (index 2) ──
    acc.handle(startThinking(2))
    acc.handle(thinkingDelta(2, 'B1'))
    acc.handle(signatureDelta(2, 'sig-B'))
    acc.handle(stop(2))

    expect(r.events).toEqual([
      { kind: 'start' },
      { kind: 'delta', text: 'A1 ' },
      { kind: 'delta', text: 'A2' },
      { kind: 'block', thinking: 'A1 A2', signature: 'sig-A', hasTimeMs: true, hasTokens: true },
      { kind: 'complete' },
      // ↑ Block A is fully sealed BEFORE block B opens.
      { kind: 'start' },
      { kind: 'delta', text: 'B1' },
      { kind: 'block', thinking: 'B1', signature: 'sig-B', hasTimeMs: true, hasTokens: true },
      { kind: 'complete' },
    ])
  })

  it('handles back-to-back thinking blocks with no other content in between', () => {
    // Edge case: two thinking blocks directly adjacent — start(0), deltas,
    // stop(0), start(1), deltas, stop(1). Per-index accumulators must
    // remain isolated.
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)

    acc.handle(startThinking(0))
    acc.handle(thinkingDelta(0, 'first'))
    acc.handle(signatureDelta(0, 'sig-1'))
    acc.handle(stop(0))

    acc.handle(startThinking(1))
    acc.handle(thinkingDelta(1, 'second'))
    acc.handle(signatureDelta(1, 'sig-2'))
    acc.handle(stop(1))

    const blocks = r.events.filter((e) => e.kind === 'block')
    expect(blocks).toEqual([
      { kind: 'block', thinking: 'first', signature: 'sig-1', hasTimeMs: true, hasTokens: true },
      { kind: 'block', thinking: 'second', signature: 'sig-2', hasTimeMs: true, hasTokens: true },
    ])
  })

  it('does not let block A receive block B deltas (per-index isolation under interleaving)', () => {
    // Tests the per-index guard explicitly: if a delta on index 2 arrives
    // while index 0 is still open (degenerate gateway interleaving), index
    // 0's accumulator must NOT receive index 2's text.
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)

    acc.handle(startThinking(0))
    acc.handle(startThinking(2))
    acc.handle(thinkingDelta(0, 'A-only'))
    acc.handle(thinkingDelta(2, 'B-only'))
    acc.handle(stop(0))
    acc.handle(stop(2))

    const blocks = r.events.filter((e) => e.kind === 'block')
    expect(blocks).toEqual([
      { kind: 'block', thinking: 'A-only', hasTimeMs: true, hasTokens: true },
      { kind: 'block', thinking: 'B-only', hasTimeMs: true, hasTokens: true },
    ])
  })
})

// ── EOS / flushAll safety net ──────────────────────────────────────────────

describe('createThinkingStreamAccumulator: flushAll EOS branch', () => {
  it('emits leftover blocks and the trailing onThinkingComplete when the stream closes without content_block_stop', () => {
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)
    acc.handle(startThinking(0))
    acc.handle(thinkingDelta(0, 'unfinished'))
    // No stop. Source closes.
    acc.flushAll()

    expect(r.events.filter((e) => e.kind === 'block')).toEqual([
      { kind: 'block', thinking: 'unfinished', hasTimeMs: true, hasTokens: true },
    ])
    // The trailing bracket must close — preserves anthropicCompatHttp.ts
    // pre-refactor behavior so consumers that bracket on
    // onThinkingStart / onThinkingComplete don't leak a half-open marker.
    expect(r.events.filter((e) => e.kind === 'complete')).toHaveLength(1)
  })

  it('flushAll fires onThinkingComplete exactly once even when called multiple times', () => {
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)
    acc.handle(thinkingDelta(0, 'mid-thought'))
    acc.flushAll()
    acc.flushAll()
    expect(r.events.filter((e) => e.kind === 'complete')).toHaveLength(1)
  })

  it('flushAll on empty state is a no-op', () => {
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)
    acc.flushAll()
    expect(r.events).toEqual([])
  })

  it('flushAll after a complete stop is a no-op (no double-emit)', () => {
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)
    acc.handle(startThinking(0))
    acc.handle(thinkingDelta(0, 'done'))
    acc.handle(stop(0))
    const before = r.events.length
    acc.flushAll()
    expect(r.events.length).toBe(before)
  })

  it('flushes multiple leftover blocks (mixed: one stopped, one orphaned)', () => {
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)
    acc.handle(startThinking(0))
    acc.handle(thinkingDelta(0, 'first'))
    acc.handle(stop(0))
    // Second block never receives stop.
    acc.handle(startThinking(2))
    acc.handle(thinkingDelta(2, 'orphan'))
    acc.flushAll()

    const blocks = r.events.filter((e) => e.kind === 'block')
    expect(blocks).toEqual([
      { kind: 'block', thinking: 'first', hasTimeMs: true, hasTokens: true },
      { kind: 'block', thinking: 'orphan', hasTimeMs: true, hasTokens: true },
    ])
  })
})

// ── Non-thinking events are ignored ────────────────────────────────────────

describe('createThinkingStreamAccumulator: non-thinking events', () => {
  it('ignores content_block_start for non-thinking types', () => {
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)
    acc.handle(startNonThinking(0, 'tool_use'))
    acc.handle(startNonThinking(1, 'text'))
    acc.handle(startNonThinking(2, 'reasoning_summary'))
    acc.handle(stop(0))
    acc.handle(stop(1))
    acc.handle(stop(2))
    expect(r.events).toEqual([])
  })

  it('ignores deltas of non-thinking types (text_delta, input_json_delta, reasoning_summary_delta)', () => {
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)
    acc.handle({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta' } })
    acc.handle({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta' } })
    acc.handle({ type: 'content_block_delta', index: 0, delta: { type: 'reasoning_summary_delta' } })
    expect(r.events).toEqual([])
  })

  it('ignores message_start / message_stop / ping / error envelopes', () => {
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)
    acc.handle({ type: 'message_start' })
    acc.handle({ type: 'message_stop' })
    acc.handle({ type: 'ping' })
    acc.handle({ type: 'error' })
    expect(r.events).toEqual([])
  })

  it('content_block_stop on a non-thinking index still fires onThinkingComplete as a transition marker', () => {
    // This preserves the original anthropicCompatHttp.ts behavior: once
    // a thinking_delta has set thinkingActive=true, the next
    // content_block_stop — whether for the thinking block or a following
    // text/tool_use block — fires onThinkingComplete and resets the flag.
    const r = makeRecorder()
    const acc = createThinkingStreamAccumulator(r.callbacks)
    acc.handle(startThinking(0))
    acc.handle(thinkingDelta(0, 'reasoning'))
    // Stop of a DIFFERENT (text) block fires onThinkingComplete because
    // thinkingActive is still true. This is the audited behavior.
    acc.handle(stop(99))
    expect(r.events.filter((e) => e.kind === 'complete')).toHaveLength(1)
  })
})

// ── SDK stream wiring (attachThinkingAccumulatorToSdkStream) ───────────────

describe('attachThinkingAccumulatorToSdkStream: wiring contract', () => {
  // Minimal fake of the SDK MessageStream surface — enough to receive
  // `streamEvent` subscriptions and synchronously fan a payload back out
  // to all attached listeners. We deliberately do NOT use Node's
  // EventEmitter so this test file remains environment-agnostic and the
  // fake's behaviour is byte-obvious in one place.
  function makeFakeSdkStream(): ThinkingSdkStreamLike & {
    emit: (event: unknown) => void
  } {
    const listeners: Array<(event: unknown) => void> = []
    return {
      on: (eventName, listener) => {
        // Only one channel name is part of the contract; assert so a future
        // refactor that subscribes to a different name fails loudly here.
        if (eventName !== 'streamEvent') {
          throw new Error(`fake stream only supports 'streamEvent', got '${eventName}'`)
        }
        listeners.push(listener)
      },
      emit: (event) => {
        for (const l of listeners) l(event)
      },
    }
  }

  it('subscribes to streamEvent and routes a thinking block through to onThinkingBlock', () => {
    // Contract: the wiring subscribes to the `streamEvent` channel
    // (and only that channel), and a multi-event sequence emitted by
    // the SDK results in a single onThinkingBlock at the wire's
    // content_block_stop. This is the integration shape the SDK-path
    // unit tests above prove the helper supports.
    const r = makeRecorder()
    const stream = makeFakeSdkStream()
    attachThinkingAccumulatorToSdkStream(stream, r.callbacks)

    stream.emit(startThinking(0))
    stream.emit(thinkingDelta(0, 'one '))
    stream.emit(thinkingDelta(0, 'two'))
    stream.emit(signatureDelta(0, 'sig-1'))
    stream.emit(stop(0))

    expect(r.events).toEqual([
      { kind: 'start' },
      { kind: 'delta', text: 'one ' },
      { kind: 'delta', text: 'two' },
      { kind: 'block', thinking: 'one two', signature: 'sig-1', hasTimeMs: true, hasTokens: true },
      { kind: 'complete' },
    ])
  })

  it('SDK-path regression: multi-block response with text in between emits per-stop, not in a finalMessage burst', () => {
    // The historical SDK-path bug: `activeStream.on('thinking', ...)`
    // collapsed multiple thinking blocks into a flat delta stream and
    // `onThinkingBlock` only fired at finalMessage() resolution — AFTER
    // all blocks' deltas streamed — so the renderer's walk-backwards
    // targeting stamped both _complete events onto the trailing block.
    //
    // With wiring through streamEvent, each thinking content block flushes
    // at its own content_block_stop, BEFORE later blocks open. This test
    // documents that integration shape end-to-end: if the SDK truly emits
    // content_block_start/delta/stop frames for thinking blocks (the
    // contract we're banking on), our wiring delivers them correctly.
    const r = makeRecorder()
    const stream = makeFakeSdkStream()
    attachThinkingAccumulatorToSdkStream(stream, r.callbacks)

    // Wire frames for [thinking-A, text, thinking-B]
    stream.emit(startThinking(0))
    stream.emit(thinkingDelta(0, 'A1 '))
    stream.emit(thinkingDelta(0, 'A2'))
    stream.emit(signatureDelta(0, 'sig-A'))
    stream.emit(stop(0))
    stream.emit(startNonThinking(1, 'text'))
    stream.emit(textDelta(1))
    stream.emit(stop(1))
    stream.emit(startThinking(2))
    stream.emit(thinkingDelta(2, 'B1'))
    stream.emit(signatureDelta(2, 'sig-B'))
    stream.emit(stop(2))

    const blocks = r.events.filter((e) => e.kind === 'block')
    expect(blocks).toEqual([
      { kind: 'block', thinking: 'A1 A2', signature: 'sig-A', hasTimeMs: true, hasTokens: true },
      { kind: 'block', thinking: 'B1', signature: 'sig-B', hasTimeMs: true, hasTokens: true },
    ])
    // Critical ordering invariant: block A is FULLY sealed (emitted)
    // before any of block B's deltas arrive — exactly what the renderer's
    // walk-backwards targeting depends on.
    const idxBlockA = r.events.findIndex((e) => e.kind === 'block' && e.thinking === 'A1 A2')
    const idxFirstBDelta = r.events.findIndex((e) => e.kind === 'delta' && e.text === 'B1')
    expect(idxBlockA).toBeGreaterThanOrEqual(0)
    expect(idxFirstBDelta).toBeGreaterThan(idxBlockA)
  })

  it('returns the accumulator instance so the caller can flushAll() at EOS', () => {
    // The streaming caller (providers/anthropic.ts) needs the accumulator
    // reference to call flushAll() after finalMessage() resolves, in case
    // the SDK closed without a wire-level content_block_stop for the
    // trailing block. This test pins that contract.
    const r = makeRecorder()
    const stream = makeFakeSdkStream()
    const acc = attachThinkingAccumulatorToSdkStream(stream, r.callbacks)

    stream.emit(startThinking(0))
    stream.emit(thinkingDelta(0, 'no stop arrived'))
    // SDK never emits content_block_stop — caller must flushAll.
    acc.flushAll()

    const blocks = r.events.filter((e) => e.kind === 'block')
    expect(blocks).toEqual([
      { kind: 'block', thinking: 'no stop arrived', hasTimeMs: true, hasTokens: true },
    ])
  })

  it('ignores null / non-object streamEvent payloads (defensive against SDK quirks)', () => {
    // Some SDK versions / event-bus middleware can deliver bare `null` or
    // primitive payloads. The wiring filter must drop them without
    // crashing the listener (which would leak into an unhandled error
    // on the next emit).
    const r = makeRecorder()
    const stream = makeFakeSdkStream()
    attachThinkingAccumulatorToSdkStream(stream, r.callbacks)

    stream.emit(null)
    stream.emit(undefined)
    stream.emit('not an object')
    stream.emit(42)

    // Followed by a valid event — must still process correctly to prove
    // the listener didn't tear itself down on the bad payloads.
    stream.emit(startThinking(0))
    stream.emit(thinkingDelta(0, 'ok'))
    stream.emit(stop(0))

    const blocks = r.events.filter((e) => e.kind === 'block')
    expect(blocks).toEqual([
      { kind: 'block', thinking: 'ok', hasTimeMs: true, hasTokens: true },
    ])

    const completes = r.events.filter((e) => e.kind === 'complete')
    expect(completes.length).toBe(1)
  })
})
