/**
 * Unit tests for the V2 stale-task nudge turn-counting algorithm.
 * Mirrors `staleTodoNudge.test.ts` — same invariants apply (only
 * the triggering tool names differ: TaskCreate / TaskUpdate vs
 * TodoWrite).
 */

import { describe, expect, it } from 'vitest'
import { computeTaskTurnCounts } from './staleTaskNudge'
import {
  makeSideChannelUserMessage,
  SIDE_CHANNEL_KIND,
} from '../../../constants/sideChannelKinds'

type Msg = Record<string, unknown>

function userMsg(content: string): Msg {
  return { role: 'user', content }
}

function assistantTextMsg(text: string): Msg {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  }
}

function assistantWithTool(name: string): Msg {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: `calling ${name}` },
      {
        type: 'tool_use',
        id: `tu_${name}`,
        name,
        input: {},
      },
    ],
  }
}

function assistantThinkingOnlyMsg(): Msg {
  return {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'Hmm…' }],
  }
}

function staleTaskReminderMsg(): Msg {
  return makeSideChannelUserMessage(
    SIDE_CHANNEL_KIND.staleTaskNudge,
    'reminder body',
  )
}

describe('computeTaskTurnCounts (stale-task nudge)', () => {
  it('returns total assistant turns when no TaskCreate/TaskUpdate has fired', () => {
    const messages: Msg[] = [
      userMsg('hi'),
      assistantTextMsg('hello'),
      userMsg('ok'),
      assistantTextMsg('working'),
    ]
    const { turnsSinceLastTaskActivity, turnsSinceLastReminder } =
      computeTaskTurnCounts(messages)
    expect(turnsSinceLastTaskActivity).toBe(2)
    expect(turnsSinceLastReminder).toBe(2)
  })

  it('counts 0 turns when the most recent assistant turn called TaskCreate', () => {
    const messages: Msg[] = [
      userMsg('first'),
      assistantTextMsg('a'),
      userMsg('second'),
      assistantWithTool('TaskCreate'),
    ]
    const { turnsSinceLastTaskActivity } = computeTaskTurnCounts(messages)
    expect(turnsSinceLastTaskActivity).toBe(0)
  })

  it('counts 0 turns when the most recent assistant turn called TaskUpdate', () => {
    const messages: Msg[] = [
      userMsg('first'),
      assistantWithTool('TaskUpdate'),
    ]
    const { turnsSinceLastTaskActivity } = computeTaskTurnCounts(messages)
    expect(turnsSinceLastTaskActivity).toBe(0)
  })

  it('treats TaskCreate AND TaskUpdate as equally "fresh activity"', () => {
    // Most recent activity is a TaskUpdate after several other turns;
    // distance should be 0 (TaskUpdate counts as the freshener).
    const messages: Msg[] = [
      assistantWithTool('TaskCreate'),
      userMsg('a'),
      assistantTextMsg('b'),
      userMsg('c'),
      assistantWithTool('TaskUpdate'),
    ]
    const { turnsSinceLastTaskActivity } = computeTaskTurnCounts(messages)
    expect(turnsSinceLastTaskActivity).toBe(0)
  })

  it('counts assistant turns since the last task activity', () => {
    const messages: Msg[] = [
      userMsg('start'),
      assistantWithTool('TaskCreate'), // last activity
      userMsg('next'),
      assistantTextMsg('working'),
      userMsg('again'),
      assistantTextMsg('still working'),
    ]
    const { turnsSinceLastTaskActivity } = computeTaskTurnCounts(messages)
    expect(turnsSinceLastTaskActivity).toBe(2)
  })

  it('skips thinking-only assistant messages', () => {
    const messages: Msg[] = [
      assistantWithTool('TaskCreate'),
      userMsg('next'),
      assistantThinkingOnlyMsg(), // does NOT count
      assistantTextMsg('a'),
      assistantThinkingOnlyMsg(), // does NOT count
      assistantTextMsg('b'),
    ]
    const { turnsSinceLastTaskActivity } = computeTaskTurnCounts(messages)
    expect(turnsSinceLastTaskActivity).toBe(2)
  })

  it('does not treat unrelated tools as task activity', () => {
    const messages: Msg[] = [
      assistantWithTool('TaskCreate'),
      assistantWithTool('Bash'),
      assistantWithTool('read_file'),
      assistantTextMsg('done'),
    ]
    const { turnsSinceLastTaskActivity } = computeTaskTurnCounts(messages)
    expect(turnsSinceLastTaskActivity).toBe(3)
  })

  it('detects most recent stale-task reminder and counts turns since', () => {
    const messages: Msg[] = [
      userMsg('start'),
      assistantTextMsg('a'),
      staleTaskReminderMsg(),
      assistantTextMsg('b'),
      userMsg('reply'),
      assistantTextMsg('c'),
    ]
    const { turnsSinceLastReminder } = computeTaskTurnCounts(messages)
    expect(turnsSinceLastReminder).toBe(2)
  })

  it('ignores other side-channel kinds when looking for the reminder marker', () => {
    const otherReminder = makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.staleTodoNudge, // wrong kind for V2 collector
      'v1 reminder body',
    )
    const messages: Msg[] = [
      otherReminder,
      assistantTextMsg('a'),
      assistantTextMsg('b'),
    ]
    const { turnsSinceLastReminder } = computeTaskTurnCounts(messages)
    expect(turnsSinceLastReminder).toBe(2)
  })

  /**
   * 2026-05 audit regression — mirrors the matching test in
   * `staleTodoNudge.test.ts`. See that file for the full rationale.
   */
  it('recovers the reminder via body marker when the typed flag has been stripped (resume-from-disk path)', () => {
    const tagged = makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.staleTaskNudge,
      "[Stale task reminder]\nThe task tools haven't been used recently. body...",
    )
    const stripped: Msg = {
      role: tagged.role,
      content: tagged.content,
    }
    const messages: Msg[] = [
      userMsg('start'),
      assistantTextMsg('a'),
      stripped,
      assistantTextMsg('b'),
      userMsg('reply'),
      assistantTextMsg('c'),
    ]
    const { turnsSinceLastReminder } = computeTaskTurnCounts(messages)
    expect(turnsSinceLastReminder).toBe(2)
  })

  it('handles empty message list', () => {
    const { turnsSinceLastTaskActivity, turnsSinceLastReminder } =
      computeTaskTurnCounts([])
    expect(turnsSinceLastTaskActivity).toBe(0)
    expect(turnsSinceLastReminder).toBe(0)
  })
})
