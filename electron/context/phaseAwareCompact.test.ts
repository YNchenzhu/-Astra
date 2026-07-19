import { describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLDS } from './manager'
import {
  collectPhaseAwareCompactSignals,
  countToolResultGroups,
  decidePhaseAwareCompact,
} from './phaseAwareCompact'

function toolResultHistory(groups: number): Array<Record<string, unknown>> {
  return Array.from({ length: groups }, (_, idx) => ({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: `tool-${idx}`,
        content: 'x'.repeat(300),
      },
    ],
  }))
}

describe('phase-aware compact policy', () => {
  it('recognizes plan, todo, and verification phase signals', () => {
    const signals = collectPhaseAwareCompactSignals([
      { name: 'ExitPlanMode', input: {} },
      {
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Implement', status: 'completed' },
            { content: 'Verify', status: 'pending' },
          ],
        },
      },
      { name: 'Agent', input: { subagent_type: 'Verification' } },
    ])

    expect(signals.map((signal) => signal.reason)).toEqual(
      expect.arrayContaining([
        'exit_plan_mode',
        'verification_checkpoint',
        'todo_checkpoint',
        'tool_batch_checkpoint',
      ]),
    )
    expect(signals[0].strength).toBe('strong')
  })

  it('only requests proactive micro-compact when a checkpoint has enough reclaimable history', () => {
    const messages = toolResultHistory(6)
    const decision = decidePhaseAwareCompact({
      boundary: 'post_tool',
      toolUseBlocks: [{ name: 'ExitPlanMode', input: {} }],
      messages,
      thresholds: DEFAULT_THRESHOLDS,
      estimatedTokens: DEFAULT_THRESHOLDS.warningTokens,
      iteration: 4,
      lastPhaseAwareCompactIteration: 0,
    })

    expect(countToolResultGroups(messages)).toBe(6)
    expect(decision.shouldCompact).toBe(true)
    if (decision.shouldCompact) {
      expect(decision.request.action).toBe('micro_compact')
      expect(decision.request.reason).toBe('exit_plan_mode')
    }
  })

  it('skips below threshold, during cooldown, and when there is no old tool history', () => {
    const base = {
      boundary: 'post_tool' as const,
      toolUseBlocks: [{ name: 'Agent', input: { subagent_type: 'Verification' } }],
      thresholds: DEFAULT_THRESHOLDS,
      iteration: 10,
      lastPhaseAwareCompactIteration: 0,
    }

    expect(
      decidePhaseAwareCompact({
        ...base,
        messages: toolResultHistory(6),
        estimatedTokens: DEFAULT_THRESHOLDS.warningTokens - 1,
      }),
    ).toMatchObject({ shouldCompact: false, skippedReason: 'below_threshold' })

    expect(
      decidePhaseAwareCompact({
        ...base,
        messages: toolResultHistory(6),
        estimatedTokens: DEFAULT_THRESHOLDS.warningTokens,
        lastPhaseAwareCompactIteration: 9,
      }),
    ).toMatchObject({ shouldCompact: false, skippedReason: 'cooldown' })

    expect(
      decidePhaseAwareCompact({
        ...base,
        messages: toolResultHistory(5),
        estimatedTokens: DEFAULT_THRESHOLDS.warningTokens,
      }),
    ).toMatchObject({
      shouldCompact: false,
      skippedReason: 'no_reclaimable_history',
    })
  })

  // ── GAP 4 (2026-06) — degradation signal → proactive compact ────────
  describe('degradation checkpoint', () => {
    const base = {
      boundary: 'post_tool' as const,
      toolUseBlocks: [] as Array<{ name: string; input?: Record<string, unknown> }>,
      messages: toolResultHistory(6),
      thresholds: DEFAULT_THRESHOLDS,
      iteration: 8,
      lastPhaseAwareCompactIteration: 0,
    }

    it('strong (count ≥ 5) compacts from the warning threshold with no tool-use signals at all', () => {
      const decision = decidePhaseAwareCompact({
        ...base,
        estimatedTokens: DEFAULT_THRESHOLDS.warningTokens,
        degradation: {
          kind: 'tool_repetition',
          toolName: 'Bash',
          consecutiveCount: 5,
        },
      })
      expect(decision.shouldCompact).toBe(true)
      if (decision.shouldCompact) {
        expect(decision.request.reason).toBe('degradation_checkpoint')
        expect(decision.signal.strength).toBe('strong')
        expect(decision.signal.sourceToolName).toBe('Bash')
      }
    })

    it('medium (count 3-4) requires the error threshold', () => {
      const degradation = {
        kind: 'tool_repetition' as const,
        toolName: 'grep',
        consecutiveCount: 3,
      }
      expect(
        decidePhaseAwareCompact({
          ...base,
          estimatedTokens: DEFAULT_THRESHOLDS.errorTokens - 1,
          degradation,
        }),
      ).toMatchObject({ shouldCompact: false, skippedReason: 'below_threshold' })

      const decision = decidePhaseAwareCompact({
        ...base,
        estimatedTokens: DEFAULT_THRESHOLDS.errorTokens,
        degradation,
      })
      expect(decision.shouldCompact).toBe(true)
      if (decision.shouldCompact) {
        expect(decision.request.reason).toBe('degradation_checkpoint')
        expect(decision.signal.strength).toBe('medium')
      }
    })

    it('absent degradation leaves the no_signal path untouched', () => {
      expect(
        decidePhaseAwareCompact({
          ...base,
          estimatedTokens: DEFAULT_THRESHOLDS.warningTokens,
        }),
      ).toMatchObject({ shouldCompact: false, skippedReason: 'no_signal' })
    })

    it('coexists with tool-use signals and still respects cooldown', () => {
      expect(
        decidePhaseAwareCompact({
          ...base,
          toolUseBlocks: [{ name: 'ExitPlanMode', input: {} }],
          estimatedTokens: DEFAULT_THRESHOLDS.warningTokens,
          lastPhaseAwareCompactIteration: 7,
          degradation: {
            kind: 'tool_repetition',
            toolName: 'Bash',
            consecutiveCount: 5,
          },
        }),
      ).toMatchObject({ shouldCompact: false, skippedReason: 'cooldown' })
    })
  })
})
