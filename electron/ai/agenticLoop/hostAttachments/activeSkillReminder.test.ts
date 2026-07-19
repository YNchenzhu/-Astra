/**
 * Unit tests for the active-skill reminder collector
 * (skill-adherence audit, 2026-06).
 *
 * Covers the gating contract:
 *   - inline skill session must be active
 *   - cadence: ≥ TURNS_SINCE_SKILL_LOAD assistant turns since the Skill
 *     tool_use, ≥ TURNS_BETWEEN_REMINDERS since the previous reminder
 *   - env kill-switch POLE_ACTIVE_SKILL_REMINDER=0
 * and the rendered body shape (bracket marker first line, binding-
 * directive wording, end_inline_skill_session escape hatch).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activeSkillReminderCollector,
  computeSkillTurnCounts,
  renderActiveSkillReminderBody,
  TURNS_BETWEEN_REMINDERS,
  TURNS_SINCE_SKILL_LOAD,
} from './activeSkillReminder'
import { makeAttachmentFixture, expectPushMessageAction } from './testFixtures'
import {
  SIDE_CHANNEL_KIND,
  makeSideChannelUserMessage,
} from '../../../constants/sideChannelKinds'

function assistantTextTurn(text = 'working'): Record<string, unknown> {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

function assistantSkillCallTurn(): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_skill', name: 'Skill', input: { skill: 'my-flow' } }],
  }
}

/** Skill call followed by `n` plain assistant turns. */
function historyWithTurnsSinceSkill(n: number): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [
    { role: 'user', content: 'use the skill please' },
    assistantSkillCallTurn(),
  ]
  for (let i = 0; i < n; i++) messages.push(assistantTextTurn(`turn ${i}`))
  return messages
}

function makeCtx(
  apiMessages: Array<Record<string, unknown>>,
  // `null` = no active session; defaults to an active 'my-flow' session.
  skillName: string | null = 'my-flow',
) {
  return makeAttachmentFixture({
    apiMessages,
    iteration: 5,
    stateOverrides: {
      activeInlineSkillSession: skillName ? { skillName } : null,
    },
  })
}

describe('computeSkillTurnCounts', () => {
  it('counts assistant turns since the Skill call (the call turn itself is 0)', () => {
    const counts = computeSkillTurnCounts(historyWithTurnsSinceSkill(3))
    expect(counts.turnsSinceSkillLoad).toBe(3)
  })

  it('skips thinking-only assistant frames', () => {
    const messages = historyWithTurnsSinceSkill(2)
    messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] })
    expect(computeSkillTurnCounts(messages).turnsSinceSkillLoad).toBe(2)
  })

  it('tracks the most recent reminder of this kind via side-channel detection', () => {
    const messages = historyWithTurnsSinceSkill(4)
    messages.push(
      makeSideChannelUserMessage(
        SIDE_CHANNEL_KIND.activeSkillReminder,
        '[Active skill reminder]\nbody',
      ),
    )
    messages.push(assistantTextTurn('after reminder'))
    const counts = computeSkillTurnCounts(messages)
    expect(counts.turnsSinceLastReminder).toBe(1)
    expect(counts.turnsSinceSkillLoad).toBe(5)
  })
})

describe('activeSkillReminderCollector gating', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('fires once both cadence gates pass', async () => {
    const ctx = makeCtx(historyWithTurnsSinceSkill(TURNS_SINCE_SKILL_LOAD))
    const action = expectPushMessageAction(await activeSkillReminderCollector.run(ctx))
    const content = String(action.message.content)
    expect(content).toContain('[Active skill reminder]')
    expect(content).toContain('my-flow')
    expect(content).toContain('<skill-instructions')
    expect(content).toContain('end_inline_skill_session')
  })

  it('stays silent when no inline skill session is active', async () => {
    const ctx = makeCtx(historyWithTurnsSinceSkill(TURNS_SINCE_SKILL_LOAD), null)
    expect(await activeSkillReminderCollector.run(ctx)).toBeNull()
  })

  it('stays silent below the turns-since-load cadence', async () => {
    const ctx = makeCtx(historyWithTurnsSinceSkill(TURNS_SINCE_SKILL_LOAD - 1))
    expect(await activeSkillReminderCollector.run(ctx)).toBeNull()
  })

  it('throttles repeat reminders within TURNS_BETWEEN_REMINDERS', async () => {
    const messages = historyWithTurnsSinceSkill(TURNS_SINCE_SKILL_LOAD)
    messages.push(
      makeSideChannelUserMessage(
        SIDE_CHANNEL_KIND.activeSkillReminder,
        '[Active skill reminder]\nearlier reminder',
      ),
    )
    // A couple of turns after the reminder — below the reminder cadence,
    // even though turns-since-load keeps growing.
    for (let i = 0; i < TURNS_BETWEEN_REMINDERS - 1; i++) {
      messages.push(assistantTextTurn(`post-reminder ${i}`))
    }
    const ctx = makeCtx(messages)
    expect(await activeSkillReminderCollector.run(ctx)).toBeNull()
  })

  it('fires again once the reminder cadence elapses', async () => {
    const messages = historyWithTurnsSinceSkill(TURNS_SINCE_SKILL_LOAD)
    messages.push(
      makeSideChannelUserMessage(
        SIDE_CHANNEL_KIND.activeSkillReminder,
        '[Active skill reminder]\nearlier reminder',
      ),
    )
    for (let i = 0; i < TURNS_BETWEEN_REMINDERS; i++) {
      messages.push(assistantTextTurn(`post-reminder ${i}`))
    }
    const ctx = makeCtx(messages)
    expectPushMessageAction(await activeSkillReminderCollector.run(ctx))
  })

  it('POLE_ACTIVE_SKILL_REMINDER=0 disables the collector', async () => {
    vi.stubEnv('POLE_ACTIVE_SKILL_REMINDER', '0')
    const ctx = makeCtx(historyWithTurnsSinceSkill(TURNS_SINCE_SKILL_LOAD))
    expect(await activeSkillReminderCollector.run(ctx)).toBeNull()
  })
})

describe('renderActiveSkillReminderBody', () => {
  it('starts with the bracket marker (disk-resume detection contract)', () => {
    const body = renderActiveSkillReminderBody('my-flow', null)
    expect(body.startsWith('[Active skill reminder]')).toBe(true)
  })

  it('includes the SKILL.md re-read hint only when a path is known', () => {
    const withPath = renderActiveSkillReminderBody('my-flow', '/skills/my-flow/SKILL.md')
    expect(withPath).toContain('/skills/my-flow/SKILL.md')
    expect(withPath).toContain('do NOT continue from memory')
    const withoutPath = renderActiveSkillReminderBody('my-flow', null)
    expect(withoutPath).not.toContain('read_file')
  })

  it('includes the bundled-resources pointer only when the skill ships resources', () => {
    const withResources = renderActiveSkillReminderBody('my-flow', null, {
      referenceCount: 2,
      scriptCount: 1,
    })
    expect(withResources).toContain('2 reference doc(s) under references/')
    expect(withResources).toContain('1 script(s) under scripts/')
    expect(withResources).toContain('do not reconstruct its content from memory')

    const noResources = renderActiveSkillReminderBody('my-flow', null, {
      referenceCount: 0,
      scriptCount: 0,
    })
    expect(noResources).not.toContain('reference doc(s)')
    expect(noResources).not.toContain('script(s) under')
  })
})
