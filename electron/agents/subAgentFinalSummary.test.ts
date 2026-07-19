import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FINAL_SUMMARY_RESCUE_BUDGET_MAX_MS,
  FINAL_SUMMARY_RESCUE_BUDGET_MIN_MS,
  FINAL_SUMMARY_RESCUE_BUDGET_MS_DEFAULT,
  buildFinalSummaryRescuePrompt,
  resolveFinalSummaryRescueBudgetMs,
  runSubAgentFinalSummaryRescue,
  shouldRunFinalSummaryRescue,
} from './subAgentFinalSummary'

// Mock the agentic loop so the rescue test doesn't make a real network call.
// Each test sets `mockAgenticLoopImpl` to whatever stream behaviour it wants.
let mockAgenticLoopImpl: ((params: unknown, cb: unknown) => Promise<void>) | null = null

vi.mock('../orchestration/phases/iteration', () => ({
  runAgenticLoop: (params: unknown, cb: unknown) => {
    if (!mockAgenticLoopImpl) {
      throw new Error('mockAgenticLoopImpl not set for this test')
    }
    return mockAgenticLoopImpl(params, cb)
  },
}))

afterEach(() => {
  mockAgenticLoopImpl = null
})

describe('resolveFinalSummaryRescueBudgetMs', () => {
  it('returns the default when env var is undefined', () => {
    expect(resolveFinalSummaryRescueBudgetMs(undefined)).toBe(
      FINAL_SUMMARY_RESCUE_BUDGET_MS_DEFAULT,
    )
  })

  it('returns the default for empty string', () => {
    expect(resolveFinalSummaryRescueBudgetMs('')).toBe(
      FINAL_SUMMARY_RESCUE_BUDGET_MS_DEFAULT,
    )
  })

  it('disables rescue when explicitly set to "0"', () => {
    expect(resolveFinalSummaryRescueBudgetMs('0')).toBe(0)
  })

  it('falls back to default on non-numeric junk', () => {
    expect(resolveFinalSummaryRescueBudgetMs('not-a-number')).toBe(
      FINAL_SUMMARY_RESCUE_BUDGET_MS_DEFAULT,
    )
  })

  it('falls back to default on negative values', () => {
    expect(resolveFinalSummaryRescueBudgetMs('-100')).toBe(
      FINAL_SUMMARY_RESCUE_BUDGET_MS_DEFAULT,
    )
  })

  it('clamps tiny positive values up to the minimum floor', () => {
    expect(resolveFinalSummaryRescueBudgetMs('500')).toBe(
      FINAL_SUMMARY_RESCUE_BUDGET_MIN_MS,
    )
  })

  it('clamps very large values down to the ceiling', () => {
    expect(resolveFinalSummaryRescueBudgetMs('9999999')).toBe(
      FINAL_SUMMARY_RESCUE_BUDGET_MAX_MS,
    )
  })

  it('passes through reasonable values unchanged', () => {
    expect(resolveFinalSummaryRescueBudgetMs('60000')).toBe(60_000)
  })
})

describe('shouldRunFinalSummaryRescue', () => {
  const baseInput = {
    reachedMaxIterations: true,
    aborted: false,
    lastFinalText: '',
    apiMessageCount: 10,
    parentSignalAborted: false,
    budgetMs: 30_000,
  }

  it('returns true on max-iterations with empty lastFinalText and a transcript', () => {
    expect(shouldRunFinalSummaryRescue(baseInput)).toBe(true)
  })

  it('returns true on abort with empty lastFinalText', () => {
    expect(
      shouldRunFinalSummaryRescue({
        ...baseInput,
        reachedMaxIterations: false,
        aborted: true,
      }),
    ).toBe(true)
  })

  it('returns false when neither maxIterations nor aborted fired (clean completion)', () => {
    expect(
      shouldRunFinalSummaryRescue({
        ...baseInput,
        reachedMaxIterations: false,
        aborted: false,
      }),
    ).toBe(false)
  })

  it('returns false when rescue budget is 0 (env opt-out)', () => {
    expect(shouldRunFinalSummaryRescue({ ...baseInput, budgetMs: 0 })).toBe(false)
  })

  it('returns false when parent signal is already aborted (user cancel in flight)', () => {
    expect(
      shouldRunFinalSummaryRescue({ ...baseInput, parentSignalAborted: true }),
    ).toBe(false)
  })

  it('returns false when lastFinalText is already substantial', () => {
    // Threshold is 200; 250-char block of "x" comfortably crosses it.
    const longFinal = 'x'.repeat(250)
    expect(
      shouldRunFinalSummaryRescue({ ...baseInput, lastFinalText: longFinal }),
    ).toBe(false)
  })

  it('keeps the rescue when lastFinalText is below threshold (e.g. a single intent sentence)', () => {
    expect(
      shouldRunFinalSummaryRescue({
        ...baseInput,
        lastFinalText:
          'Now let me read the truncated reskin_engine.py and check the UI step files that call AI services.',
      }),
    ).toBe(true)
  })

  it('returns false when transcript is missing (no assistant turn to summarize)', () => {
    expect(
      shouldRunFinalSummaryRescue({ ...baseInput, apiMessageCount: 1 }),
    ).toBe(false)
  })

  // upstream parity: when the resolver's new transcript-walkback tier
  // already has substantial text, the rescue turn would just burn
  // tokens re-synthesising what we already have. Skip it.
  it('returns false when transcriptLastAssistantText already crosses the threshold', () => {
    const longTranscript = 'y'.repeat(250)
    expect(
      shouldRunFinalSummaryRescue({
        ...baseInput,
        transcriptLastAssistantText: longTranscript,
      }),
    ).toBe(false)
  })

  it('keeps the rescue when transcriptLastAssistantText is below threshold', () => {
    expect(
      shouldRunFinalSummaryRescue({
        ...baseInput,
        transcriptLastAssistantText: 'starting to investigate',
      }),
    ).toBe(true)
  })

  it('keeps the rescue when transcriptLastAssistantText is omitted entirely (legacy callers)', () => {
    expect(
      shouldRunFinalSummaryRescue({
        ...baseInput,
        // intentionally not passing transcriptLastAssistantText
      }),
    ).toBe(true)
  })
})

describe('buildFinalSummaryRescuePrompt', () => {
  it('mentions the iteration cap when reason is max_iterations', () => {
    const prompt = buildFinalSummaryRescuePrompt({
      reason: 'max_iterations',
      toolCallsMade: 50,
    })
    expect(prompt).toContain('maximum iteration limit')
    expect(prompt).toContain('50 tool call')
  })

  it('mentions the abort reason when provided', () => {
    const prompt = buildFinalSummaryRescuePrompt({
      reason: 'aborted',
      abortReason: 'Agent timed out after 600000ms',
      toolCallsMade: 12,
    })
    expect(prompt).toContain('Agent timed out after 600000ms')
    expect(prompt).toContain('12 tool call')
  })

  it('includes the three required sections so the model has a fixed shape to fill in', () => {
    const prompt = buildFinalSummaryRescuePrompt({
      reason: 'max_iterations',
      toolCallsMade: 1,
    })
    expect(prompt).toContain('## Findings')
    expect(prompt).toContain('## Conclusion')
    expect(prompt).toContain('## Unfinished work')
  })
})

describe('runSubAgentFinalSummaryRescue', () => {
  const baseParams = {
    config: {} as never,
    model: 'test-model',
    systemPrompt: 'You are a test agent.',
    apiMessages: [
      { role: 'user', content: 'find the bug' },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }] },
    ],
    reason: 'max_iterations' as const,
    toolCallsMade: 50,
    parentSignal: new AbortController().signal,
    budgetMs: 5_000,
  }

  it('captures streamed text and reports completion', async () => {
    const events: Array<{ type: string }> = []
    mockAgenticLoopImpl = async (_params, cbRaw) => {
      const cb = cbRaw as { onTextDelta: (s: string) => void }
      cb.onTextDelta('## Findings\n')
      cb.onTextDelta('- Found a bug in foo.ts:42\n')
      cb.onTextDelta('## Conclusion\nThe race is in `applyState`.')
    }

    const captured: string[] = []
    const result = await runSubAgentFinalSummaryRescue({
      ...baseParams,
      onTextDelta: (t) => captured.push(t),
      onEvent: (e) => events.push(e),
    })

    expect(result.errored).toBe(false)
    expect(result.timedOut).toBe(false)
    expect(result.text).toContain('## Findings')
    expect(result.text).toContain('The race is in `applyState`.')
    expect(captured.join('')).toBe(result.text + '') // forwarded faithfully (modulo trim)
    const kinds = events.map((e) => e.type)
    expect(kinds).toContain('rescue_start')
    expect(kinds).toContain('rescue_complete')
  })

  it('reports `timedOut` when the rescue exceeds its own budget', async () => {
    mockAgenticLoopImpl = async (params, _cb) => {
      const p = params as { signal: AbortSignal }
      // Mimic a hanging stream that ignores AbortSignal until it fires.
      await new Promise<void>((resolve) => {
        if (p.signal.aborted) return resolve()
        p.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    const result = await runSubAgentFinalSummaryRescue({
      ...baseParams,
      budgetMs: 30, // very short so the test finishes fast
    })
    expect(result.timedOut).toBe(true)
    expect(result.text).toBe('')
  })

  it('aborts immediately when parent signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    let stopped = false
    mockAgenticLoopImpl = async (params, _cb) => {
      const p = params as { signal: AbortSignal }
      stopped = p.signal.aborted
    }
    const result = await runSubAgentFinalSummaryRescue({
      ...baseParams,
      parentSignal: ac.signal,
      budgetMs: 5_000,
    })
    expect(stopped).toBe(true)
    expect(result.text).toBe('')
  })

  it("swallows errors from runAgenticLoop and returns errored=true", async () => {
    mockAgenticLoopImpl = async () => {
      throw new Error('provider 500')
    }
    const result = await runSubAgentFinalSummaryRescue(baseParams)
    expect(result.errored).toBe(true)
    expect(result.text).toBe('')
  })

  it('appends a rescue user turn after the existing transcript', async () => {
    let observed: Array<Record<string, unknown>> | null = null
    mockAgenticLoopImpl = async (params, cb) => {
      const p = params as { initialApiMessages?: Array<Record<string, unknown>> }
      observed = p.initialApiMessages ?? null
      ;(cb as { onTextDelta: (s: string) => void }).onTextDelta('done.')
    }
    await runSubAgentFinalSummaryRescue(baseParams)
    expect(observed).not.toBeNull()
    const messages = observed as Array<Record<string, unknown>>
    expect(messages).toHaveLength(baseParams.apiMessages.length + 1)
    const last = messages[messages.length - 1] as { role: string; content: unknown }
    expect(last.role).toBe('user')
  })

  it('disables tools on the rescue call (both flags off)', async () => {
    let observed: { enableTools?: boolean; toolDefinitionsOverride?: unknown[] } | null = null
    mockAgenticLoopImpl = async (params, cb) => {
      observed = params as typeof observed
      ;(cb as { onTextDelta: (s: string) => void }).onTextDelta('ok')
    }
    await runSubAgentFinalSummaryRescue(baseParams)
    expect(observed!.enableTools).toBe(false)
    expect(observed!.toolDefinitionsOverride).toEqual([])
  })
})
