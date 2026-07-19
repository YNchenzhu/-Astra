/**
 * upstream report §1.2 — `query.ts` exposes an AsyncGenerator-style message loop.
 * The desktop stack still runs `streamHandler` → `runAgenticLoop`; this module provides
 * the same **iterator contract** for bridging, tests, and headless runners: push stream
 * events into a queue and consume them with `for await`.
 */

import type { StreamEvent } from './streamHandler'

export type QueryLoopYield = StreamEvent

type Chunk =
  | { kind: 'msg'; msg: QueryLoopYield }
  | { kind: 'end' }
  | { kind: 'err'; err: Error }

/**
 * Hard cap on un-consumed stream events buffered for a single conversation.
 * Mirrors the rationale in sessionSpawner.SESSION_EVENT_CHANNEL_MAX: only
 * breached when the iterable consumer itself is stalled. On breach we drop
 * the oldest message chunk and keep terminal markers (end/err) so the
 * iterator's contract isn't silently broken.
 */
const QUERY_LOOP_CHANNEL_MAX = 5000

export function createQueryLoopChannel(): {
  push: (msg: QueryLoopYield) => void
  end: () => void
  fail: (err: Error) => void
  iterable: AsyncIterable<QueryLoopYield>
} {
  const q: Chunk[] = []
  let resolver: (() => void) | null = null
  let closed = false
  let droppedSinceLastWarn = 0
  let totalDropped = 0

  function signal() {
    const r = resolver
    resolver = null
    r?.()
  }

  function enqueue(c: Chunk) {
    if (q.length >= QUERY_LOOP_CHANNEL_MAX && c.kind === 'msg') {
      let droppedAt = -1
      for (let i = 0; i < q.length; i++) {
        if (q[i].kind === 'msg') {
          droppedAt = i
          break
        }
      }
      if (droppedAt >= 0) {
        q.splice(droppedAt, 1)
        droppedSinceLastWarn++
        totalDropped++
        if (droppedSinceLastWarn === 1 || droppedSinceLastWarn % 100 === 0) {
          console.warn(
            `[queryLoopChannel] overflow: dropped oldest event ` +
              `(queue >= ${QUERY_LOOP_CHANNEL_MAX}; total drops=${totalDropped}). ` +
              `Consumer of for-await iterable is stalled.`,
          )
        }
      }
    }
    q.push(c)
    signal()
  }

  async function* gen(): AsyncGenerator<QueryLoopYield> {
    while (true) {
      if (q.length === 0) {
        if (closed) return
        await new Promise<void>((resolve) => {
          resolver = resolve
        })
        continue
      }
      const chunk = q.shift()!
      if (chunk.kind === 'end') {
        return
      }
      if (chunk.kind === 'err') {
        throw chunk.err
      }
      yield chunk.msg
    }
  }

  // P1-31: a queue+single-consumer model only works when there is exactly one
  // iterator. Previously `[Symbol.asyncIterator]: () => gen()` rebuilt a
  // fresh generator on every `for await`, so two consumers iterating the
  // same channel would each pull `q.shift()` on alternating ticks —
  // events were not multiplexed, they were interleaved-and-stolen. We now
  // memoize the generator: every `[Symbol.asyncIterator]` call returns
  // the same instance, which makes the contract honest (single-consumer
  // semantics, runtime sharing is undefined and you should fan out via
  // explicit broadcast if you need multiple readers).
  let sharedIterator: AsyncGenerator<QueryLoopYield> | null = null

  return {
    push: (msg) => {
      if (closed) return
      enqueue({ kind: 'msg', msg })
    },
    end: () => {
      if (closed) return
      closed = true
      enqueue({ kind: 'end' })
    },
    fail: (err) => {
      if (closed) return
      closed = true
      enqueue({ kind: 'err', err })
    },
    iterable: {
      [Symbol.asyncIterator]: () => {
        if (sharedIterator === null) sharedIterator = gen()
        return sharedIterator
      },
    },
  }
}
