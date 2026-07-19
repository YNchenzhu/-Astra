/**
 * Phase-boundary observability (plan k5) — centralize enter/exit instead of scattered emits.
 */

import type { KernelTurnPhase } from './kernelTypes'
import { getToolRuntimeMetrics } from './toolRuntime/metrics'

export type OrchestrationObserver = {
  onPhaseEnter?(phase: KernelTurnPhase, iteration: number): void
  onPhaseExit?(phase: KernelTurnPhase, iteration: number, durationMs: number): void
}

export function createConsoleOrchestrationObserver(): OrchestrationObserver {
  return {
    onPhaseEnter(phase, iteration) {
      console.log(`[OrchestrationKernel] → ${phase} (iter=${iteration})`)
    },
    onPhaseExit(phase, iteration, durationMs) {
      console.log(`[OrchestrationKernel] ← ${phase} (iter=${iteration}) ${durationMs}ms`)
      // P2-8 — feed the phase span into the process-wide latency histogram so
      // `snapshotToolRuntimeMetrics().phaseLatency` exposes per-phase p50/p95,
      // not just counters. Best-effort; never let telemetry break the span.
      try {
        getToolRuntimeMetrics().recordPhaseLatency(phase, durationMs)
      } catch {
        /* ignore */
      }
    },
  }
}

export async function withPhaseSpan<T>(
  observer: OrchestrationObserver | undefined,
  phase: KernelTurnPhase,
  iteration: number,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now()
  observer?.onPhaseEnter?.(phase, iteration)
  try {
    return await fn()
  } finally {
    observer?.onPhaseExit?.(phase, iteration, Date.now() - start)
  }
}
