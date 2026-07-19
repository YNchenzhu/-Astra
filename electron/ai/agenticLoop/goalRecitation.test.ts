/**
 * Goal recitation (GAP 1, 2026-06 long-run hallucination audit) tests.
 *
 * Covers:
 *   - buildGoalRecitationText: renders open items, caps count + length,
 *     null when nothing is open
 *   - appendEphemeralGoalRecitation: string-content tail, block-array
 *     tail, non-user tail fallback, input immutability
 *   - withEphemeralGoalRecitation gating: env kill-switch, no active
 *     todos → same reference (no-op), non-main agent → no-op
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const mockGetAgentContext = vi.fn<() => { agentId?: string } | undefined>(() => undefined)
vi.mock('../../agents/agentContext', () => ({
  getAgentContext: () => mockGetAgentContext(),
}))

const mockIsTodoV1Enabled = vi.fn(() => true)
const mockIsTodoV2Enabled = vi.fn(() => true)
vi.mock('../../tools/todoMode', () => ({
  isTodoV1Enabled: () => mockIsTodoV1Enabled(),
  isTodoV2Enabled: () => mockIsTodoV2Enabled(),
}))

type TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }
let mockTodos: TodoItem[] = []
let mockObjective = ''
let mockObjectiveVerified = true
vi.mock('../../tools/TodoWriteTool', () => ({
  getTodos: () => mockTodos,
  getTodoObjective: () => mockObjective,
  getTodoObjectiveMeta: () =>
    mockObjective ? { text: mockObjective, verified: mockObjectiveVerified } : undefined,
}))

let mockHasOpenTasks = false
vi.mock('../../tools/TaskManager', () => ({
  taskManager: { hasOpenTasks: () => mockHasOpenTasks },
}))

import {
  GOAL_RECITATION_FALLBACK_MIN_ITERATION,
  GOAL_RECITATION_MARKER,
  MAX_RECITED_ITEMS,
  MAX_RECITED_ITEM_CHARS,
  MAX_RECITED_QUERY_CHARS,
  appendEphemeralGoalRecitation,
  buildGoalRecitationText,
  buildObjectiveOnlyRecitation,
  buildUserQueryRecitation,
  withEphemeralGoalRecitation,
} from './goalRecitation'

const todo = (
  content: string,
  status: TodoItem['status'] = 'pending',
): TodoItem => ({ content, status, activeForm: content })

beforeEach(() => {
  mockTodos = []
  mockObjective = ''
  mockObjectiveVerified = true
  mockHasOpenTasks = false
  mockGetAgentContext.mockReturnValue(undefined)
  mockIsTodoV1Enabled.mockReturnValue(true)
  mockIsTodoV2Enabled.mockReturnValue(true)
  delete process.env.POLE_GOAL_RECITATION
  delete process.env.POLE_GOAL_RECITATION_FALLBACK
})

afterEach(() => {
  delete process.env.POLE_GOAL_RECITATION
  delete process.env.POLE_GOAL_RECITATION_FALLBACK
})

describe('buildGoalRecitationText', () => {
  it('returns null when there are no open items', () => {
    expect(buildGoalRecitationText([])).toBeNull()
    expect(buildGoalRecitationText([todo('done', 'completed')])).toBeNull()
  })

  it('renders open items with status, counts, and the marker first line', () => {
    const text = buildGoalRecitationText([
      todo('Fix file 1', 'in_progress'),
      todo('Fix file 2'),
      todo('Already done', 'completed'),
    ])!
    expect(text.startsWith(GOAL_RECITATION_MARKER)).toBe(true)
    expect(text).toContain('- [in_progress] Fix file 1')
    expect(text).toContain('- [pending] Fix file 2')
    expect(text).not.toContain('Already done')
    expect(text).toContain('(2 open, 1 completed.)')
  })

  it('caps the number of rendered items and notes the overflow', () => {
    const todos = Array.from({ length: MAX_RECITED_ITEMS + 4 }, (_, i) =>
      todo(`item ${i}`),
    )
    const text = buildGoalRecitationText(todos)!
    expect(text).toContain(`item ${MAX_RECITED_ITEMS - 1}`)
    expect(text).not.toContain(`- [pending] item ${MAX_RECITED_ITEMS}\n`)
    expect(text).toContain('and 4 more open item(s)')
  })

  it('truncates pathologically long item content', () => {
    const text = buildGoalRecitationText([todo('x'.repeat(500), 'in_progress')])!
    const itemLine = text.split('\n').find((l) => l.startsWith('- [in_progress]'))!
    expect(itemLine.length).toBeLessThanOrEqual(
      MAX_RECITED_ITEM_CHARS + '- [in_progress] '.length,
    )
    expect(itemLine.endsWith('…')).toBe(true)
  })

  it('renders the underlying objective header when provided', () => {
    const text = buildGoalRecitationText(
      [todo('Fix it', 'in_progress')],
      'User wants checkout to stop dropping orders on timeout',
    )!
    expect(text).toContain(
      'Underlying objective (the user\'s ultimate goal): User wants checkout to stop dropping orders on timeout',
    )
  })

  it('omits the objective header when none is provided or blank', () => {
    expect(buildGoalRecitationText([todo('Fix it', 'in_progress')])!).not.toContain(
      'Underlying objective',
    )
    expect(
      buildGoalRecitationText([todo('Fix it', 'in_progress')], '   ')!,
    ).not.toContain('Underlying objective')
  })

  // ── 2026-07 复审 P0 fix — write-time verification framing ────────────
  it('renders an UNVERIFIED objective with candidate framing, not "ultimate goal"', () => {
    const text = buildGoalRecitationText(
      [todo('Fix it', 'in_progress')],
      { text: 'Assistant-invented purpose about something else', verified: false },
    )!
    expect(text).toContain('Working objective (assistant-inferred, NOT verified')
    expect(text).toContain('Assistant-invented purpose about something else')
    expect(text).not.toContain("the user's ultimate goal")
  })

  it('keeps the strong framing for a verified objective meta', () => {
    const text = buildGoalRecitationText(
      [todo('Fix it', 'in_progress')],
      { text: 'User wants checkout stable', verified: true },
    )!
    expect(text).toContain("Underlying objective (the user's ultimate goal): User wants checkout stable")
  })

  it('does not recite the objective when no items are open', () => {
    expect(buildGoalRecitationText([], 'some objective')).toBeNull()
  })
})

describe('buildObjectiveOnlyRecitation', () => {
  it('renders the objective with the marker and returns null when blank', () => {
    const text = buildObjectiveOnlyRecitation('Ship the migration safely')!
    expect(text.startsWith(GOAL_RECITATION_MARKER)).toBe(true)
    expect(text).toContain('Underlying objective')
    expect(text).toContain('Ship the migration safely')
    expect(buildObjectiveOnlyRecitation('')).toBeNull()
    expect(buildObjectiveOnlyRecitation('   ')).toBeNull()
    expect(buildObjectiveOnlyRecitation(undefined)).toBeNull()
  })
})

describe('appendEphemeralGoalRecitation', () => {
  it('appends to a string-content tail user message', () => {
    const messages = [{ role: 'user', content: 'original' }]
    const out = appendEphemeralGoalRecitation(messages, 'RECITE')
    expect(out).toHaveLength(1)
    expect(out[0].content).toContain('original')
    expect(out[0].content).toContain('RECITE')
    expect(out[0].content).toContain('<system-reminder>')
  })

  it('appends as a trailing text block to a block-array tail user message', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    ]
    const out = appendEphemeralGoalRecitation(messages, 'RECITE')
    const blocks = out[0].content as Array<Record<string, unknown>>
    expect(blocks).toHaveLength(2)
    expect(blocks[1].type).toBe('text')
    expect(blocks[1].text).toContain('RECITE')
  })

  it('pushes a standalone user message when the tail is an assistant message', () => {
    const messages = [{ role: 'assistant', content: 'thinking aloud' }]
    const out = appendEphemeralGoalRecitation(messages, 'RECITE')
    expect(out).toHaveLength(2)
    expect(out[1].role).toBe('user')
    expect(out[1].content).toContain('RECITE')
  })

  it('never mutates the input array or its messages', () => {
    const original = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]
    const snapshot = JSON.parse(JSON.stringify(original))
    appendEphemeralGoalRecitation(original, 'RECITE')
    expect(original).toEqual(snapshot)
  })
})

describe('withEphemeralGoalRecitation — gating', () => {
  const baseMessages = () => [{ role: 'user', content: 'task' }]

  it('appends the recitation when main chat has active todos', () => {
    mockTodos = [todo('Fix it', 'in_progress')]
    const messages = baseMessages()
    const out = withEphemeralGoalRecitation(messages)
    expect(out).not.toBe(messages)
    expect(String(out[0].content)).toContain(GOAL_RECITATION_MARKER)
  })

  it('surfaces the captured objective when main chat has active todos', () => {
    mockTodos = [todo('Fix it', 'in_progress')]
    mockObjective = 'User wants the build to stop flaking in CI'
    const out = withEphemeralGoalRecitation(baseMessages())
    expect(String(out[0].content)).toContain('Underlying objective')
    expect(String(out[0].content)).toContain('stop flaking in CI')
  })

  it('recites an UNVERIFIED objective with candidate framing (2026-07 复审)', () => {
    mockTodos = [todo('Fix it', 'in_progress')]
    mockObjective = 'Assistant misread the goal entirely'
    mockObjectiveVerified = false
    const out = withEphemeralGoalRecitation(baseMessages())
    const content = String(out[0].content)
    expect(content).toContain('Working objective (assistant-inferred, NOT verified')
    expect(content).not.toContain("the user's ultimate goal")
  })

  it('returns the same reference when there are no open todos', () => {
    mockTodos = [todo('done', 'completed')]
    const messages = baseMessages()
    expect(withEphemeralGoalRecitation(messages)).toBe(messages)
  })

  it('returns the same reference for non-main agents', () => {
    mockTodos = [todo('Fix it', 'in_progress')]
    mockGetAgentContext.mockReturnValue({ agentId: 'explore-1' })
    const messages = baseMessages()
    expect(withEphemeralGoalRecitation(messages)).toBe(messages)
  })

  it('V2-only: recites the objective when no V1 todos but managed tasks are open', () => {
    mockIsTodoV1Enabled.mockReturnValue(false)
    mockIsTodoV2Enabled.mockReturnValue(true)
    mockTodos = []
    mockObjective = 'User wants zero-downtime deploys'
    mockHasOpenTasks = true
    const out = withEphemeralGoalRecitation(baseMessages())
    expect(out).not.toBe(baseMessages())
    expect(String(out[0].content)).toContain('Underlying objective')
    expect(String(out[0].content)).toContain('zero-downtime deploys')
  })

  it('V2-only: no recitation when objective set but no managed tasks open (no stale loop)', () => {
    mockIsTodoV1Enabled.mockReturnValue(false)
    mockIsTodoV2Enabled.mockReturnValue(true)
    mockTodos = []
    mockObjective = 'stale objective'
    mockHasOpenTasks = false
    const messages = baseMessages()
    expect(withEphemeralGoalRecitation(messages)).toBe(messages)
  })

  it('returns the same reference when BOTH task surfaces are disabled', () => {
    mockIsTodoV1Enabled.mockReturnValue(false)
    mockIsTodoV2Enabled.mockReturnValue(false)
    mockTodos = [todo('Fix it', 'in_progress')]
    mockObjective = 'x'
    mockHasOpenTasks = true
    const messages = baseMessages()
    expect(withEphemeralGoalRecitation(messages)).toBe(messages)
  })

  it('honours the POLE_GOAL_RECITATION=0 kill-switch', () => {
    mockTodos = [todo('Fix it', 'in_progress')]
    process.env.POLE_GOAL_RECITATION = '0'
    const messages = baseMessages()
    expect(withEphemeralGoalRecitation(messages)).toBe(messages)
  })

  it('returns the same reference when V1 todos are disabled', () => {
    mockTodos = [todo('Fix it', 'in_progress')]
    mockIsTodoV1Enabled.mockReturnValue(false)
    const messages = baseMessages()
    expect(withEphemeralGoalRecitation(messages)).toBe(messages)
  })
})

describe('buildUserQueryRecitation', () => {
  it('renders the marker, the instruction, and the TodoWrite hint', () => {
    const text = buildUserQueryRecitation('重构支付模块并保持接口兼容')
    expect(text).not.toBeNull()
    expect(text!).toContain(GOAL_RECITATION_MARKER)
    expect(text!).toContain('Original instruction: 重构支付模块并保持接口兼容')
    expect(text!).toContain('TodoWrite')
  })

  it('caps overlong queries and flattens whitespace', () => {
    const text = buildUserQueryRecitation(`a${'x'.repeat(2000)}\n\nnewline  spaced`)
    expect(text).not.toBeNull()
    const line = text!.split('\n').find((l) => l.startsWith('Original instruction:'))!
    expect(line.length).toBeLessThanOrEqual('Original instruction: '.length + MAX_RECITED_QUERY_CHARS)
    expect(line.endsWith('…')).toBe(true)
  })

  it('returns null on blank input', () => {
    expect(buildUserQueryRecitation('   \n ')).toBeNull()
  })
})

describe('withEphemeralGoalRecitation — untracked-run fallback', () => {
  const deep = GOAL_RECITATION_FALLBACK_MIN_ITERATION

  const deepMessages = () => [
    { role: 'user', content: '排查内存泄漏并修复' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ]

  it('recites the current user query when deep in an untracked run', () => {
    mockTodos = [] // nothing tracked
    const out = withEphemeralGoalRecitation(deepMessages(), { iteration: deep })
    const tail = JSON.stringify(out[out.length - 1])
    expect(tail).toContain(GOAL_RECITATION_MARKER)
    expect(tail).toContain('排查内存泄漏并修复')
  })

  it('does not fire below the iteration threshold', () => {
    const messages = deepMessages()
    expect(
      withEphemeralGoalRecitation(messages, { iteration: deep - 1 }),
    ).toBe(messages)
  })

  it('does not fire when the iteration is omitted (legacy callers)', () => {
    const messages = deepMessages()
    expect(withEphemeralGoalRecitation(messages)).toBe(messages)
  })

  it('tracked-work recitation wins over the fallback', () => {
    mockTodos = [todo('Fix leak', 'in_progress')]
    const out = withEphemeralGoalRecitation(deepMessages(), { iteration: deep })
    const tail = JSON.stringify(out[out.length - 1])
    expect(tail).toContain('[in_progress] Fix leak')
    expect(tail).not.toContain('Original instruction:')
  })

  it('fires even when both task surfaces are disabled (zero-coverage config)', () => {
    mockIsTodoV1Enabled.mockReturnValue(false)
    mockIsTodoV2Enabled.mockReturnValue(false)
    const out = withEphemeralGoalRecitation(deepMessages(), { iteration: deep })
    expect(JSON.stringify(out[out.length - 1])).toContain('排查内存泄漏并修复')
  })

  it('skips host side-channel and tool_result carriers when locating the query', () => {
    const messages = [
      { role: 'user', content: '真正的任务指令' },
      {
        role: 'user',
        content:
          '<system-reminder>\nhost nudge body\n</system-reminder>',
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'data' }] },
    ]
    const out = withEphemeralGoalRecitation(messages, { iteration: deep })
    const tail = JSON.stringify(out[out.length - 1])
    expect(tail).toContain('真正的任务指令')
    expect(tail).not.toContain('host nudge body')
  })

  it('honours the POLE_GOAL_RECITATION_FALLBACK=0 kill-switch', () => {
    process.env.POLE_GOAL_RECITATION_FALLBACK = '0'
    const messages = deepMessages()
    expect(withEphemeralGoalRecitation(messages, { iteration: deep })).toBe(messages)
  })

  it('no-ops when the transcript has no ordinary user text at all', () => {
    const messages = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'data' }] },
    ]
    expect(withEphemeralGoalRecitation(messages, { iteration: deep })).toBe(messages)
  })
})
