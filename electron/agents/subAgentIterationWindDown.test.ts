import { describe, it, expect } from 'vitest'
import {
  shouldInjectIterationWindDown,
  buildIterationWindDownDirective,
  ITERATION_WINDDOWN_LEAD,
} from './subAgentReadonlyBudget'
import { createSubAgentLoopCallbacks } from './subAgentLoopCallbacks'
import { createSubAgentRunState } from './subAgentRunContext'
import { asAgentId } from '../tools/ids'
import type { AgentDefinitionUnion, SubAgentEvent } from './types'

describe('shouldInjectIterationWindDown', () => {
  it('fires on the lead window before the cap (1-based iteration)', () => {
    // maxIterations=10, lead=1 → fires at iteration >= 9.
    expect(shouldInjectIterationWindDown({ iteration: 9, maxIterations: 10 })).toBe(true)
    expect(shouldInjectIterationWindDown({ iteration: 10, maxIterations: 10 })).toBe(true)
  })

  it('does NOT fire while comfortably below the cap', () => {
    expect(shouldInjectIterationWindDown({ iteration: 8, maxIterations: 10 })).toBe(false)
    expect(shouldInjectIterationWindDown({ iteration: 1, maxIterations: 10 })).toBe(false)
  })

  it('skips tiny caps (<= 2) — the final-summary rescue backstop covers them', () => {
    expect(shouldInjectIterationWindDown({ iteration: 2, maxIterations: 2 })).toBe(false)
    expect(shouldInjectIterationWindDown({ iteration: 1, maxIterations: 1 })).toBe(false)
  })

  it('is robust to a non-finite cap', () => {
    expect(
      shouldInjectIterationWindDown({ iteration: 5, maxIterations: Number.NaN }),
    ).toBe(false)
  })

  it('lead constant is respected', () => {
    // maxIterations - LEAD is the first firing iteration.
    const max = 20
    expect(
      shouldInjectIterationWindDown({ iteration: max - ITERATION_WINDDOWN_LEAD, maxIterations: max }),
    ).toBe(true)
    expect(
      shouldInjectIterationWindDown({ iteration: max - ITERATION_WINDDOWN_LEAD - 1, maxIterations: max }),
    ).toBe(false)
  })
})

describe('buildIterationWindDownDirective', () => {
  it('produces a tool-free report turn tagged as an iteration trigger', () => {
    const d = buildIterationWindDownDirective({ iteration: 9, maxIterations: 10 })
    expect(d.disableToolsForThisTurn).toBe(true)
    expect(d.trigger).toBe('iterations')
    expect(d.appendUserContent).toContain('ITERATION BUDGET NEARLY EXHAUSTED')
    expect(d.appendUserContent).toContain('9 of 10')
    // Must instruct the model to stop tools and write the final report.
    expect(d.appendUserContent).toMatch(/STOP calling tools/i)
    expect(d.appendUserContent).toMatch(/final report/i)
  })
})

describe('createSubAgentLoopCallbacks — in-process wind-down emission', () => {
  const makeCallbacks = (maxIterations: number) => {
    const events: SubAgentEvent[] = []
    const ctx = createSubAgentRunState()
    const { loopCallbacks } = createSubAgentLoopCallbacks({
      ctx,
      onEvent: (e) => events.push(e),
      agentId: asAgentId('agent-winddown-test'),
      // Non-read-only type → only the iteration wind-down can fire.
      agentDef: { agentType: 'fixer' } as unknown as AgentDefinitionUnion,
      markAbortReason: () => {},
      bridgeAc: new AbortController(),
      maxRecordedFailures: 5,
      maxIterations,
    })
    return { events, ctx, loopCallbacks }
  }

  const preModelInfo = (iteration: number) => ({
    iteration,
    phases: [] as unknown[],
    snippedCount: 0,
    wasContextManaged: false,
  })

  it('emits subagent_winddown + forces a tool-free turn near the cap', () => {
    const { events, ctx, loopCallbacks } = makeCallbacks(10)
    const action = loopCallbacks.onQueryLoopPreModel?.(preModelInfo(9))
    expect(action?.disableToolsForThisTurn).toBe(true)
    const wd = events.find((e) => e.type === 'subagent_winddown')
    expect(wd).toMatchObject({
      type: 'subagent_winddown',
      trigger: 'iterations',
      iteration: 9,
      maxIterations: 10,
    })
    // Recorded on run-state for SubAgentResult.windDown.
    expect(ctx.windDown).toMatchObject({ trigger: 'iterations', iteration: 9, maxIterations: 10 })
    expect(ctx.budgetDirectiveInjected).toBe(true)
  })

  it('does not fire while comfortably below the cap', () => {
    const { events, ctx, loopCallbacks } = makeCallbacks(10)
    const action = loopCallbacks.onQueryLoopPreModel?.(preModelInfo(3))
    expect(action?.disableToolsForThisTurn).toBeUndefined()
    expect(events.some((e) => e.type === 'subagent_winddown')).toBe(false)
    expect(ctx.windDown).toBeUndefined()
  })

  it('is one-shot — a second pre-model call does not re-emit', () => {
    const { events, loopCallbacks } = makeCallbacks(10)
    loopCallbacks.onQueryLoopPreModel?.(preModelInfo(9))
    loopCallbacks.onQueryLoopPreModel?.(preModelInfo(10))
    expect(events.filter((e) => e.type === 'subagent_winddown')).toHaveLength(1)
  })
})
