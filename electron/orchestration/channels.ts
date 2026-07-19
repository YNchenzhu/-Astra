/**
 * Channel reducer primitives.
 *
 * Before P1.3 three places implemented "merge new update into accumulator" by hand with
 * subtly different shapes:
 *   - `sessionCommands.applySessionCommands` reduced transcript / inbox commands inline;
 *   - `ArtifactPort.publish` (`artifact.ts`) appended to an `entries[]` array with a max-size
 *     ringbuffer;
 *   - `getActiveAgent().pendingMessages` (ALS singleton, in `activeAgentRegistry.ts`) acted
 *     as a one-shot signal queue cleared on next read.
 *
 * Channels collapse the "what does an update do" decision into one declarative type per
 * merge strategy. The goal is NOT to wrap every kernel field in a Channel object at runtime
 * (that would be an invasive shape change); the goal is to give callers ONE place to import
 * `createLastValueChannel` / `createAppendListChannel` / `createAggregatorChannel` /
 * `createEphemeralChannel` so the reducer logic stops being copy-pasted.
 *
 * Naming follows LangGraph's channel taxonomy on purpose so the comparison report
 * (`LangGraph vs 本系统`) stays accurate as we migrate.
 */

/**
 * Generic channel: a value-of-type `V` updated by messages of type `U`.
 *
 * - `empty()` returns the initial value (call this when you want a fresh channel state).
 * - `reduce(current, update)` merges `update` into `current`, returning the new value
 *   (must be pure; never mutate `current`).
 * - `snapshot(value)` returns a deep-cloned copy safe to pass across persistence boundaries
 *   (file write, IPC) without sharing references with the live value.
 */
export interface Channel<V, U> {
  empty(): V
  reduce(current: V, update: U): V
  snapshot(value: V): V
}

/**
 * LastValue: each update overwrites the prior value (LangGraph's default channel kind).
 *
 * `clone` is invoked on both `reduce` and `snapshot` so the channel is safe even when the
 * caller passes mutable references (typical for `transcript: Array<Record<string, unknown>>`).
 * For primitive `V` (string/number) pass the identity clone (default).
 */
export function createLastValueChannel<V>(
  initial: V | (() => V),
  clone: (v: V) => V = (v) => v,
): Channel<V, V> {
  const empty: () => V =
    typeof initial === 'function' ? (initial as () => V) : () => initial
  return {
    empty,
    reduce(_current, update) {
      return clone(update)
    },
    snapshot(value) {
      return clone(value)
    },
  }
}

/**
 * AppendList: each update is appended to the list. Optional `maxSize` enforces a FIFO ring
 * (oldest items dropped first) — matches the `MAX_INBOX_SIZE` overflow policy in
 * `sessionCommands.ts` and the `maxEntries` cap in `artifact.ts`.
 *
 * Updates may be a single item or an array; arrays are flattened in order. Items are cloned
 * via `cloneItem` on `snapshot` only (cheap on reduce — caller is expected to pass a fresh
 * item per push).
 */
export function createAppendListChannel<T>(options?: {
  maxSize?: number
  cloneItem?: (t: T) => T
  /** Called once per evicted item when maxSize FIFO drops happen. Optional telemetry hook. */
  onOverflow?: (dropped: T, dropCount: number) => void
}): Channel<T[], T | T[]> {
  const cloneItem = options?.cloneItem ?? ((t: T) => t)
  let totalDropped = 0
  return {
    empty() {
      return []
    },
    reduce(current, update) {
      const updates = Array.isArray(update) ? update : [update]
      if (updates.length === 0) return current
      const next = current.concat(updates)
      if (options?.maxSize !== undefined) {
        while (next.length > options.maxSize) {
          const dropped = next.shift() as T
          totalDropped++
          try {
            options.onOverflow?.(dropped, totalDropped)
          } catch {
            /* telemetry must never break a reducer */
          }
        }
      }
      return next
    },
    snapshot(value) {
      return value.map(cloneItem)
    },
  }
}

/**
 * Aggregator: user-supplied binary reducer (LangGraph's `BinaryOperatorAggregate` analogue).
 * Use when neither "overwrite" nor "append" fits — e.g. `total: number` summed across
 * iterations, or a `Set<string>` accumulating unique tool names.
 */
export function createAggregatorChannel<V, U>(
  initial: V | (() => V),
  reduce: (current: V, update: U) => V,
  options?: { clone?: (v: V) => V },
): Channel<V, U> {
  const empty: () => V =
    typeof initial === 'function' ? (initial as () => V) : () => initial
  const clone = options?.clone ?? ((v: V) => v)
  return {
    empty,
    reduce(current, update) {
      return reduce(current, update)
    },
    snapshot(value) {
      return clone(value)
    },
  }
}

/**
 * Ephemeral: value is visible for **one read cycle only**, then `clear()` MUST be called
 * (typically at an iteration boundary) to wipe it. Mirrors LangGraph's `EphemeralValue`,
 * which is excluded from checkpointer writes — i.e. the value never persists across
 * supersteps. Useful for one-shot signals like a queued HITL `resume` value (P2.1) or a
 * "this iteration only" hook flag (P3.2).
 *
 * Unlike the other three reducers this channel is **stateful**: the boxed value lives in
 * the closure so the caller does not have to thread a `V | undefined` everywhere.
 *
 * The `Channel<V|undefined, V>` shape lets callers treat it like any other channel
 * (`reduce(undefined, update)` sets the slot; `reduce(value, update)` overwrites it,
 * matching LastValue semantics) while the `clear()` method exposes the iteration-boundary
 * wipe explicitly.
 */
export type EphemeralChannel<V> = Channel<V | undefined, V> & {
  /** Current pending value, or `undefined` when nothing is queued. */
  peek(): V | undefined
  /** Push a value into the slot (overrides any previous value). */
  push(value: V): void
  /** Wipe the slot. Call at iteration boundaries (kernel responsibility). */
  clear(): void
  /** Whether anything is currently queued. */
  hasPending(): boolean
}

export function createEphemeralChannel<V>(
  options?: { clone?: (v: V) => V },
): EphemeralChannel<V> {
  let pending: V | undefined = undefined
  const clone = options?.clone ?? ((v: V) => v)
  return {
    empty() {
      return undefined
    },
    reduce(_current, update) {
      pending = clone(update)
      return pending
    },
    snapshot(value) {
      return value === undefined ? undefined : clone(value)
    },
    peek() {
      return pending === undefined ? undefined : clone(pending)
    },
    push(value) {
      pending = clone(value)
    },
    clear() {
      pending = undefined
    },
    hasPending() {
      return pending !== undefined
    },
  }
}
