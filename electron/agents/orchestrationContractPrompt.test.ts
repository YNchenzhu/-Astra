/**
 * Tests for the auto-injected Orchestration Contract appendix
 * ({@link buildOrchestrationContractAppend}).
 *
 * Coverage:
 *   - Skip conditions: built-in source, env opt-out, explicit `solo`.
 *   - Role inference from metadata when not explicitly declared.
 *   - Each role produces its expected lead bullet.
 *   - Tool-surface discipline only fires when role + surface mismatch.
 *   - `isReadOnly` honored even on writing-worker role.
 *   - `maxTurns` and `coordinatorPhase` surface as separate bullets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildOrchestrationContractAppend,
  inferOrchestrationRole,
} from './orchestrationContractPrompt'

describe('orchestrationContractPrompt', () => {
  const originalEnv = process.env.POLE_AUTO_ORCHESTRATION_CONTRACT

  beforeEach(() => {
    delete process.env.POLE_AUTO_ORCHESTRATION_CONTRACT
  })
  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.POLE_AUTO_ORCHESTRATION_CONTRACT = originalEnv
    } else {
      delete process.env.POLE_AUTO_ORCHESTRATION_CONTRACT
    }
  })

  describe('skip conditions', () => {
    it('returns empty string for built-in source', () => {
      const out = buildOrchestrationContractAppend({
        source: 'built-in',
        toolNames: ['Read', 'Grep'],
      })
      expect(out).toBe('')
    })

    it('returns empty string when env flag is "0"', () => {
      process.env.POLE_AUTO_ORCHESTRATION_CONTRACT = '0'
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'coordinator',
        toolNames: ['Agent'],
      })
      expect(out).toBe('')
    })

    it('returns empty string when role is explicitly "solo"', () => {
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'solo',
        isReadOnly: true,
        maxTurns: 100,
        toolNames: ['Read'],
      })
      expect(out).toBe('')
    })

    it('does inject for plugin source (treated like custom)', () => {
      const out = buildOrchestrationContractAppend({
        source: 'plugin',
        toolNames: ['Read'],
      })
      expect(out).toContain('## Orchestration Contract')
    })
  })

  describe('role inference', () => {
    it('verification phase → verifier', () => {
      expect(
        inferOrchestrationRole({
          coordinatorPhase: 'verification',
          toolNames: [],
        }),
      ).toBe('verifier')
    })

    it('spawn tools without write tools → coordinator', () => {
      expect(
        inferOrchestrationRole({
          toolNames: ['Agent', 'Read', 'TaskOutput'],
        }),
      ).toBe('coordinator')
    })

    it('spawn tools + write tools → not coordinator (writing-worker)', () => {
      // Edit + Agent on a worker means it CAN spawn but its primary
      // purpose is execution; coordinator role is reserved for "no own
      // edits".
      expect(
        inferOrchestrationRole({
          toolNames: ['Agent', 'Edit', 'Read'],
        }),
      ).toBe('writing-worker')
    })

    it('isReadOnly without write tools → readonly-worker', () => {
      expect(
        inferOrchestrationRole({
          isReadOnly: true,
          toolNames: ['Read', 'Grep'],
        }),
      ).toBe('readonly-worker')
    })

    it('default with edit tools → writing-worker', () => {
      expect(
        inferOrchestrationRole({
          toolNames: ['Read', 'Edit', 'Bash'],
        }),
      ).toBe('writing-worker')
    })

    it('explicit role overrides inference', () => {
      expect(
        inferOrchestrationRole({
          orchestrationRole: 'verifier',
          isReadOnly: false,
          toolNames: ['Read', 'Edit'],
        }),
      ).toBe('verifier')
    })
  })

  describe('coordinator role', () => {
    it('emits coordinator lead bullet and stays silent on its own spawn surface', () => {
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'coordinator',
        toolNames: ['Agent', 'TaskOutput', 'Read'],
      })
      expect(out).toContain('You are a **Coordinator**')
      expect(out).toContain('delegate work via the `Agent` tool')
      // Role-matches-surface — no "prefer doing the work directly" line
      expect(out).not.toContain('prefer doing the work directly')
      expect(out).not.toContain('Do NOT use `SendMessage`')
    })
  })

  describe('verifier role', () => {
    it('mandates VERDICT format and read-only', () => {
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'verifier',
        toolNames: ['Read', 'Grep'],
      })
      expect(out).toContain('VERDICT: PASS')
      expect(out).toContain('VERDICT: FAIL')
      expect(out).toContain('READ-ONLY')
    })
  })

  describe('readonly-worker role', () => {
    it('emits read-only directive', () => {
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'readonly-worker',
        toolNames: ['Read', 'Grep'],
      })
      expect(out).toContain('Read-only Worker')
      expect(out).toContain('do not Edit/Write')
    })
  })

  describe('writing-worker role', () => {
    it('emits writing-worker directive and "do NOT use SendMessage" when no spawn tools', () => {
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'writing-worker',
        toolNames: ['Read', 'Edit', 'Bash'],
      })
      expect(out).toContain('Writing Worker')
      expect(out).toContain('Do NOT use `SendMessage`')
    })

    it('emits "prefer doing the work directly" when worker has spawn tools', () => {
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'writing-worker',
        toolNames: ['Read', 'Edit', 'Agent'],
      })
      expect(out).toContain('prefer doing the work directly')
      expect(out).not.toContain('Do NOT use `SendMessage`')
    })
  })

  describe('tool-name normalization', () => {
    it('recognizes snake_case tool names', () => {
      // `send_message` / `task_output` are aliased forms — should still
      // count as messaging / spawn tools for the surface check.
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'writing-worker',
        toolNames: ['read', 'edit', 'send_message'],
      })
      expect(out).toContain('prefer doing the work directly')
    })
  })

  describe('isReadOnly honored on writing-worker', () => {
    it('writing-worker + isReadOnly produces an extra read-only bullet', () => {
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'writing-worker',
        isReadOnly: true,
        toolNames: ['Read', 'Edit'],
      })
      expect(out).toContain('Configured READ-ONLY')
    })

    it('readonly-worker does NOT double up the read-only line', () => {
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'readonly-worker',
        isReadOnly: true,
        toolNames: ['Read'],
      })
      // The role's own line covers it — the extra "Configured READ-ONLY"
      // bullet should not appear (avoid duplicate noise).
      expect(out).not.toContain('Configured READ-ONLY')
    })
  })

  describe('phase + budget surfacing', () => {
    it('coordinatorPhase produces a phase bullet', () => {
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'writing-worker',
        coordinatorPhase: 'implementation',
        toolNames: ['Edit'],
      })
      expect(out).toContain('Pipeline phase: `implementation`')
    })

    it('maxTurns produces an iteration budget bullet', () => {
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'writing-worker',
        maxTurns: 80,
        toolNames: ['Edit'],
      })
      expect(out).toContain('max **80** turns')
    })

    it('zero / negative maxTurns suppresses the budget line', () => {
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'writing-worker',
        maxTurns: 0,
        toolNames: ['Edit'],
      })
      expect(out).not.toContain('Iteration budget')
    })
  })

  describe('inference fallback for legacy bundles', () => {
    it('bundle agent with no metadata defaults to writing-worker contract', () => {
      // The realistic case: imported industry bundle with only
      // promptSections — no isReadOnly, no role, no phase.
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        toolNames: ['Read', 'Edit', 'Bash'],
      })
      expect(out).toContain('Writing Worker')
      expect(out).toContain('Do NOT use `SendMessage`')
    })
  })

  describe('output shape', () => {
    it('starts with "\\n\\n## Orchestration Contract" so callers can concatenate blindly', () => {
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'writing-worker',
        toolNames: ['Edit'],
      })
      expect(out.startsWith('\n\n## Orchestration Contract')).toBe(true)
    })

    it('uses bullet-list formatting for each line', () => {
      const out = buildOrchestrationContractAppend({
        source: 'custom',
        orchestrationRole: 'writing-worker',
        coordinatorPhase: 'implementation',
        maxTurns: 50,
        toolNames: ['Edit'],
      })
      const bulletCount = (out.match(/^- /gm) ?? []).length
      // role + phase + tool-surface + budget = 4 bullets
      expect(bulletCount).toBe(4)
    })
  })
})
