import { describe, expect, it } from 'vitest'
import {
  createAppendixAFlowReporter,
  isAppendixAFlowTelemetryEnabled,
  logAppendixABootstrapPhase,
} from './appendixAFlow'

describe('appendixAFlow', () => {
  it('createAppendixAFlowReporter does not emit P0 bootstrap stages on IPC stream', () => {
    const emitted: unknown[] = []
    const r = createAppendixAFlowReporter((ev) => emitted.push(ev), 'conv-1')
    r.report('P0_app_when_ready', {})
    expect(emitted).toHaveLength(0)
  })

  it('createAppendixAFlowReporter emits structured payload', () => {
    const emitted: unknown[] = []
    const r = createAppendixAFlowReporter((ev) => emitted.push(ev), 'conv-1')
    r.report('P2_Q_iteration_open', { iteration: 2 })
    expect(emitted).toHaveLength(1)
    const e = emitted[0] as Record<string, unknown>
    expect(e.type).toBe('orchestration_phase')
    expect(e.conversationId).toBe('conv-1')
    expect(e.appendixAStage).toBe('P2_Q_iteration_open')
    expect(e.appendixADetail).toEqual({ iteration: 2 })
  })

  it('isAppendixAFlowTelemetryEnabled is true when POLE_APPENDIX_A_FLOW=1', () => {
    const prev = process.env.POLE_APPENDIX_A_FLOW
    try {
      process.env.POLE_APPENDIX_A_FLOW = '1'
      expect(isAppendixAFlowTelemetryEnabled()).toBe(true)
    } finally {
      if (prev !== undefined) process.env.POLE_APPENDIX_A_FLOW = prev
      else delete process.env.POLE_APPENDIX_A_FLOW
    }
  })

  it('isAppendixAFlowTelemetryEnabled is false when POLE_APPENDIX_A_FLOW=0', () => {
    const prev = process.env.POLE_APPENDIX_A_FLOW
    try {
      process.env.POLE_APPENDIX_A_FLOW = '0'
      expect(isAppendixAFlowTelemetryEnabled()).toBe(false)
    } finally {
      if (prev !== undefined) process.env.POLE_APPENDIX_A_FLOW = prev
      else delete process.env.POLE_APPENDIX_A_FLOW
    }
  })

  it('logAppendixABootstrapPhase is a no-op when telemetry disabled', () => {
    const prev = process.env.POLE_APPENDIX_A_FLOW
    try {
      process.env.POLE_APPENDIX_A_FLOW = '0'
      expect(() => logAppendixABootstrapPhase('P0_app_when_ready', { x: 1 })).not.toThrow()
    } finally {
      if (prev !== undefined) process.env.POLE_APPENDIX_A_FLOW = prev
      else delete process.env.POLE_APPENDIX_A_FLOW
    }
  })

  it('isAppendixAFlowTelemetryEnabled defaults to true in dev / vitest (no env, no packaged app)', () => {
    // Vitest host: `require('electron').app` throws or `app.isPackaged` is
    // false. Either way the env-unset branch falls through to `return true`.
    const prev = process.env.POLE_APPENDIX_A_FLOW
    try {
      delete process.env.POLE_APPENDIX_A_FLOW
      expect(isAppendixAFlowTelemetryEnabled()).toBe(true)
    } finally {
      if (prev !== undefined) process.env.POLE_APPENDIX_A_FLOW = prev
      else delete process.env.POLE_APPENDIX_A_FLOW
    }
  })
})
