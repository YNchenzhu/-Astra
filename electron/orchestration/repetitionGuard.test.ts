/**
 * Unit tests for the cross-agent repetition guard.
 *
 * Two surfaces under test:
 *   1. `createRepetitionGuard` — pure factory; each test gets its own
 *      instance, no singleton interference.
 *   2. `getRepetitionGuard` / `resetRepetitionGuardForTests` — the
 *      process-wide singleton, with explicit reset between cases.
 *
 * The fingerprint logic itself is tested in `toolCallHistory` already, so
 * here we focus on count thresholds, reset semantics, and the
 * advisory-message shape.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Cycle-layer windows are scoped by ALS agent id (audit fix 2026-07);
// default the mock to 'main' so all pre-existing tests behave as a single
// agent. The interleave test overrides per call.
const mockGetAgentContext = vi.fn<() => { agentId?: string } | undefined>(() => ({
  agentId: 'main',
}))
vi.mock('../agents/agentContext', () => ({
  getAgentContext: () => mockGetAgentContext(),
}))

import {
  createRepetitionGuard,
  getRepetitionGuard,
  resetRepetitionGuardForTests,
} from './repetitionGuard'

beforeEach(() => {
  mockGetAgentContext.mockReturnValue({ agentId: 'main' })
})

describe('createRepetitionGuard', () => {
  it('allows the first call and the second identical call', () => {
    const g = createRepetitionGuard()
    expect(g.check('Bash', { command: 'echo ok' })).toEqual({ level: 'allow' })
    g.record('Bash', { command: 'echo ok' })
    expect(g.check('Bash', { command: 'echo ok' })).toEqual({ level: 'allow' })
  })

  it('warns at the configured warn threshold', () => {
    const g = createRepetitionGuard({ warnThreshold: 3, haltThreshold: 5 })
    g.record('Bash', { command: 'echo ok' })
    g.record('Bash', { command: 'echo ok' })
    const advice = g.check('Bash', { command: 'echo ok' })
    expect(advice.level).toBe('warn')
    if (advice.level === 'warn') {
      expect(advice.consecutiveCount).toBe(3)
      expect(advice.message).toMatch(/3rd consecutive/)
      expect(advice.message).toMatch(/Repetition guard/)
    }
  })

  it('halts at the configured halt threshold', () => {
    const g = createRepetitionGuard({ warnThreshold: 3, haltThreshold: 5 })
    for (let i = 0; i < 4; i++) g.record('Bash', { command: 'echo ok' })
    const advice = g.check('Bash', { command: 'echo ok' })
    expect(advice.level).toBe('halt')
    if (advice.level === 'halt') {
      expect(advice.consecutiveCount).toBe(5)
      expect(advice.message).toMatch(/Refusing to execute `Bash`/)
      expect(advice.message).toMatch(/5 times in a row/)
    }
  })

  it('resets the count when a different fingerprint comes in', () => {
    const g = createRepetitionGuard({ warnThreshold: 3, haltThreshold: 5 })
    g.record('Bash', { command: 'echo ok' })
    g.record('Bash', { command: 'echo ok' })
    g.record('Bash', { command: 'echo ok' })
    // Third record put us at warn-threshold for `echo ok`.
    expect(g.check('Bash', { command: 'echo ok' }).level).toBe('warn')
    // Different command resets.
    g.record('Bash', { command: 'echo different' })
    expect(g.snapshot().count).toBe(1)
    expect(g.check('Bash', { command: 'echo different' }).level).toBe('allow')
  })

  it('treats argument permutations / transient fields as the same call', () => {
    // `toolCallHistory.canonicalizeToolInput` strips transient ids and sorts
    // keys, so {a:1,b:2} and {b:2,a:1,taskId:'x'} fingerprint identically.
    const g = createRepetitionGuard({ warnThreshold: 3, haltThreshold: 5 })
    g.record('Bash', { a: 1, b: 2 })
    g.record('Bash', { b: 2, a: 1, taskId: 'transient-1' })
    const advice = g.check('Bash', { taskId: 'transient-2', a: 1, b: 2 })
    expect(advice.level).toBe('warn')
    if (advice.level === 'warn') expect(advice.consecutiveCount).toBe(3)
  })

  it('check is non-mutating', () => {
    const g = createRepetitionGuard()
    g.check('Bash', { command: 'x' })
    g.check('Bash', { command: 'x' })
    g.check('Bash', { command: 'x' })
    g.check('Bash', { command: 'x' })
    g.check('Bash', { command: 'x' })
    expect(g.snapshot().count).toBe(0)
  })

  it('clamps a misconfigured haltThreshold ≤ warnThreshold', () => {
    // halt=3 ≤ warn=5 is invalid; constructor must coerce warn down so
    // halt fires at 3 and warn at 2 (or wherever the clamp lands).
    const g = createRepetitionGuard({ warnThreshold: 5, haltThreshold: 3 })
    g.record('Bash', { command: 'x' })
    g.record('Bash', { command: 'x' })
    const advice = g.check('Bash', { command: 'x' })
    expect(advice.level).toBe('halt')
  })

  it('floors halt threshold at 2 even when configured as 1', () => {
    // halt=1 is clamped up to 2 (so the guard can't halt the very first
    // call ever issued — that would be unusable). With warn defaulted to
    // 1 in this config, the first call projects to count=1 → warn level.
    const g = createRepetitionGuard({ warnThreshold: 1, haltThreshold: 1 })
    expect(g.check('Bash', { command: 'x' }).level).toBe('warn')
    g.record('Bash', { command: 'x' })
    // Second identical call → projected count = 2 → halt.
    expect(g.check('Bash', { command: 'x' }).level).toBe('halt')
  })

  it('reset() clears the count', () => {
    const g = createRepetitionGuard()
    g.record('Bash', { command: 'x' })
    g.record('Bash', { command: 'x' })
    g.reset()
    expect(g.snapshot().count).toBe(0)
    expect(g.check('Bash', { command: 'x' }).level).toBe('allow')
  })
})

describe('cycle layer — length-2..4 trailing cycles', () => {
  it('never fired under the legacy single-fingerprint logic: A→B alternation now warns', () => {
    const g = createRepetitionGuard()
    // A B A B recorded; the 5th call (A) projects [A,B,A,B,A] → the
    // trailing period-2 block [B,A] has repeated 2 full times → warn.
    g.record('Bash', { command: 'npm test' })
    g.record('read_file', { path: 'out.log' })
    g.record('Bash', { command: 'npm test' })
    g.record('read_file', { path: 'out.log' })
    const advice = g.check('Bash', { command: 'npm test' })
    expect(advice.level).toBe('warn')
    if (advice.level === 'warn') {
      expect(advice.consecutiveCount).toBe(2)
      expect(advice.message).toMatch(/2-call cycle/)
      expect(advice.message).toMatch(/`read_file` → `Bash`/)
    }
  })

  it('halts once the cycle completes the configured repeat count', () => {
    const g = createRepetitionGuard()
    // A B A B A recorded; the 6th call (B) projects a 3rd full repeat → halt.
    g.record('Bash', { command: 'npm test' })
    g.record('read_file', { path: 'out.log' })
    g.record('Bash', { command: 'npm test' })
    g.record('read_file', { path: 'out.log' })
    g.record('Bash', { command: 'npm test' })
    const advice = g.check('read_file', { path: 'out.log' })
    expect(advice.level).toBe('halt')
    if (advice.level === 'halt') {
      expect(advice.consecutiveCount).toBe(3)
      expect(advice.message).toMatch(/Refusing to execute/)
      expect(advice.message).toMatch(/3rd consecutive repetition/)
    }
  })

  it('does not treat a uniform block as a cycle (period-1 stays exact-layer territory)', () => {
    const g = createRepetitionGuard({ warnThreshold: 10, haltThreshold: 11 })
    // 6 identical calls: with the exact layer detuned, the cycle layer
    // must NOT fire on the all-same window (period 2 block [A,A] is
    // uniform and skipped).
    for (let i = 0; i < 6; i++) g.record('Bash', { command: 'echo ok' })
    expect(g.check('Bash', { command: 'echo ok' }).level).toBe('allow')
  })

  it('a materially different call breaks the cycle', () => {
    const g = createRepetitionGuard()
    g.record('Bash', { command: 'npm test' })
    g.record('read_file', { path: 'out.log' })
    g.record('Bash', { command: 'npm test' })
    g.record('read_file', { path: 'out.log' })
    // Different work interrupts the trailing repetition.
    g.record('edit_file', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' })
    expect(g.check('Bash', { command: 'npm test' }).level).toBe('allow')
  })

  it('audit fix: interleaved calls from DIFFERENT agents never compose a cycle', () => {
    // Agent A repeats call X; agent B repeats call Y, interleaved in real
    // time. The global sequence X,Y,X,Y,X must NOT read as one agent's
    // 2-cycle — each agent's own window sees only its uniform stream
    // (period-1 territory, exact layer's job).
    const g = createRepetitionGuard()
    const asAgent = (id: string) => mockGetAgentContext.mockReturnValue({ agentId: id })
    asAgent('agent-a'); g.record('Bash', { command: 'npm test' })
    asAgent('agent-b'); g.record('read_file', { path: 'out.log' })
    asAgent('agent-a'); g.record('Bash', { command: 'npm test' })
    asAgent('agent-b'); g.record('read_file', { path: 'out.log' })
    asAgent('agent-a'); g.record('Bash', { command: 'npm test' })
    asAgent('agent-b')
    expect(g.check('read_file', { path: 'out.log' }).level).toBe('allow')
    mockGetAgentContext.mockReturnValue({ agentId: 'main' })
  })

  it('detects longer (period-3) cycles too', () => {
    const g = createRepetitionGuard()
    const a: [string, unknown] = ['Bash', { command: 'npm test' }]
    const b: [string, unknown] = ['read_file', { path: 'out.log' }]
    const c: [string, unknown] = ['Grep', { pattern: 'FAIL', path: 'out.log' }]
    g.record(...a); g.record(...b); g.record(...c)
    g.record(...a); g.record(...b)
    const advice = g.check(...c)
    expect(advice.level).toBe('warn')
    if (advice.level === 'warn') {
      expect(advice.message).toMatch(/3-call cycle/)
    }
  })
})

describe('normalized layer — same tool + target, varying arguments', () => {
  it('warns on the 5th consecutive read of the same path with different offsets', () => {
    const g = createRepetitionGuard()
    for (let i = 0; i < 4; i++) {
      g.record('read_file', { path: 'big.ts', offset: i * 100, limit: 100 })
    }
    const advice = g.check('read_file', { path: 'big.ts', offset: 400, limit: 100 })
    expect(advice.level).toBe('warn')
    if (advice.level === 'warn') {
      expect(advice.consecutiveCount).toBe(5)
      expect(advice.message).toMatch(/same target \(big\.ts\)/)
      expect(advice.message).toMatch(/minor argument variations/)
    }
  })

  it('halts at the normalized halt threshold', () => {
    const g = createRepetitionGuard({ normalizedWarnThreshold: 3, normalizedHaltThreshold: 5 })
    for (let i = 0; i < 4; i++) {
      g.record('read_file', { path: 'big.ts', offset: i * 100 })
    }
    const advice = g.check('read_file', { path: 'big.ts', offset: 999 })
    expect(advice.level).toBe('halt')
    if (advice.level === 'halt') {
      expect(advice.consecutiveCount).toBe(5)
      expect(advice.message).toMatch(/Refusing to execute `read_file`/)
    }
  })

  it('greps with the same path but different patterns stay distinct', () => {
    const g = createRepetitionGuard({ normalizedWarnThreshold: 3, normalizedHaltThreshold: 5 })
    g.record('Grep', { pattern: 'foo', path: 'electron' })
    g.record('Grep', { pattern: 'bar', path: 'electron' })
    // Different `pattern` → different normalized key → streak of 1 each.
    expect(g.check('Grep', { pattern: 'baz', path: 'electron' }).level).toBe('allow')
    expect(g.snapshot().normalized?.count).toBe(1)
  })

  it('a targetless call breaks the streak', () => {
    const g = createRepetitionGuard({ normalizedWarnThreshold: 3, normalizedHaltThreshold: 5 })
    g.record('read_file', { path: 'big.ts', offset: 0 })
    g.record('read_file', { path: 'big.ts', offset: 100 })
    g.record('TodoWrite', { todos: [] })
    g.record('read_file', { path: 'big.ts', offset: 200 })
    // Streak restarted after the targetless call: projected count 2 < warn 3.
    expect(g.check('read_file', { path: 'big.ts', offset: 300 }).level).toBe('allow')
  })

  it('exact-layer halt wins over the normalized warn on identical calls', () => {
    // 4 identical records → exact projects 5 (halt), normalized projects 5
    // (warn at default 5). Halt must be reported.
    const g = createRepetitionGuard()
    for (let i = 0; i < 4; i++) g.record('read_file', { path: 'a.ts' })
    const advice = g.check('read_file', { path: 'a.ts' })
    expect(advice.level).toBe('halt')
    if (advice.level === 'halt') {
      expect(advice.message).toMatch(/identical arguments/)
    }
  })

  it('reset() clears cycle window and normalized streak too', () => {
    const g = createRepetitionGuard()
    g.record('Bash', { command: 'npm test' })
    g.record('read_file', { path: 'out.log' })
    g.record('read_file', { path: 'out.log', offset: 5 })
    g.reset()
    const snap = g.snapshot()
    expect(snap.windowLength).toBe(0)
    expect(snap.normalized).toBeNull()
  })
})

describe('getRepetitionGuard singleton', () => {
  beforeEach(() => {
    resetRepetitionGuardForTests()
  })

  it('returns the same instance across calls', () => {
    const a = getRepetitionGuard()
    const b = getRepetitionGuard()
    expect(a).toBe(b)
  })

  it('persists state across getter calls until reset', () => {
    const a = getRepetitionGuard()
    a.record('Bash', { command: 'shared' })
    a.record('Bash', { command: 'shared' })
    const b = getRepetitionGuard()
    expect(b.snapshot().count).toBe(2)
    expect(b.snapshot().toolName).toBe('Bash')
    resetRepetitionGuardForTests()
    expect(getRepetitionGuard().snapshot().count).toBe(0)
  })

  it('honours options on first call only', () => {
    // First caller wins; subsequent options are dropped (documented behaviour).
    const a = getRepetitionGuard({ warnThreshold: 2, haltThreshold: 3 })
    const b = getRepetitionGuard({ warnThreshold: 99, haltThreshold: 999 })
    expect(a).toBe(b)
    a.record('Bash', { command: 'x' })
    expect(a.check('Bash', { command: 'x' }).level).toBe('warn')
    a.record('Bash', { command: 'x' })
    expect(a.check('Bash', { command: 'x' }).level).toBe('halt')
  })
})
