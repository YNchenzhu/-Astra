/**
 * Unit tests for the shared `onToolInputDelta` throttle. Locks in the
 * two-gate semantics (time OR byte window) that every provider stream
 * consumer (`anthropicCompatHttp` / `compatibleClient` /
 * `providers/anthropic`) now relies on for IPC traffic shaping.
 */

import { describe, expect, it } from 'vitest'
import {
  TOOL_INPUT_DELTA_THROTTLE_BYTES,
  TOOL_INPUT_DELTA_THROTTLE_MS,
  createToolInputDeltaThrottleState,
  hasPendingThrottledTail,
  shouldEmitToolInputDelta,
} from './toolInputDeltaThrottle'

describe('toolInputDeltaThrottle', () => {
  it('createToolInputDeltaThrottleState — fresh "never emitted" baseline', () => {
    const s = createToolInputDeltaThrottleState()
    expect(s.lastEmitAt).toBe(0)
    expect(s.lastEmittedLength).toBe(0)
  })

  it('shouldEmitToolInputDelta — first call always passes (time gate from epoch 0)', () => {
    const s = createToolInputDeltaThrottleState()
    expect(shouldEmitToolInputDelta(s, 10, 1_000)).toBe(true)
  })

  it('shouldEmitToolInputDelta — declines while inside both windows', () => {
    const s = { lastEmitAt: 1_000, lastEmittedLength: 100 }
    // 10ms later, +50 bytes — neither gate trips
    expect(shouldEmitToolInputDelta(s, 150, 1_010)).toBe(false)
  })

  it('shouldEmitToolInputDelta — time gate opens after threshold', () => {
    const s = { lastEmitAt: 1_000, lastEmittedLength: 100 }
    expect(
      shouldEmitToolInputDelta(s, 110, 1_000 + TOOL_INPUT_DELTA_THROTTLE_MS - 1),
    ).toBe(false)
    expect(
      shouldEmitToolInputDelta(s, 110, 1_000 + TOOL_INPUT_DELTA_THROTTLE_MS),
    ).toBe(true)
  })

  it('shouldEmitToolInputDelta — byte gate opens after threshold, regardless of time', () => {
    const s = { lastEmitAt: 1_000, lastEmittedLength: 100 }
    expect(
      shouldEmitToolInputDelta(s, 100 + TOOL_INPUT_DELTA_THROTTLE_BYTES - 1, 1_001),
    ).toBe(false)
    expect(
      shouldEmitToolInputDelta(s, 100 + TOOL_INPUT_DELTA_THROTTLE_BYTES, 1_001),
    ).toBe(true)
  })

  it('shouldEmitToolInputDelta — currentLength <= lastEmitted suppresses regardless', () => {
    // Defensive: providers occasionally re-send the same accumulator length
    // (e.g. zero-length deltas as keepalives). Throttle must not emit.
    const s = { lastEmitAt: 1_000, lastEmittedLength: 100 }
    expect(shouldEmitToolInputDelta(s, 100, 999_999)).toBe(false)
    expect(shouldEmitToolInputDelta(s, 99, 999_999)).toBe(false)
  })

  it('hasPendingThrottledTail — true when bytes remain unemitted', () => {
    expect(hasPendingThrottledTail({ lastEmitAt: 0, lastEmittedLength: 100 }, 150)).toBe(
      true,
    )
    expect(hasPendingThrottledTail({ lastEmitAt: 0, lastEmittedLength: 100 }, 100)).toBe(
      false,
    )
  })

  it('coalescing scenario — many tiny deltas inside one window collapse to one emit', () => {
    const s = createToolInputDeltaThrottleState()
    let accLen = 0
    let nowMs = 1_000
    let emitCount = 0
    // First emit is always allowed (gate from epoch 0 is open).
    for (let i = 0; i < 50; i++) {
      accLen += 5
      nowMs += 1 // 1ms apart — total = 50ms, exactly at the time threshold
      if (shouldEmitToolInputDelta(s, accLen, nowMs)) {
        s.lastEmitAt = nowMs
        s.lastEmittedLength = accLen
        emitCount += 1
      }
    }
    // 50 chunks of 5 bytes = 250 bytes, just under the 256B threshold.
    // First chunk emits (epoch); each subsequent chunk falls inside both
    // windows until cumulative time crosses 50ms — that happens at
    // exactly the 50th chunk's timestamp, allowing a second emit at most.
    expect(emitCount).toBeGreaterThanOrEqual(1)
    expect(emitCount).toBeLessThanOrEqual(3)
  })

  it('burst escape — a single large delta gets through immediately', () => {
    const s = { lastEmitAt: 999_999_999, lastEmittedLength: 100 }
    // 1ms after the last emit, but accumulated length grew by > 256B
    expect(
      shouldEmitToolInputDelta(s, 100 + TOOL_INPUT_DELTA_THROTTLE_BYTES + 1, 999_999_999 + 1),
    ).toBe(true)
  })
})
