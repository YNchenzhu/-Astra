import { describe, it, expect } from 'vitest'
import { StreamingToolBatchTracer } from './streamingToolExecutor'

describe('StreamingToolBatchTracer', () => {
  it('follows queued → executing → completed → yielded (strict)', async () => {
    const tracer = new StreamingToolBatchTracer(2, true)
    expect(tracer.getPhase()).toBe('queued')
    tracer.notifyExecutionBegun()
    expect(tracer.getPhase()).toBe('executing')
    tracer.notifyToolSettled()
    expect(tracer.getPhase()).toBe('executing')
    tracer.notifyToolSettled()
    expect(tracer.getPhase()).toBe('completed')
    tracer.notifyResultsHandedOff()
    expect(tracer.getPhase()).toBe('yielded')
  })

  it('empty batch yields immediately', () => {
    const tracer = new StreamingToolBatchTracer(0, true)
    tracer.notifyResultsHandedOff()
    expect(tracer.getPhase()).toBe('yielded')
  })
})
