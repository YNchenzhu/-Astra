/**
 * Objective-conflict reminder (#12, 2026-07 deep-loop uplift) tests.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mockGetAgentContext = vi.fn<() => { agentId?: string; streamConversationId?: string } | undefined>(
  () => ({ agentId: 'main', streamConversationId: 'conv-1' }),
)
vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => mockGetAgentContext(),
}))

let mockObjective = ''
vi.mock('../../../tools/TodoWriteTool', () => ({
  getTodoObjective: () => mockObjective,
}))

import {
  OBJECTIVE_CONFLICT_MARKER,
  informativeTokens,
  looksLikeDirectionChange,
  objectiveConflictCollector,
  __resetObjectiveConflictTrackingForTests,
} from './objectiveConflict'
import type { AttachmentContext } from '../hostAttachments'
import type { LoopState } from '../loopShared'

function ctxWithQuery(query: string, iteration = 1): AttachmentContext {
  const state = {
    apiMessages: [{ role: 'user', content: query }],
    iteration,
    appendixReport: () => {},
  } as unknown as LoopState
  return { state, systemPrompt: 'sys', callSite: 'iteration_top' }
}

async function runWith(query: string, iteration = 1): Promise<string | null> {
  const raw = await objectiveConflictCollector.run(ctxWithQuery(query, iteration))
  if (!raw || Array.isArray(raw)) return null
  return String((raw.message as { content?: unknown }).content)
}

beforeEach(() => {
  __resetObjectiveConflictTrackingForTests()
  mockObjective = ''
  mockGetAgentContext.mockReturnValue({ agentId: 'main', streamConversationId: 'conv-1' })
})

afterEach(() => {
  delete process.env.POLE_OBJECTIVE_CONFLICT_NUDGE
})

describe('informativeTokens', () => {
  it('collects ASCII words (≥3 chars) and CJK bigrams', () => {
    const tokens = informativeTokens('重构 parser 模块')
    expect(tokens.has('parser')).toBe(true)
    expect(tokens.has('重构')).toBe(true)
    expect(tokens.has('模块')).toBe(true)
    // Cross-script pairs are not bigrams.
    expect(tokens.has('构p')).toBe(false)
  })
})

describe('looksLikeDirectionChange', () => {
  it('zero overlap on informative tokens → true', () => {
    expect(
      looksLikeDirectionChange('重构支付模块并保持接口兼容', '帮我写一篇产品发布公告'),
    ).toBe(true)
  })

  it('any shared token (topical continuity) → false', () => {
    expect(
      looksLikeDirectionChange('重构支付模块并保持接口兼容', '支付那边再修一个报错'),
    ).toBe(false)
    expect(
      looksLikeDirectionChange('refactor the parser module', 'parser still crashes on empty input'),
    ).toBe(false)
  })

  it('short / uninformative messages never trigger ("继续", "go on")', () => {
    expect(looksLikeDirectionChange('重构支付模块并保持接口兼容', '继续')).toBe(false)
    expect(looksLikeDirectionChange('重构支付模块并保持接口兼容', 'ok go')).toBe(false)
  })
})

describe('objectiveConflictCollector', () => {
  it('nudges once when the new turn shares nothing with the objective', async () => {
    mockObjective = '重构支付模块并保持接口兼容'
    const body = await runWith('帮我写一篇产品发布公告')
    expect(body).not.toBeNull()
    expect(body!).toContain(OBJECTIVE_CONFLICT_MARKER)
    expect(body!).toContain('重构支付模块并保持接口兼容')
    expect(body!).toContain('帮我写一篇产品发布公告')
    // Same (objective, query) pair again (retry/regenerate) → silent.
    expect(await runWith('帮我写一篇产品发布公告')).toBeNull()
  })

  it('a DIFFERENT conflicting turn re-nudges', async () => {
    mockObjective = '重构支付模块并保持接口兼容'
    expect(await runWith('帮我写一篇产品发布公告')).not.toBeNull()
    expect(await runWith('再帮我策划一场用户访谈活动')).not.toBeNull()
  })

  it('stays silent on topical continuity', async () => {
    mockObjective = '重构支付模块并保持接口兼容'
    expect(await runWith('支付模块那个报错再看一下')).toBeNull()
  })

  it('only fires on the first iteration of a turn', async () => {
    mockObjective = '重构支付模块并保持接口兼容'
    expect(await runWith('帮我写一篇产品发布公告', 5)).toBeNull()
  })

  it('silent without an objective, for sub-agents, and under the kill-switch', async () => {
    expect(await runWith('帮我写一篇产品发布公告')).toBeNull() // no objective

    mockObjective = '重构支付模块并保持接口兼容'
    mockGetAgentContext.mockReturnValue({ agentId: 'explore-1', streamConversationId: 'c' })
    expect(await runWith('帮我写一篇产品发布公告')).toBeNull()

    mockGetAgentContext.mockReturnValue({ agentId: 'main', streamConversationId: 'conv-1' })
    process.env.POLE_OBJECTIVE_CONFLICT_NUDGE = '0'
    expect(await runWith('帮我写一篇产品发布公告')).toBeNull()
  })
})
