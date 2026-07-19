/**
 * Per-tool rate-limit timestamp ring used by {@link PolicyEngine.countRecentCalls}.
 *
 * Why this exists: the legacy implementation walked every entry in
 * {@link getAllToolEntries} (retained for {@link TOOL_RUNTIME_CLEANUP_DELAY_MS} = 120s) on every
 * rate-limit check. With high-frequency tool use that's O(global tool count) per check.
 *
 * Replacement: a per-name timestamp deque with amortised O(1) eviction + reads — each
 * timestamp is touched at most twice (once on insert, once when it ages out).
 *
 * The ring is in its own module to avoid an import cycle between `policyEngine.ts` (which
 * queries it) and `toolRuntimeState.ts` (which records into it from `markToolRunning`).
 */

class PerToolTimestampRing {
  private readonly buckets = new Map<string, { entries: number[]; head: number }>()

  record(toolName: string, timestamp: number = Date.now()): void {
    let b = this.buckets.get(toolName)
    if (!b) {
      b = { entries: [], head: 0 }
      this.buckets.set(toolName, b)
    }
    // Destructive-audit fix (2026-06, R1): the deque's lazy head-trim in
    // `countSince` assumes monotonically non-decreasing timestamps. A
    // clock rollback (NTP correction, manual clock change) used to append
    // an out-of-order entry that either over-counted (stuck behind a
    // newer head element) or never aged out. Clamp to the last recorded
    // timestamp — a rollback event is counted as "at the latest known
    // time", which is the conservative direction for rate limiting.
    const last = b.entries.length > 0 ? b.entries[b.entries.length - 1]! : Number.NEGATIVE_INFINITY
    b.entries.push(timestamp < last ? last : timestamp)
  }

  /** Count timestamps >= cutoff for a tool. Trims aged-out entries lazily. */
  countSince(toolName: string, cutoff: number): number {
    const b = this.buckets.get(toolName)
    if (!b) return 0
    const arr = b.entries
    while (b.head < arr.length && arr[b.head] < cutoff) {
      b.head++
    }
    if (b.head > 64 && b.head * 2 > arr.length) {
      b.entries = arr.slice(b.head)
      b.head = 0
      return b.entries.length
    }
    return arr.length - b.head
  }

  reset(): void {
    this.buckets.clear()
  }
}

const ring = new PerToolTimestampRing()

/** Record a tool invocation timestamp. Called from {@link markToolRunning}. */
export function recordToolInvocationForRateLimit(toolName: string, timestamp: number = Date.now()): void {
  ring.record(toolName, timestamp)
}

/** Count invocations of `toolName` whose timestamps are >= `cutoff`. Amortised O(1). */
export function countToolInvocationsSince(toolName: string, cutoff: number): number {
  return ring.countSince(toolName, cutoff)
}

/** Test helper. */
export function clearToolRateLimitRingForTests(): void {
  ring.reset()
}
