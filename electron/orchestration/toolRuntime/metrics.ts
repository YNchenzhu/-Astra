/**
 * Audit fix L-2 — process-wide ToolRuntime metrics sink.
 *
 * The orchestration subsystem already emits rich PER-CONVERSATION
 * `orchestration_phase` stream events (quota denials, preemptions, history
 * blocks, outer-loop overflow). What was missing is a CROSS-conversation
 * aggregate: a single place an operator / dashboard / IPC poll can read to
 * answer "how often is quota throttling fired across the whole process?",
 * "how many cross-agent blocks are we issuing?", "are outer loops
 * overflowing?".
 *
 * This module is a tiny in-memory counter bag (no I/O, no allocation in the
 * hot path beyond a `Map.get`/`set`) incremented at the existing judgement
 * sites in `DefaultToolRuntimePort` + the kernel outer loop, and surfaced via
 * {@link ToolOrchestrator.getStatus}. It is intentionally NOT
 * conversation-scoped — it is the global rollup. Per-conversation detail stays
 * on the phase-event stream.
 */

/**
 * P2-8 — latency histogram bucket upper-edges (ms). A recorded duration lands
 * in the first bucket whose edge it is `<=`; anything larger lands in the
 * synthetic `+Inf` overflow bucket. Chosen to span sub-10ms local tool calls
 * up to 30s+ model/phase spans on a log-ish scale.
 */
export const LATENCY_BUCKET_EDGES_MS: ReadonlyArray<number> = [
  10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
]

/**
 * P2-8 — per-key latency summary. `count` / `sumMs` / `maxMs` are exact;
 * `p50Ms` / `p95Ms` are bucket-edge ESTIMATES (the upper edge of the bucket
 * that contains the percentile), so they are coarse by design — enough for
 * "is CallModel p95 blowing out?" dashboards, not billing-grade timing.
 */
export interface LatencySummary {
  count: number
  meanMs: number
  maxMs: number
  /** Approximate 50th percentile (bucket upper edge). */
  p50Ms: number
  /** Approximate 95th percentile (bucket upper edge). */
  p95Ms: number
}

interface LatencyAccumulator {
  count: number
  sumMs: number
  maxMs: number
  /** Bucket counts aligned to LATENCY_BUCKET_EDGES_MS + 1 overflow slot. */
  buckets: number[]
}

/** Immutable snapshot of the process-wide counters. */
export interface ToolRuntimeMetricsSnapshot {
  /** Quota admission denials, bucketed by `AdmissionDecision.reason`. */
  quotaDenials: Record<string, number>
  /** Total quota denials across all reasons (convenience sum). */
  quotaDenialsTotal: number
  /** Cross-agent history `block`-level decisions that denied a tool. */
  historyBlocks: number
  /** Cross-agent history `hint`-level advisories surfaced. */
  historyHints: number
  /** Preemptions fired (a lower-priority victim aborted for a newcomer). */
  preemptions: number
  /** Tools that entered the quota backpressure wait loop. */
  backpressureWaits: number
  /** PolicyEngine preflight denials (permission / rule / chat-mode). */
  permissionDenials: number
  /** Outer-turn loops that hit the cap with drainable inbox still pending. */
  outerLoopOverflows: number
  /**
   * P2-8 — per-kernel-phase latency distribution (`PrepareContext` /
   * `CallModel` / `Terminal` / …), fed by `withPhaseSpan` via the console
   * observer. Empty until the first phase completes. Closes the audit gap
   * "metrics are counters only — no latency percentiles".
   */
  phaseLatency: Record<string, LatencySummary>
}

class ToolRuntimeMetrics {
  private quotaDenials = new Map<string, number>()
  private historyBlocks = 0
  private historyHints = 0
  private preemptions = 0
  private backpressureWaits = 0
  private permissionDenials = 0
  private outerLoopOverflows = 0
  private phaseLatency = new Map<string, LatencyAccumulator>()

  recordQuotaDenial(reason: string): void {
    this.quotaDenials.set(reason, (this.quotaDenials.get(reason) ?? 0) + 1)
  }
  recordHistoryBlock(): void {
    this.historyBlocks++
  }
  recordHistoryHint(): void {
    this.historyHints++
  }
  recordPreemption(): void {
    this.preemptions++
  }
  recordBackpressureWait(): void {
    this.backpressureWaits++
  }
  recordPermissionDenial(): void {
    this.permissionDenials++
  }
  recordOuterLoopOverflow(): void {
    this.outerLoopOverflows++
  }

  /** P2-8 — record one phase-span duration (ms) into the per-phase histogram. */
  recordPhaseLatency(phase: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return
    let acc = this.phaseLatency.get(phase)
    if (!acc) {
      acc = { count: 0, sumMs: 0, maxMs: 0, buckets: new Array(LATENCY_BUCKET_EDGES_MS.length + 1).fill(0) }
      this.phaseLatency.set(phase, acc)
    }
    acc.count++
    acc.sumMs += durationMs
    if (durationMs > acc.maxMs) acc.maxMs = durationMs
    let idx = LATENCY_BUCKET_EDGES_MS.findIndex((edge) => durationMs <= edge)
    if (idx < 0) idx = LATENCY_BUCKET_EDGES_MS.length // +Inf overflow bucket
    acc.buckets[idx]++
  }

  snapshot(): ToolRuntimeMetricsSnapshot {
    const quotaDenials: Record<string, number> = {}
    let quotaDenialsTotal = 0
    for (const [reason, count] of this.quotaDenials) {
      quotaDenials[reason] = count
      quotaDenialsTotal += count
    }
    const phaseLatency: Record<string, LatencySummary> = {}
    for (const [phase, acc] of this.phaseLatency) {
      phaseLatency[phase] = {
        count: acc.count,
        meanMs: acc.count > 0 ? acc.sumMs / acc.count : 0,
        maxMs: acc.maxMs,
        p50Ms: estimatePercentileMs(acc, 0.5),
        p95Ms: estimatePercentileMs(acc, 0.95),
      }
    }
    return {
      quotaDenials,
      quotaDenialsTotal,
      historyBlocks: this.historyBlocks,
      historyHints: this.historyHints,
      preemptions: this.preemptions,
      backpressureWaits: this.backpressureWaits,
      permissionDenials: this.permissionDenials,
      outerLoopOverflows: this.outerLoopOverflows,
      phaseLatency,
    }
  }

  reset(): void {
    this.quotaDenials.clear()
    this.historyBlocks = 0
    this.historyHints = 0
    this.preemptions = 0
    this.backpressureWaits = 0
    this.permissionDenials = 0
    this.outerLoopOverflows = 0
    this.phaseLatency.clear()
  }
}

/**
 * P2-8 — coarse percentile estimate from bucket counts: walk buckets until the
 * cumulative count crosses `q * total`, return that bucket's upper edge (the
 * `+Inf` overflow bucket reports the largest finite edge as a floor). Returns 0
 * for an empty accumulator.
 */
function estimatePercentileMs(acc: LatencyAccumulator, q: number): number {
  if (acc.count === 0) return 0
  const target = q * acc.count
  let cumulative = 0
  for (let i = 0; i < acc.buckets.length; i++) {
    cumulative += acc.buckets[i]
    if (cumulative >= target) {
      return i < LATENCY_BUCKET_EDGES_MS.length
        ? LATENCY_BUCKET_EDGES_MS[i]
        : LATENCY_BUCKET_EDGES_MS[LATENCY_BUCKET_EDGES_MS.length - 1]
    }
  }
  return acc.maxMs
}

let instance: ToolRuntimeMetrics | undefined

export function getToolRuntimeMetrics(): ToolRuntimeMetrics {
  if (!instance) instance = new ToolRuntimeMetrics()
  return instance
}

/** Convenience read used by the orchestrator facade + IPC/telemetry pollers. */
export function snapshotToolRuntimeMetrics(): ToolRuntimeMetricsSnapshot {
  return getToolRuntimeMetrics().snapshot()
}

export function resetToolRuntimeMetricsForTests(): void {
  instance = undefined
}

export type { ToolRuntimeMetrics }
