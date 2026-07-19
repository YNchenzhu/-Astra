/**
 * Unit tests for the L-2 process-wide ToolRuntime metrics sink.
 *
 * Run: npx vitest run electron/orchestration/toolRuntime/__tests__/metrics.test.ts
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  getToolRuntimeMetrics,
  resetToolRuntimeMetricsForTests,
  snapshotToolRuntimeMetrics,
} from '../metrics'

describe('ToolRuntimeMetrics (L-2)', () => {
  beforeEach(() => {
    resetToolRuntimeMetricsForTests()
  })

  it('starts at zero', () => {
    const s = snapshotToolRuntimeMetrics()
    expect(s).toEqual({
      quotaDenials: {},
      quotaDenialsTotal: 0,
      historyBlocks: 0,
      historyHints: 0,
      preemptions: 0,
      backpressureWaits: 0,
      permissionDenials: 0,
      outerLoopOverflows: 0,
      phaseLatency: {},
    })
  })

  it('records per-phase latency into a histogram with exact count/mean/max + estimated p50/p95', () => {
    const m = getToolRuntimeMetrics()
    // 10 CallModel spans: nine ~200ms, one 9000ms outlier.
    for (let i = 0; i < 9; i++) m.recordPhaseLatency('CallModel', 200)
    m.recordPhaseLatency('CallModel', 9_000)
    m.recordPhaseLatency('PrepareContext', 5)

    const s = snapshotToolRuntimeMetrics()
    const cm = s.phaseLatency.CallModel
    expect(cm.count).toBe(10)
    expect(cm.maxMs).toBe(9_000) // exact
    expect(cm.meanMs).toBeCloseTo((9 * 200 + 9_000) / 10, 5) // exact mean
    // p50 lands in the 200 → 250-edge bucket; p95 crosses into the outlier's
    // 5000 → 10000-edge bucket. Both are coarse bucket-edge estimates.
    expect(cm.p50Ms).toBe(250)
    expect(cm.p95Ms).toBe(10_000)

    expect(s.phaseLatency.PrepareContext.count).toBe(1)
    expect(s.phaseLatency.PrepareContext.p50Ms).toBe(10) // 5ms → first bucket (≤10)

    // Negative / non-finite durations are ignored.
    m.recordPhaseLatency('CallModel', -1)
    m.recordPhaseLatency('CallModel', Number.NaN)
    expect(snapshotToolRuntimeMetrics().phaseLatency.CallModel.count).toBe(10)
  })

  it('buckets quota denials by reason and sums the total', () => {
    const m = getToolRuntimeMetrics()
    m.recordQuotaDenial('shell_quota')
    m.recordQuotaDenial('shell_quota')
    m.recordQuotaDenial('mutation_concurrency')
    m.recordQuotaDenial('exception')
    const s = snapshotToolRuntimeMetrics()
    expect(s.quotaDenials).toEqual({
      shell_quota: 2,
      mutation_concurrency: 1,
      exception: 1,
    })
    expect(s.quotaDenialsTotal).toBe(4)
  })

  it('accumulates the scalar counters and reset clears them', () => {
    const m = getToolRuntimeMetrics()
    m.recordHistoryBlock()
    m.recordHistoryHint()
    m.recordHistoryHint()
    m.recordPreemption()
    m.recordBackpressureWait()
    m.recordPermissionDenial()
    m.recordOuterLoopOverflow()
    let s = snapshotToolRuntimeMetrics()
    expect(s.historyBlocks).toBe(1)
    expect(s.historyHints).toBe(2)
    expect(s.preemptions).toBe(1)
    expect(s.backpressureWaits).toBe(1)
    expect(s.permissionDenials).toBe(1)
    expect(s.outerLoopOverflows).toBe(1)

    resetToolRuntimeMetricsForTests()
    s = snapshotToolRuntimeMetrics()
    expect(s.historyBlocks).toBe(0)
    expect(s.quotaDenialsTotal).toBe(0)
  })

  it('snapshot is an immutable copy (mutating it does not affect the sink)', () => {
    const m = getToolRuntimeMetrics()
    m.recordQuotaDenial('shell_quota')
    const s = snapshotToolRuntimeMetrics()
    s.quotaDenials.shell_quota = 999
    s.historyBlocks = 999
    expect(snapshotToolRuntimeMetrics().quotaDenials.shell_quota).toBe(1)
    expect(snapshotToolRuntimeMetrics().historyBlocks).toBe(0)
  })
})
