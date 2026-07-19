/**
 * Tail-slot policy lock (2026-07 复审 item 6).
 *
 * `stream.ts` composes the four ephemeral tail re-surfacers in a FIXED
 * nesting; inner wrappers append first (furthest from generation), the
 * outermost appends last (closest). The unified policy, furthest →
 * closest:
 *
 *   completion-evidence protocol → verification-pending → active-skill
 *   recitation → goal recitation
 *
 * i.e. the user's GOAL always wins the recency contest; protocol rituals
 * sit furthest away. This test replicates the exact nesting from
 * `stream.ts` (update BOTH in the same commit if the policy changes) with
 * every gate forced open, and asserts the marker order in the tail.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../../agents/agentContext', () => ({
  getAgentContext: () => ({
    agentId: 'main',
    streamConversationId: 'conv-tail-order',
  }),
}))

vi.mock('../../tools/TodoWriteTool', () => ({
  getTodos: () => [
    { content: '修复 checkout 重试', status: 'in_progress', activeForm: '修复中' },
  ],
  getTodoObjective: () => 'User wants checkout retries fixed',
  getTodoObjectiveMeta: () => ({
    text: 'User wants checkout retries fixed',
    verified: true,
  }),
}))

vi.mock('../../tools/todoMode', () => ({
  isTodoV1Enabled: () => true,
  isTodoV2Enabled: () => true,
}))

vi.mock('../../tools/TaskManager', () => ({
  taskManager: { hasOpenTasks: () => false },
}))

vi.mock('../../skills/invokedSkillsRegistry', () => ({
  peekInvokedSkillRecordForAgent: () => ({
    skillName: 'my-skill',
    skillPath: 'g:/skills/my-skill',
    content: 'STEP 1: do the thing. STEP 2: verify the thing.',
  }),
}))

vi.mock('./hostAttachments/activeSkillReminder', () => ({
  computeSkillTurnCounts: () => ({
    turnsSinceSkillLoad: 10,
    turnsSinceLastReminder: 10,
  }),
}))

vi.mock('../../planning/verificationGateState', () => ({
  getVerificationGateState: () => ({
    needsVerification: true,
    mutationCount: 5,
    lastVerdict: undefined,
  }),
}))

// code-dev work package → verification gate + completion-evidence handshake
// both apply (N1 gating).
vi.mock('../../agents/bundles/bundleRegistryQueries', () => ({
  getActiveBundle: () => ({ meta: { id: 'code-dev' } }),
  getActiveBundleId: () => 'code-dev',
}))

import { GOAL_RECITATION_MARKER, withEphemeralGoalRecitation } from './goalRecitation'
import {
  ACTIVE_SKILL_RECITATION_MARKER,
  withEphemeralActiveSkillRecitation,
} from './activeSkillRecitation'
import {
  VERIFICATION_PENDING_REMINDER_MARKER,
  withEphemeralVerificationPendingReminder,
} from './verificationGate'
import {
  COMPLETION_EVIDENCE_REMINDER_MARKER,
  withEphemeralCompletionEvidenceReminder,
} from './completionEvidenceGate'

type Msg = Record<string, unknown>

/** EXACT nesting from `stream.ts` — keep in lockstep. */
function composeAsStreamPhase(messages: Msg[], iteration: number): Msg[] {
  return withEphemeralGoalRecitation(
    withEphemeralActiveSkillRecitation(
      withEphemeralVerificationPendingReminder(
        withEphemeralCompletionEvidenceReminder(messages, { turnUsedTools: true }),
      ),
      { activeSkillName: 'my-skill' },
    ),
    { iteration },
  )
}

function tailText(messages: Msg[]): string {
  const last = messages[messages.length - 1]!
  const c = last.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return (c as Msg[])
      .map((b) => (typeof b.text === 'string' ? (b.text as string) : ''))
      .join('\n')
  }
  return ''
}

beforeEach(() => {
  delete process.env.POLE_GOAL_RECITATION
  delete process.env.POLE_ACTIVE_SKILL_RECITATION
  delete process.env.POLE_VERIFICATION_GATE
  delete process.env.POLE_COMPLETION_EVIDENCE_GATE
})

describe('ephemeral tail-slot order (stream.ts composition lock)', () => {
  it('orders the tail furthest→closest: evidence < verification < skill < goal', () => {
    const base: Msg[] = [{ role: 'user', content: '修复 checkout 的重试逻辑' }]
    const out = composeAsStreamPhase(base, 3)
    const text = tailText(out)

    const evidenceIdx = text.indexOf(COMPLETION_EVIDENCE_REMINDER_MARKER)
    const verificationIdx = text.indexOf(VERIFICATION_PENDING_REMINDER_MARKER)
    const skillIdx = text.indexOf(ACTIVE_SKILL_RECITATION_MARKER)
    const goalIdx = text.indexOf(GOAL_RECITATION_MARKER)

    // All four fired (gates forced open by the mocks).
    expect(evidenceIdx).toBeGreaterThan(-1)
    expect(verificationIdx).toBeGreaterThan(-1)
    expect(skillIdx).toBeGreaterThan(-1)
    expect(goalIdx).toBeGreaterThan(-1)

    // The policy: goal recitation is CLOSEST to generation (last), the
    // completion-evidence protocol is FURTHEST.
    expect(evidenceIdx).toBeLessThan(verificationIdx)
    expect(verificationIdx).toBeLessThan(skillIdx)
    expect(skillIdx).toBeLessThan(goalIdx)
  })

  it('never mutates the persisted transcript (ephemeral contract)', () => {
    const base: Msg[] = [{ role: 'user', content: '修复 checkout 的重试逻辑' }]
    const snapshot = JSON.parse(JSON.stringify(base)) as Msg[]
    composeAsStreamPhase(base, 3)
    expect(base).toEqual(snapshot)
  })

  // ── F4 (2026-07 会话审计) — SOURCE lock on stream.ts itself ──────────
  // The behavioural test above replicates the nesting; this one scans the
  // production composition in stream.ts so a unilateral reorder there
  // fails CI even if this file's replica is forgotten (same pattern as
  // loopEvents.test.ts's transition-writer audit).
  it('stream.ts composes the wrappers in the locked nesting order (source scan)', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'stream.ts'),
      'utf8',
    )
    const anchor = source.indexOf('const messagesForRequest =')
    expect(anchor, 'composition anchor missing from stream.ts').toBeGreaterThan(-1)
    const region = source.slice(anchor, anchor + 1_200)

    const goal = region.indexOf('withEphemeralGoalRecitation(')
    const skill = region.indexOf('withEphemeralActiveSkillRecitation(')
    const verification = region.indexOf('withEphemeralVerificationPendingReminder(')
    const evidence = region.indexOf('withEphemeralCompletionEvidenceReminder(')

    expect(goal).toBeGreaterThan(-1)
    expect(skill).toBeGreaterThan(-1)
    expect(verification).toBeGreaterThan(-1)
    expect(evidence).toBeGreaterThan(-1)

    // Outermost appears FIRST in source (appends LAST → closest to
    // generation). Locked policy: goal ⊃ skill ⊃ verification ⊃ evidence.
    expect(goal).toBeLessThan(skill)
    expect(skill).toBeLessThan(verification)
    expect(verification).toBeLessThan(evidence)

    // The innermost wrapper must consume the persisted transcript.
    expect(region).toContain('withEphemeralCompletionEvidenceReminder(state.apiMessages')
  })
})
