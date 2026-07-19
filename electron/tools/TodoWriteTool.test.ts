import { describe, it, expect, afterEach, vi } from 'vitest'

const mockGetAgentContext = vi.fn<() => { messages?: Array<Record<string, unknown>> } | undefined>(
  () => undefined,
)
vi.mock('../agents/agentContext', () => ({
  getAgentContext: () => mockGetAgentContext(),
}))

import {
  todoWriteTool,
  resetTodos,
  getTodoObjective,
  getTodoObjectiveMeta,
  setTodoObjective,
} from './TodoWriteTool'

describe('TodoWriteTool', () => {
  afterEach(() => {
    resetTodos('__default__')
    mockGetAgentContext.mockReturnValue(undefined)
  })

  it('success output is JSON with items for renderer TodoPanel sync', async () => {
    const r = await todoWriteTool.execute({
      todos: [{ content: 'Step A', status: 'in_progress', activeForm: 'Doing step A' }],
    })
    expect(r.success).toBe(true)
    expect(r.output).toBeTruthy()
    const o = JSON.parse(r.output!) as { items: unknown[]; message: string }
    expect(Array.isArray(o.items)).toBe(true)
    expect(o.items).toHaveLength(1)
    expect((o.items[0] as { content: string }).content).toBe('Step A')
    expect(o.message).toContain('modified successfully')
  })

  it('captures the objective and preserves it across updates that omit it', async () => {
    await todoWriteTool.execute({
      todos: [{ content: 'Step A', status: 'in_progress', activeForm: 'Doing step A' }],
      objective: 'User wants the dashboard to load under 1s',
    })
    expect(getTodoObjective('__default__')).toBe('User wants the dashboard to load under 1s')

    // An update without `objective` must keep the prior purpose.
    await todoWriteTool.execute({
      todos: [{ content: 'Step A', status: 'completed', activeForm: 'Doing step A' },
        { content: 'Step B', status: 'in_progress', activeForm: 'Doing step B' }],
    })
    expect(getTodoObjective('__default__')).toBe('User wants the dashboard to load under 1s')
  })

  it('clears the objective when the list fully completes (resets)', async () => {
    await todoWriteTool.execute({
      todos: [{ content: 'Step A', status: 'in_progress', activeForm: 'Doing step A' }],
      objective: 'some goal',
    })
    await todoWriteTool.execute({
      todos: [{ content: 'Step A', status: 'completed', activeForm: 'Doing step A' }],
    })
    expect(getTodoObjective('__default__')).toBe('')
  })

  it('consecutive-call hygiene: status-only flip (no completion) gets the fold-into-creation advisory', async () => {
    const list = [
      { content: 'A', status: 'pending', activeForm: 'A' },
      { content: 'B', status: 'pending', activeForm: 'B' },
    ]
    await todoWriteTool.execute({ todos: list })
    // Immediate re-call that only promotes item 1 — the wasteful pattern.
    const r = await todoWriteTool.execute({
      todos: [
        { content: 'A', status: 'in_progress', activeForm: 'A' },
        { content: 'B', status: 'pending', activeForm: 'B' },
      ],
    })
    const o = JSON.parse(r.output!) as { message: string }
    expect(o.message).toContain('only flipped item status(es)')
  })

  it('consecutive-call hygiene: identical re-send gets the redundant-call advisory', async () => {
    const list = [
      { content: 'A', status: 'in_progress', activeForm: 'A' },
      { content: 'B', status: 'pending', activeForm: 'B' },
    ]
    await todoWriteTool.execute({ todos: list })
    const r = await todoWriteTool.execute({ todos: list })
    const o = JSON.parse(r.output!) as { message: string }
    expect(o.message).toContain('did not change the list')
  })

  it('consecutive-call hygiene: a normal progress update (item completed) carries no advisory', async () => {
    await todoWriteTool.execute({
      todos: [
        { content: 'A', status: 'in_progress', activeForm: 'A' },
        { content: 'B', status: 'pending', activeForm: 'B' },
      ],
    })
    const r = await todoWriteTool.execute({
      todos: [
        { content: 'A', status: 'completed', activeForm: 'A' },
        { content: 'B', status: 'in_progress', activeForm: 'B' },
      ],
    })
    const o = JSON.parse(r.output!) as { message: string }
    expect(o.message).not.toContain('NOTE:')
  })

  // ── 2026-07 复审 P0 fix — objective write-time verification ──────────

  it('marks the objective VERIFIED when it overlaps the current user query', async () => {
    mockGetAgentContext.mockReturnValue({
      messages: [{ role: 'user', content: '请优化 dashboard 的加载性能，目标 1 秒内' }],
    })
    await todoWriteTool.execute({
      todos: [{ content: 'Step A', status: 'in_progress', activeForm: 'Doing step A' }],
      objective: '用户希望 dashboard 加载性能达到 1 秒内',
    })
    expect(getTodoObjectiveMeta('__default__')?.verified).toBe(true)
  })

  it('marks the objective UNVERIFIED on a meaningful zero-overlap with the current query', async () => {
    mockGetAgentContext.mockReturnValue({
      messages: [{ role: 'user', content: '请优化 dashboard 的加载性能，目标 1 秒内' }],
    })
    await todoWriteTool.execute({
      todos: [{ content: 'Step A', status: 'in_progress', activeForm: 'Doing step A' }],
      objective: 'User wants refund idempotency shipped with retry window',
    })
    const meta = getTodoObjectiveMeta('__default__')
    expect(meta?.text).toContain('refund idempotency')
    expect(meta?.verified).toBe(false)
  })

  it('F2: ABSTAINS (verified) when objective and query share no comparable script', () => {
    // Pure-CJK query vs pure-Latin objective — zero token overlap by
    // construction (ASCII words vs CJK bigrams), NOT a misread goal.
    mockGetAgentContext.mockReturnValue({
      messages: [{ role: 'user', content: '请优化仪表盘的加载性能，目标一秒以内完成' }],
    })
    setTodoObjective(
      '__default__',
      'User wants the dashboard to load in under one second',
    )
    expect(getTodoObjectiveMeta('__default__')?.verified).toBe(true)
  })

  it('F2: still verdicts when the scripts share surface (mixed-script query)', () => {
    // Query mentions latin token "dashboard" → comparison meaningful →
    // an unrelated English objective is still caught as unverified.
    mockGetAgentContext.mockReturnValue({
      messages: [{ role: 'user', content: '请优化 dashboard 的加载性能' }],
    })
    setTodoObjective(
      '__default__',
      'User wants refund idempotency shipped with retry window',
    )
    expect(getTodoObjectiveMeta('__default__')?.verified).toBe(false)
  })

  it('gives the benefit of the doubt (verified) when no conversation context exists', () => {
    mockGetAgentContext.mockReturnValue(undefined)
    setTodoObjective('__default__', 'restored objective from disk')
    expect(getTodoObjectiveMeta('__default__')?.verified).toBe(true)
  })

  it('gives the benefit of the doubt when the query is too short for a verdict', () => {
    mockGetAgentContext.mockReturnValue({
      messages: [{ role: 'user', content: '继续' }],
    })
    setTodoObjective('__default__', 'User wants the refund flow made idempotent end to end')
    expect(getTodoObjectiveMeta('__default__')?.verified).toBe(true)
  })

  it('audit F-13: enforces exactly one in_progress (demotes extras to pending, keeps first)', async () => {
    const r = await todoWriteTool.execute({
      todos: [
        { content: 'A', status: 'in_progress', activeForm: 'A' },
        { content: 'B', status: 'in_progress', activeForm: 'B' },
        { content: 'C', status: 'pending', activeForm: 'C' },
        { content: 'D', status: 'in_progress', activeForm: 'D' },
      ],
    })
    expect(r.success).toBe(true)
    const o = JSON.parse(r.output!) as { items: Array<{ content: string; status: string }> }
    const byContent = Object.fromEntries(o.items.map((t) => [t.content, t.status]))
    // First in_progress kept; the rest demoted to pending.
    expect(byContent.A).toBe('in_progress')
    expect(byContent.B).toBe('pending')
    expect(byContent.C).toBe('pending')
    expect(byContent.D).toBe('pending')
    expect(o.items.filter((t) => t.status === 'in_progress')).toHaveLength(1)
  })
})
