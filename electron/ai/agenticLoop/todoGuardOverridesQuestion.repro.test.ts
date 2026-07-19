/**
 * Regression — `todoGuardOverrodeQuestion` interaction, FIXED via Plan A.
 *
 * Before the fix: when the main chat had an open TodoWrite item and the model
 * ended a turn with a VISIBLE QUESTION to the user (no tool call), the
 * active-todo panel guard (row 12a) fired and forced a `continue`, so the
 * question never yielded the turn back to the user.
 *
 * Plan A: `buildActiveTodoPanelGuardSignal` now takes the current turn's
 * visible text and exempts genuine question / clarification tails (shared
 * `isUserQuestionTail` with the declared-intent guard). A clarifying question
 * yields the turn (`completed`) even with open todos; the todos stay in the
 * panel for when the user replies. Completion-claim tails are deliberately NOT
 * exempt — a "done" claim with open todos still warrants the nudge.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { buildActiveTodoPanelGuardSignal } from './noTools'
import { decideIterationOutcome } from './iterationDecision'
import { setTodos, resetTodos, type TodoItem } from '../../tools/TodoWriteTool'
import { runWithAgentContext } from '../../agents/agentContext'
import type { StopFamilyHookOutcome } from '../../tools/hooks/engine'

const QUESTION = '需要我对哪个子系统展开分析，或者开始编制某个方向的文档？'
const WORK_TEXT = '我整理了一下当前进度，接着把剩余模块逐个核对。'
const COMPLETION_TEXT = '所有改造已全部完成。'
const neutral: StopFamilyHookOutcome = { kind: 'neutral' }

const openTodo: TodoItem = {
  content: '梳理 orchestration 子系统',
  status: 'in_progress',
  activeForm: '正在梳理 orchestration 子系统',
}

function asMainCtx(): Parameters<typeof runWithAgentContext>[0] {
  return { agentId: 'main' } as unknown as Parameters<typeof runWithAgentContext>[0]
}

const AUTONOMOUS_HISTORY = [
  { role: 'user', content: '帮我分析这个工作区程序' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: {} }] },
]

function guardFor(text: string) {
  return runWithAgentContext(asMainCtx(), () =>
    buildActiveTodoPanelGuardSignal(AUTONOMOUS_HISTORY, text),
  )
}

function decideTurn(todoGuard: { itemCount: number; directiveBody: string } | undefined) {
  return decideIterationOutcome({
    noToolUse: {
      interAgentInjected: false,
      stopHook: neutral,
      stopHookActiveSkipped: false,
      circuitBreakerWouldTrip: false,
      ...(todoGuard ? { activeTodoPanelGuard: todoGuard } : {}),
    },
  })
}

afterEach(() => {
  resetTodos('main')
})

describe('Plan A: a clarifying question yields the turn even with open todos', () => {
  it('open todos + a QUESTION turn → guard does NOT fire → `completed` (yields to user)', () => {
    setTodos('main', [openTodo])
    const guard = guardFor(QUESTION)
    expect(guard).toBeUndefined() // exempted by the question tail

    const outcome = decideTurn(guard)
    expect(outcome.kind).toBe('terminate')
    if (outcome.kind === 'terminate') expect(outcome.reason).toBe('completed')
  })

  it('open todos + non-question WORK text → guard STILL fires → `continue` (unchanged)', () => {
    setTodos('main', [openTodo])
    const guard = guardFor(WORK_TEXT)
    expect(guard).toBeDefined()
    expect(guard!.itemCount).toBe(1)

    const outcome = decideTurn(guard)
    expect(outcome.kind).toBe('continue')
    if (outcome.kind === 'continue') {
      expect(outcome.injectUserContent).toBe(guard!.directiveBody)
    }
  })

  it('open todos + a COMPLETION claim → guard STILL fires (false-done claim is NOT exempt)', () => {
    setTodos('main', [openTodo])
    const guard = guardFor(COMPLETION_TEXT)
    expect(guard).toBeDefined()
    expect(decideTurn(guard).kind).toBe('continue')
  })

  it('clarification phrasing without a "?" ("需要我…确认") is also exempt', () => {
    setTodos('main', [openTodo])
    const guard = guardFor('我先把方案列出来，需要你确认其中的取舍')
    expect(guard).toBeUndefined()
    expect(decideTurn(guard).kind).toBe('terminate')
  })

  it('empty visible text + open todos → guard STILL fires (no question to yield to)', () => {
    setTodos('main', [openTodo])
    const guard = guardFor('')
    expect(guard).toBeDefined()
  })

  it('CONTRAST: a question with no open todos → `completed` (unchanged baseline)', () => {
    resetTodos('main')
    const guard = guardFor(QUESTION)
    expect(guard).toBeUndefined()
    const outcome = decideTurn(guard)
    expect(outcome.kind).toBe('terminate')
    if (outcome.kind === 'terminate') expect(outcome.reason).toBe('completed')
  })
})
