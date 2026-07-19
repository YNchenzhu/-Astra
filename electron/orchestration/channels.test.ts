/**
 * Channel reducer primitives.
 *
 * Equivalence guarantees asserted here:
 *   - `LastValue` matches `cloneTranscript`-style "replace and deep-clone" semantics.
 *   - `AppendList` matches the inbox `MAX_INBOX_SIZE` overflow policy that was previously
 *     inlined in `sessionCommands.ts`.
 *   - `Ephemeral` clears on the explicit `clear()` boundary (used by P2.1 / P3.2).
 *   - `Aggregator` covers arbitrary binary reducers.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createAggregatorChannel,
  createAppendListChannel,
  createEphemeralChannel,
  createLastValueChannel,
} from './channels'

describe('createLastValueChannel', () => {
  it('initial value via thunk or literal', () => {
    expect(createLastValueChannel(0).empty()).toBe(0)
    expect(createLastValueChannel(() => 'x').empty()).toBe('x')
  })

  it('reduce overwrites prior value', () => {
    const ch = createLastValueChannel<number>(0)
    expect(ch.reduce(1, 5)).toBe(5)
  })

  it('clone is applied on reduce + snapshot so caller cannot mutate stored value', () => {
    type T = { a: number[] }
    const deepClone = (v: T): T => ({ a: v.a.slice() })
    const ch = createLastValueChannel<T>({ a: [] }, deepClone)
    const update = { a: [1, 2] }
    const stored = ch.reduce({ a: [] }, update)
    expect(stored).not.toBe(update)
    update.a.push(3)
    expect(stored.a).toEqual([1, 2])
    const snap = ch.snapshot(stored)
    expect(snap).not.toBe(stored)
    expect(snap).toEqual(stored)
  })
})

describe('createAppendListChannel', () => {
  it('appends single item', () => {
    const ch = createAppendListChannel<number>()
    expect(ch.reduce([1, 2], 3)).toEqual([1, 2, 3])
  })

  it('appends array (flattened in order)', () => {
    const ch = createAppendListChannel<number>()
    expect(ch.reduce([1], [2, 3, 4])).toEqual([1, 2, 3, 4])
  })

  it('empty array update returns current reference unchanged', () => {
    const ch = createAppendListChannel<number>()
    const current = [1, 2]
    expect(ch.reduce(current, [])).toBe(current)
  })

  it('maxSize FIFO drops oldest items and fires onOverflow once per drop', () => {
    const onOverflow = vi.fn()
    const ch = createAppendListChannel<string>({ maxSize: 3, onOverflow })
    let v = ch.empty()
    v = ch.reduce(v, 'a')
    v = ch.reduce(v, 'b')
    v = ch.reduce(v, 'c')
    v = ch.reduce(v, 'd')
    expect(v).toEqual(['b', 'c', 'd'])
    expect(onOverflow).toHaveBeenCalledWith('a', 1)
    v = ch.reduce(v, ['e', 'f'])
    expect(v).toEqual(['d', 'e', 'f'])
    // dropCount increments monotonically across reduce calls.
    expect(onOverflow).toHaveBeenLastCalledWith('c', 3)
  })

  it('onOverflow throwing does not break the reducer (telemetry isolation)', () => {
    const ch = createAppendListChannel<number>({
      maxSize: 1,
      onOverflow: () => {
        throw new Error('telemetry boom')
      },
    })
    let v = ch.empty()
    v = ch.reduce(v, 1)
    expect(() => {
      v = ch.reduce(v, 2)
    }).not.toThrow()
    expect(v).toEqual([2])
  })

  it('snapshot clones items when cloneItem provided', () => {
    type Item = { v: number }
    const ch = createAppendListChannel<Item>({ cloneItem: (i) => ({ ...i }) })
    const orig = { v: 1 }
    const v = ch.reduce([], orig)
    const snap = ch.snapshot(v)
    expect(snap[0]).not.toBe(orig)
    expect(snap[0]).toEqual(orig)
  })
})

describe('createAggregatorChannel', () => {
  it('sums via binary reducer', () => {
    const ch = createAggregatorChannel<number, number>(0, (a, b) => a + b)
    let v = ch.empty()
    v = ch.reduce(v, 5)
    v = ch.reduce(v, 7)
    expect(v).toBe(12)
  })

  it('merges sets via clone', () => {
    const ch = createAggregatorChannel<Set<string>, string>(
      () => new Set(),
      (s, name) => new Set([...s, name]),
      { clone: (s) => new Set(s) },
    )
    let v = ch.empty()
    v = ch.reduce(v, 'Read')
    v = ch.reduce(v, 'Edit')
    v = ch.reduce(v, 'Read')
    expect([...v].sort()).toEqual(['Edit', 'Read'])
    const snap = ch.snapshot(v)
    expect(snap).not.toBe(v)
    expect([...snap].sort()).toEqual(['Edit', 'Read'])
  })
})

describe('createEphemeralChannel', () => {
  it('peek returns undefined when empty', () => {
    const ch = createEphemeralChannel<string>()
    expect(ch.peek()).toBeUndefined()
    expect(ch.hasPending()).toBe(false)
  })

  it('push then peek returns the value (cloned)', () => {
    const ch = createEphemeralChannel<{ v: number }>({ clone: (x) => ({ ...x }) })
    const original = { v: 5 }
    ch.push(original)
    const peeked = ch.peek()!
    expect(peeked).toEqual({ v: 5 })
    expect(peeked).not.toBe(original)
    expect(ch.hasPending()).toBe(true)
  })

  it('clear() wipes the slot — value gone on next read (LangGraph EphemeralValue semantics)', () => {
    const ch = createEphemeralChannel<string>()
    ch.push('answer')
    expect(ch.peek()).toBe('answer')
    ch.clear()
    expect(ch.peek()).toBeUndefined()
    expect(ch.hasPending()).toBe(false)
  })

  it('reduce mirrors push (matches Channel<V|undefined, V> shape)', () => {
    const ch = createEphemeralChannel<number>()
    const next = ch.reduce(undefined, 7)
    expect(next).toBe(7)
    expect(ch.peek()).toBe(7)
  })
})

describe('Channel equivalence with legacy reducers (P1.3)', () => {
  it('LastValue<Array<Record>> matches cloneTranscript-based replacement', async () => {
    const { cloneTranscript } = await import('./kernelTypes')
    const ch = createLastValueChannel<Array<Record<string, unknown>>>(
      () => [],
      cloneTranscript,
    )
    const before: Array<Record<string, unknown>> = [{ role: 'user', content: 'a' }]
    const update: Array<Record<string, unknown>> = [
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
    ]
    const next = ch.reduce(before, update)
    expect(next).toEqual(update)
    expect(next).not.toBe(update)
  })

  it('AppendList with maxSize=200 matches inbox overflow policy', () => {
    const overflows: number[] = []
    const ch = createAppendListChannel<{ kind: string }>({
      maxSize: 200,
      onOverflow: (_dropped, n) => overflows.push(n),
    })
    let v = ch.empty()
    for (let i = 0; i < 250; i++) {
      v = ch.reduce(v, { kind: `item-${i}` })
    }
    // After 250 pushes with maxSize=200, FIFO retains the LAST 200.
    expect(v).toHaveLength(200)
    expect(v[0].kind).toBe('item-50')
    expect(v[199].kind).toBe('item-249')
    expect(overflows.length).toBe(50)
    // Drop counter is monotonically increasing.
    expect(overflows).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  })
})
