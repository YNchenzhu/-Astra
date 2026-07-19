/**
 * Unit tests for the stale-todo nudge turn-counting algorithm —
 * upstream parity for `getTodoReminderTurnCounts` in
 * `src/utils/attachments.ts`.
 *
 * The collector itself is harder to unit-test without a full
 * `LoopState` mock; the turn-counting function is the part that
 * has the highest chance of off-by-one regressions and benefits
 * most from direct coverage.
 */

import { describe, expect, it } from 'vitest'
import { computeTurnCounts, hasRecentToolUse } from './staleTodoNudge'
import { hasGenuineHumanTurnSinceLastToolUse } from './messageHistoryQueries'
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

function assistantTodoWriteMsg(): Msg {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Updating todos.' },
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'TodoWrite',
        input: { todos: [] },
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

function staleTodoReminderMsg(): Msg {
  return makeSideChannelUserMessage(
    SIDE_CHANNEL_KIND.staleTodoNudge,
    'reminder body',
  )
}

describe('computeTurnCounts (stale-todo nudge)', () => {
  it('returns total assistant turns when no TodoWrite has ever fired', () => {
    const messages: Msg[] = [
      userMsg('hi'),
      assistantTextMsg('hello'),
      userMsg('ok'),
      assistantTextMsg('working'),
    ]
    const { turnsSinceLastTodoWrite, turnsSinceLastReminder } =
      computeTurnCounts(messages)
    expect(turnsSinceLastTodoWrite).toBe(2)
    expect(turnsSinceLastReminder).toBe(2)
  })

  it('counts 0 turns when the most recent assistant turn was the TodoWrite call (cc-haha invariant)', () => {
    const messages: Msg[] = [
      userMsg('first'),
      assistantTextMsg('a'),
      userMsg('second'),
      assistantTodoWriteMsg(),
    ]
    const { turnsSinceLastTodoWrite } = computeTurnCounts(messages)
    expect(turnsSinceLastTodoWrite).toBe(0)
  })

  it('counts assistant turns since the last TodoWrite call', () => {
    const messages: Msg[] = [
      userMsg('start'),
      assistantTodoWriteMsg(), // <- last TodoWrite
      userMsg('next'),
      assistantTextMsg('working'),
      userMsg('again'),
      assistantTextMsg('still working'),
    ]
    const { turnsSinceLastTodoWrite } = computeTurnCounts(messages)
    expect(turnsSinceLastTodoWrite).toBe(2)
  })

  it('skips thinking-only assistant messages (they are intermediate frames, not turns)', () => {
    const messages: Msg[] = [
      userMsg('start'),
      assistantTodoWriteMsg(),
      userMsg('next'),
      assistantThinkingOnlyMsg(), // does NOT count
      assistantTextMsg('a'),
      assistantThinkingOnlyMsg(), // does NOT count
      assistantTextMsg('b'),
    ]
    const { turnsSinceLastTodoWrite } = computeTurnCounts(messages)
    expect(turnsSinceLastTodoWrite).toBe(2)
  })

  it('detects the most recent stale-todo reminder and counts turns since', () => {
    const messages: Msg[] = [
      userMsg('start'),
      assistantTextMsg('a'),
      staleTodoReminderMsg(), // last reminder
      assistantTextMsg('b'),
      userMsg('reply'),
      assistantTextMsg('c'),
    ]
    const { turnsSinceLastReminder } = computeTurnCounts(messages)
    expect(turnsSinceLastReminder).toBe(2)
  })

  it('returns total assistant turns when no reminder has fired yet', () => {
    const messages: Msg[] = [
      assistantTextMsg('a'),
      assistantTextMsg('b'),
      assistantTextMsg('c'),
    ]
    const { turnsSinceLastReminder } = computeTurnCounts(messages)
    expect(turnsSinceLastReminder).toBe(3)
  })

  it('handles empty message list', () => {
    const { turnsSinceLastTodoWrite, turnsSinceLastReminder } =
      computeTurnCounts([])
    expect(turnsSinceLastTodoWrite).toBe(0)
    expect(turnsSinceLastReminder).toBe(0)
  })

  it('ignores other side-channel kinds when looking for the reminder marker', () => {
    const otherReminder = makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.compactionReminder,
      'compact body',
    )
    const messages: Msg[] = [
      userMsg('start'),
      otherReminder, // wrong kind — must not match
      assistantTextMsg('a'),
      assistantTextMsg('b'),
    ]
    const { turnsSinceLastReminder } = computeTurnCounts(messages)
    expect(turnsSinceLastReminder).toBe(2)
  })

  /**
   * 2026-05 audit regression — previously the only way to identify a
   * historical stale-todo reminder was the typed `_sideChannelKind`
   * flag. When `normalizeMessagesForAPI(..., { stripInternalMeta: true
   * })` ran against `state.apiMessages` (or when a transcript was
   * loaded from disk after restart), the flag was gone and the spec
   * had `marker: null`, so `readSideChannelKind` fell through to
   * `genericConvertedSystem`. `lastReminderFound` then stayed `false`
   * forever and the double-cadence throttle silently reduced to "fire
   * every 10 assistant turns". The fix paired the spec with a real
   * marker AND made `renderTodoListBody` emit that marker as the first
   * body line; this test pins both halves of that contract.
   */
  it('recovers the reminder via body marker when the typed flag has been stripped (resume-from-disk path)', () => {
    const tagged = makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.staleTodoNudge,
      // Mirrors what `renderTodoListBody` actually emits — leading
      // bracket marker on its own line. If this body shape ever drifts
      // from the collector, this test will fail.
      "[Stale todo reminder]\nThe TodoWrite tool hasn't been used recently. body...",
    )
    // Simulate `stripInternalMeta: true` — drop the typed flag and the
    // `_convertedFromSystem` sibling, keep only the wire-visible shape.
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
    const { turnsSinceLastReminder } = computeTurnCounts(messages)
    expect(turnsSinceLastReminder).toBe(2)
  })
})

// 星构Astra coexist extension (2026-05): cross-surface mute heuristic
// shared by both stale-{todo,task} nudges. Direct unit tests for the
// exported `hasRecentToolUse` helper — the collector-level wiring is
// trivial (one boolean check before returning null) so coverage here
// is what protects the heuristic from regressions.
function assistantToolUseMsg(name: string): Msg {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_x', name, input: {} }],
  }
}

describe('hasRecentToolUse (coexist cross-surface mute heuristic)', () => {
  it('returns false on empty messages', () => {
    expect(hasRecentToolUse([], ['TaskCreate'], 5)).toBe(false)
  })

  it('returns false when withinTurns is 0 (disable knob)', () => {
    const msgs: Msg[] = [assistantToolUseMsg('TaskCreate')]
    expect(hasRecentToolUse(msgs, ['TaskCreate'], 0)).toBe(false)
  })

  it('finds the tool when it is in the most recent assistant turn', () => {
    const msgs: Msg[] = [
      userMsg('hi'),
      assistantToolUseMsg('TaskCreate'),
    ]
    expect(hasRecentToolUse(msgs, ['TaskCreate'], 5)).toBe(true)
  })

  it('finds the tool within the window (3 turns ago, window 5)', () => {
    const msgs: Msg[] = [
      assistantToolUseMsg('TaskCreate'),
      userMsg('u1'),
      assistantTextMsg('a1'),
      userMsg('u2'),
      assistantTextMsg('a2'),
      userMsg('u3'),
      assistantTextMsg('a3'),
    ]
    expect(hasRecentToolUse(msgs, ['TaskCreate'], 5)).toBe(true)
  })

  it('returns false when the tool is OUTSIDE the window (6 turns ago, window 5)', () => {
    const msgs: Msg[] = [
      assistantToolUseMsg('TaskCreate'),
      assistantTextMsg('a1'),
      assistantTextMsg('a2'),
      assistantTextMsg('a3'),
      assistantTextMsg('a4'),
      assistantTextMsg('a5'),
      assistantTextMsg('a6'),
    ]
    expect(hasRecentToolUse(msgs, ['TaskCreate'], 5)).toBe(false)
  })

  it('matches any tool in the toolNames set', () => {
    const msgs: Msg[] = [assistantToolUseMsg('TaskUpdate')]
    expect(hasRecentToolUse(msgs, ['TaskCreate', 'TaskUpdate'], 5)).toBe(true)
  })

  it('does NOT match unrelated tools', () => {
    const msgs: Msg[] = [assistantToolUseMsg('Edit'), assistantToolUseMsg('Bash')]
    expect(hasRecentToolUse(msgs, ['TaskCreate', 'TaskUpdate'], 5)).toBe(false)
  })

  it('skips thinking-only assistant frames (does not count toward window)', () => {
    const msgs: Msg[] = [
      assistantToolUseMsg('TaskCreate'),
      // 5 thinking-only frames in between → must NOT consume the
      // window or push the TaskCreate out of range.
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't1' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't2' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't3' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't4' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't5' }] },
      assistantTextMsg('one real turn'),
    ]
    expect(hasRecentToolUse(msgs, ['TaskCreate'], 5)).toBe(true)
  })
})

// Fix B (2026-05): human-redirect suppression for the stale-todo nudge.
// This is the exact "测试 MemdirScan 但模型续跑 70-工具旧清单" failure mode —
// the human gave a narrow instruction after the last TodoWrite, so the
// resurfaced checklist must be muted.
describe('hasGenuineHumanTurnSinceLastToolUse (Fix B human-redirect mute)', () => {
  const TODO = ['TodoWrite']
  const TASKS = ['TaskCreate', 'TaskUpdate']

  it('returns true when a real human message follows the last TodoWrite', () => {
    const msgs: Msg[] = [
      userMsg('build the 70-tool test plan'),
      assistantTodoWriteMsg(), // last TodoWrite
      assistantTextMsg('done one tool'),
      userMsg('稍等，我只让你测试 MemdirScan'), // human redirect
    ]
    expect(hasGenuineHumanTurnSinceLastToolUse(msgs, TODO)).toBe(true)
  })

  it('returns false when the only activity since TodoWrite is autonomous (no human)', () => {
    const msgs: Msg[] = [
      userMsg('go'),
      assistantTodoWriteMsg(),
      assistantTextMsg('grinding 1'),
      assistantTextMsg('grinding 2'),
    ]
    expect(hasGenuineHumanTurnSinceLastToolUse(msgs, TODO)).toBe(false)
  })

  it('does NOT count host-injected side-channel user messages as human', () => {
    const msgs: Msg[] = [
      userMsg('go'),
      assistantTodoWriteMsg(),
      staleTodoReminderMsg(), // synthetic, _convertedFromSystem
      assistantTextMsg('still grinding'),
    ]
    expect(hasGenuineHumanTurnSinceLastToolUse(msgs, TODO)).toBe(false)
  })

  it('does NOT count side-channel users even after stripInternalMeta (body-marker path)', () => {
    const tagged = makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.staleTodoNudge,
      "[Stale todo reminder]\nbody",
    )
    const stripped: Msg = { role: tagged.role, content: tagged.content }
    const msgs: Msg[] = [
      userMsg('go'),
      assistantTodoWriteMsg(),
      stripped,
      assistantTextMsg('grinding'),
    ]
    expect(hasGenuineHumanTurnSinceLastToolUse(msgs, TODO)).toBe(false)
  })

  it('returns true when there is a human message and no planning tool_use at all', () => {
    const msgs: Msg[] = [userMsg('hi'), assistantTextMsg('hello')]
    expect(hasGenuineHumanTurnSinceLastToolUse(msgs, TODO)).toBe(true)
  })

  it('returns false for empty history', () => {
    expect(hasGenuineHumanTurnSinceLastToolUse([], TODO)).toBe(false)
  })

  it('V2 variant: human redirect after TaskCreate/TaskUpdate is detected', () => {
    const msgs: Msg[] = [
      userMsg('plan the migration'),
      assistantToolUseMsg('TaskCreate'),
      assistantTextMsg('created tasks'),
      userMsg('actually just do step 1'), // human redirect
    ]
    expect(hasGenuineHumanTurnSinceLastToolUse(msgs, TASKS)).toBe(true)
  })

  it('V2 variant: autonomous grinding after TaskUpdate is NOT a human turn', () => {
    const msgs: Msg[] = [
      userMsg('go'),
      assistantToolUseMsg('TaskUpdate'),
      assistantTextMsg('grinding'),
    ]
    expect(hasGenuineHumanTurnSinceLastToolUse(msgs, TASKS)).toBe(false)
  })
})
