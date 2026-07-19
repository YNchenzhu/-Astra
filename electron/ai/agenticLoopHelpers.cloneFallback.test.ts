/**
 * Audit P2-2 — `cloneApiMessagesForOrchestration` fallback ladder.
 *
 * The helper used to be one-line `structuredClone || JSON.parse(JSON.stringify(...))`
 * with no error handling. A real-world transcript that includes a value
 * structuredClone can't handle (BigInt / Symbol / function) AND that JSON
 * can't survive either (e.g. a circular reference) used to throw and crash
 * `syncConversation` mid-iteration, leaving the kernel transcript silently
 * out of sync with the loop's `apiMessages`.
 *
 * The new ladder:
 *   1. structuredClone (preferred)
 *   2. JSON.parse(JSON.stringify(...)) (lossy but real copy)
 *   3. Object.freeze + share original reference (no copy, but mutation
 *      barrier so the two sides can't drift)
 *
 * Each fallback transition fires the optional `onCloneError` callback so
 * the caller can emit a typed `transcript_clone_degraded` phase event.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCloneDegradationCountsForTests,
  cloneApiMessagesForOrchestration,
  type CloneFallbackMode,
} from './agenticLoopHelpers'

beforeEach(() => {
  __resetCloneDegradationCountsForTests()
})

describe('cloneApiMessagesForOrchestration (P2-2 — fallback ladder)', () => {
  it('uses structuredClone for plain JSON transcripts and produces a fresh copy', () => {
    const original = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]
    const onCloneError = vi.fn()
    const cloned = cloneApiMessagesForOrchestration(original, { onCloneError })

    expect(cloned).toEqual(original)
    expect(cloned).not.toBe(original)
    expect(cloned[0]).not.toBe(original[0])
    expect(onCloneError).not.toHaveBeenCalled()

    // Mutating the clone must not affect the original.
    cloned[0].content = 'mutated'
    expect(original[0].content).toBe('hi')
  })

  it('falls back to JSON when structuredClone throws (Symbol value)', () => {
    // structuredClone rejects Symbol values; JSON.stringify silently drops
    // them. So this transcript should land in the 'json' fallback with a
    // clean (Symbol-stripped) payload.
    const sym = Symbol('marker')
    const original = [
      { role: 'user', content: 'hi', _marker: sym },
    ] as unknown as Array<Record<string, unknown>>

    const onCloneError = vi.fn()
    const cloned = cloneApiMessagesForOrchestration(original, { onCloneError })

    expect(cloned.length).toBe(1)
    expect(cloned[0].role).toBe('user')
    expect(cloned[0].content).toBe('hi')
    expect(onCloneError).toHaveBeenCalledTimes(1)
    const call = onCloneError.mock.calls[0]![0] as {
      mode: CloneFallbackMode
      messageCount: number
    }
    expect(call.mode).toBe('json')
    expect(call.messageCount).toBe(1)
  })

  it('falls back to frozen-shared when both strategies fail (throwing getter)', () => {
    // A getter that throws is traversed (and thrown by) both
    // `structuredClone` and `JSON.stringify`, so this drops the helper
    // all the way to the frozen-shared fallback.
    const a: Record<string, unknown> = { role: 'user', content: 'hi' }
    Object.defineProperty(a, 'boom', {
      enumerable: true,
      get(): unknown {
        throw new Error('boom-from-getter')
      },
    })

    const onCloneError = vi.fn()
    const cloned = cloneApiMessagesForOrchestration([a], { onCloneError })

    expect(onCloneError).toHaveBeenCalledTimes(1)
    const call = onCloneError.mock.calls[0]![0] as {
      mode: CloneFallbackMode
      messageCount: number
      primaryError: unknown
      secondaryError?: unknown
    }
    expect(call.mode).toBe('frozen-shared')
    expect(call.messageCount).toBe(1)
    expect(call.primaryError).toBeDefined()
    expect(call.secondaryError).toBeDefined()
    expect(cloned.length).toBe(1)
  })

  it('frozen-shared mode blocks accidental mutation', () => {
    // Force the frozen-shared path with a throwing getter (rejected by
    // both structuredClone and JSON.stringify).
    const a: Record<string, unknown> = { role: 'user', content: 'hi' }
    Object.defineProperty(a, 'boom', {
      enumerable: true,
      get(): unknown {
        throw new Error('boom')
      },
    })
    const original: Array<Record<string, unknown>> = [a]

    const onCloneError = vi.fn()
    const cloned = cloneApiMessagesForOrchestration(original, { onCloneError })

    expect(onCloneError).toHaveBeenCalled()
    const finalMode = (onCloneError.mock.calls.at(-1)![0] as { mode: CloneFallbackMode }).mode
    expect(finalMode).toBe('frozen-shared')

    // Same reference as input — mutation blocked by freeze.
    expect(cloned).toBe(original)
    expect(Object.isFrozen(cloned)).toBe(true)
    expect(Object.isFrozen(cloned[0])).toBe(true)
    expect(() => {
      ;(cloned as Array<Record<string, unknown>>).push({ role: 'user', content: 'x' })
    }).toThrow()
    expect(() => {
      cloned[0].role = 'assistant'
    }).toThrow()
  })

  it('reports the correct messageCount on failure', () => {
    const bomb: Record<string, unknown> = { role: 'user', content: 'bomb' }
    Object.defineProperty(bomb, 'boom', {
      enumerable: true,
      get(): unknown {
        throw new Error('boom')
      },
    })
    const original = Array.from({ length: 5 }, (_, i) =>
      i === 2 ? bomb : { role: 'user', content: `m${i}` },
    )

    const onCloneError = vi.fn()
    cloneApiMessagesForOrchestration(original, { onCloneError })
    expect(onCloneError).toHaveBeenCalled()
    const call = onCloneError.mock.calls.at(-1)![0] as {
      mode: CloneFallbackMode
      messageCount: number
    }
    expect(call.messageCount).toBe(5)
  })

  it('returns successfully without firing the callback when no onCloneError is supplied', () => {
    const original = [{ role: 'user', content: 'ok' }]
    // Should not throw — callback is optional.
    expect(() => cloneApiMessagesForOrchestration(original)).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────
// Audit SA-6 — per-occurrence counting (degradation is no longer a
// fire-once signal: every failure increments a per-mode counter, the
// console warning carries the running count, and `occurrenceCount` is
// forwarded to `onCloneError`).
// ─────────────────────────────────────────────────────────────────────

describe('cloneApiMessagesForOrchestration (SA-6 — occurrence counting)', () => {
  function makeJsonFallbackTranscript(): Array<Record<string, unknown>> {
    // Symbol value: rejected by structuredClone, silently dropped by JSON.
    return [
      { role: 'user', content: 'hi', _marker: Symbol('m') },
    ] as unknown as Array<Record<string, unknown>>
  }

  it('increments occurrenceCount across consecutive degradations of the same mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const onCloneError = vi.fn()
      cloneApiMessagesForOrchestration(makeJsonFallbackTranscript(), { onCloneError })
      cloneApiMessagesForOrchestration(makeJsonFallbackTranscript(), { onCloneError })
      cloneApiMessagesForOrchestration(makeJsonFallbackTranscript(), { onCloneError })

      expect(onCloneError).toHaveBeenCalledTimes(3)
      const counts = onCloneError.mock.calls.map(
        (c) => (c[0] as { occurrenceCount: number }).occurrenceCount,
      )
      expect(counts).toEqual([1, 2, 3])
    } finally {
      warn.mockRestore()
    }
  })

  it('warns on EVERY degradation (not just the first) and includes the running count', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      cloneApiMessagesForOrchestration(makeJsonFallbackTranscript())
      cloneApiMessagesForOrchestration(makeJsonFallbackTranscript())

      const degradedWarns = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('transcript clone degraded'))
      expect(degradedWarns.length).toBe(2)
      expect(degradedWarns[0]).toContain('occurrence #1')
      expect(degradedWarns[1]).toContain('occurrence #2')
      expect(degradedWarns[0]).toContain("'json'")
    } finally {
      warn.mockRestore()
    }
  })

  it('counts json and frozen-shared modes independently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const onCloneError = vi.fn()
      // 1× json degradation…
      cloneApiMessagesForOrchestration(makeJsonFallbackTranscript(), { onCloneError })
      // …then 1× frozen-shared (throwing getter kills both strategies).
      const bomb: Record<string, unknown> = { role: 'user', content: 'hi' }
      Object.defineProperty(bomb, 'boom', {
        enumerable: true,
        get(): unknown {
          throw new Error('boom')
        },
      })
      cloneApiMessagesForOrchestration([bomb], { onCloneError })

      const calls = onCloneError.mock.calls.map(
        (c) => c[0] as { mode: CloneFallbackMode; occurrenceCount: number },
      )
      expect(calls[0]).toMatchObject({ mode: 'json', occurrenceCount: 1 })
      // First frozen-shared occurrence starts its own counter at 1.
      expect(calls[1]).toMatchObject({ mode: 'frozen-shared', occurrenceCount: 1 })
    } finally {
      warn.mockRestore()
    }
  })

  it('healthy clones do not touch the counters', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const onCloneError = vi.fn()
      cloneApiMessagesForOrchestration([{ role: 'user', content: 'ok' }], { onCloneError })
      // Counter still starts at 1 for the next real degradation.
      cloneApiMessagesForOrchestration(makeJsonFallbackTranscript(), { onCloneError })
      expect(onCloneError).toHaveBeenCalledTimes(1)
      expect(
        (onCloneError.mock.calls[0]![0] as { occurrenceCount: number }).occurrenceCount,
      ).toBe(1)
    } finally {
      warn.mockRestore()
    }
  })
})
