/**
 * Tests for the per-loop Query Profiler.
 *
 * Notes:
 *  - The default factory is no-op when `POLE_QUERY_PROFILER` is unset to
 *    avoid runtime cost on production hot paths. Tests must opt in via
 *    `force: true` to exercise the real recorder.
 *  - Timings come from `performance.now()`, so we use small `await sleep`
 *    delays and assert via inequality rather than exact values.
 */
import { describe, it, expect } from 'vitest'
import { createQueryProfiler, QUERY_PROFILER_LABELS } from './queryProfiler'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('createQueryProfiler', () => {
  it('returns a no-op profiler when env flag is unset and `force` is not passed', () => {
    delete process.env.POLE_QUERY_PROFILER
    const p = createQueryProfiler()
    const end = p.startCheckpoint('whatever')
    end()
    p.setIteration(5)
    const r = p.report()
    expect(r.checkpoints).toHaveLength(0)
    expect(r.iterations).toBe(0)
    expect(r.totalDurationMs).toBe(0)
  })

  it('records checkpoint durations and aggregates by label when forced', async () => {
    const p = createQueryProfiler({ force: true })
    p.setIteration(1)

    const endA = p.startCheckpoint('phase_a')
    await sleep(15)
    endA()

    const endB1 = p.startCheckpoint('phase_b', { round: 1 })
    await sleep(5)
    endB1()

    p.setIteration(2)
    const endB2 = p.startCheckpoint('phase_b', { round: 2 })
    await sleep(5)
    endB2()

    const r = p.report()

    expect(r.iterations).toBe(2)
    expect(r.checkpoints).toHaveLength(3)
    expect(r.checkpoints[0]).toMatchObject({ label: 'phase_a', iteration: 1 })
    expect(r.checkpoints[0].durationMs).toBeGreaterThanOrEqual(10)
    expect(r.checkpoints[2]).toMatchObject({ label: 'phase_b', iteration: 2, detail: { round: 2 } })

    expect(r.totalsByLabel.phase_a).toBeDefined()
    expect(r.totalsByLabel.phase_a.count).toBe(1)
    expect(r.totalsByLabel.phase_b.count).toBe(2)
    expect(r.totalsByLabel.phase_b.durationMs).toBeGreaterThanOrEqual(8)
  })

  it('idempotent finalizer: double-calling end() records once', async () => {
    const p = createQueryProfiler({ force: true })
    const end = p.startCheckpoint('once')
    await sleep(2)
    end()
    end() // no-op
    end() // no-op
    const r = p.report()
    expect(r.checkpoints).toHaveLength(1)
  })

  it('cached report is stable across multiple report() calls', () => {
    const p = createQueryProfiler({ force: true })
    p.startCheckpoint('a')()
    const r1 = p.report()
    const r2 = p.report()
    expect(r1).toBe(r2)
  })

  it('exposes canonical phase labels for callers', () => {
    expect(QUERY_PROFILER_LABELS.preModel).toBe('pre_model')
    expect(QUERY_PROFILER_LABELS.stream).toBe('stream')
    expect(QUERY_PROFILER_LABELS.toolExec).toBe('tool_exec')
    expect(QUERY_PROFILER_LABELS.iteration).toBe('iteration_total')
  })
})
