/**
 * Query Profiler — lightweight per-iteration timing collection for the
 * agentic loop.
 *
 * Why this exists:
 *   `appendixAFlow` already records *sequence* (which stage fired in what
 *   order) but doesn't carry timing metadata. When a user reports "the
 *   agent felt slow", we have no breakdown of where the time went —
 *   pre-model pipeline? streaming? tool execution? post-tool compaction?
 *   This profiler closes that gap with a checkpoint registry.
 *
 * Design:
 *   - Per-loop instance: each `runAgenticLoop` call gets its own profiler
 *     (no module-level singleton — parallel streams must not cross-pollute).
 *   - Checkpoints are flat `(label, durationMs)` pairs, scoped by iteration.
 *   - `startCheckpoint(label)` returns a `() => void` finalizer; idiomatic
 *     pattern with `try { ... } finally { end() }`.
 *   - At loop end / on termination, the profiler dumps a per-iteration
 *     breakdown via `console.debug` (gated by POLE_QUERY_PROFILER=1) and
 *     returns the structured report for downstream telemetry.
 *
 * Not goals:
 *   - High-precision profiling (sub-millisecond) — `performance.now()` is
 *     fine for our scale (10ms+ slices).
 *   - Distributed tracing — that's `appendixAFlow` / OTel territory.
 *   - User-visible UI — this is debug-only.
 */

const isProfilerEnabled = (): boolean => {
  const v = process.env.POLE_QUERY_PROFILER?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export interface QueryProfileCheckpoint {
  /** Phase label (e.g. `pre_model`, `stream`, `tool_exec`). */
  label: string
  /** Elapsed wall time in milliseconds. */
  durationMs: number
  /** 1-based iteration index when the checkpoint completed. */
  iteration: number
  /** Optional structured detail (e.g. `{ toolCount: 3 }`). */
  detail?: Record<string, unknown>
}

export interface QueryProfileReport {
  /** Total wall time from profiler creation to report generation. */
  totalDurationMs: number
  /** Number of iterations the loop executed. */
  iterations: number
  /** All checkpoints, in completion order. */
  checkpoints: QueryProfileCheckpoint[]
  /** Aggregated time per label across all iterations. */
  totalsByLabel: Record<string, { durationMs: number; count: number }>
}

export interface QueryProfiler {
  /**
   * Start timing a phase. Call the returned finalizer to record the
   * elapsed time. Safe to call inside try/finally — finalizer is idempotent.
   */
  startCheckpoint(label: string, detail?: Record<string, unknown>): () => void
  /** Note iteration boundary; subsequent checkpoints attribute to `n`. */
  setIteration(n: number): void
  /** Build the final report. Idempotent. */
  report(): QueryProfileReport
  /**
   * Dump the report via `console.debug` when `POLE_QUERY_PROFILER=1`.
   * No-op otherwise. Safe to call from any termination path.
   */
  flush(): void
}

/**
 * Create a fresh profiler. Each `runAgenticLoop` should own one instance.
 * Returns a no-op profiler when `POLE_QUERY_PROFILER` is not set so we
 * don't pay the timing-collection cost on production hot paths.
 */
export function createQueryProfiler(opts?: {
  /** Optional tag (conversationId / agentId) for multi-stream debug logs. */
  tag?: string
  /** Force-enable even when the env var is unset (for tests). */
  force?: boolean
}): QueryProfiler {
  if (!isProfilerEnabled() && !opts?.force) {
    return NOOP_PROFILER
  }

  const tag = opts?.tag?.trim() || 'agentic'
  const startedAt = performance.now()
  const checkpoints: QueryProfileCheckpoint[] = []
  let currentIteration = 0
  let cachedReport: QueryProfileReport | null = null

  return {
    startCheckpoint(label, detail) {
      const t0 = performance.now()
      let finalized = false
      return () => {
        if (finalized) return
        finalized = true
        const durationMs = performance.now() - t0
        checkpoints.push({
          label,
          durationMs,
          iteration: currentIteration,
          ...(detail ? { detail } : {}),
        })
      }
    },
    setIteration(n) {
      currentIteration = Math.max(0, Math.floor(n))
    },
    report() {
      if (cachedReport) return cachedReport
      const totalsByLabel: Record<string, { durationMs: number; count: number }> = {}
      for (const c of checkpoints) {
        const slot = totalsByLabel[c.label] ?? { durationMs: 0, count: 0 }
        slot.durationMs += c.durationMs
        slot.count += 1
        totalsByLabel[c.label] = slot
      }
      cachedReport = {
        totalDurationMs: performance.now() - startedAt,
        iterations: currentIteration,
        checkpoints,
        totalsByLabel,
      }
      return cachedReport
    },
    flush() {
      const r = this.report()
      const lines: string[] = []
      lines.push(
        `[QueryProfiler:${tag}] total=${r.totalDurationMs.toFixed(1)}ms iterations=${r.iterations} checkpoints=${r.checkpoints.length}`,
      )
      const sorted = Object.entries(r.totalsByLabel).sort(
        ([, a], [, b]) => b.durationMs - a.durationMs,
      )
      for (const [label, slot] of sorted) {
        lines.push(
          `  ${label.padEnd(28)} ${slot.durationMs.toFixed(1).padStart(8)}ms · ${slot.count}× · avg ${(
            slot.durationMs / Math.max(1, slot.count)
          )
            .toFixed(1)
            .padStart(7)}ms`,
        )
      }
      console.debug(lines.join('\n'))
    },
  }
}

const NOOP_PROFILER: QueryProfiler = {
  startCheckpoint() {
    return () => {
      /* noop */
    }
  },
  setIteration() {
    /* noop */
  },
  report() {
    return {
      totalDurationMs: 0,
      iterations: 0,
      checkpoints: [],
      totalsByLabel: {},
    }
  },
  flush() {
    /* noop */
  },
}

/** Canonical checkpoint labels — keep consumers in sync. */
export const QUERY_PROFILER_LABELS = {
  preModel: 'pre_model',
  stream: 'stream',
  streamRetry: 'stream_retry',
  reactiveCompact: 'reactive_compact',
  noTools: 'no_tools',
  stopHooks: 'stop_hooks',
  toolExec: 'tool_exec',
  postCompact: 'post_compact',
  iteration: 'iteration_total',
} as const

export type QueryProfilerLabel = (typeof QUERY_PROFILER_LABELS)[keyof typeof QUERY_PROFILER_LABELS]
