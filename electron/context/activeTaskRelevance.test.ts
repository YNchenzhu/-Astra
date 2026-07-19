/**
 * Active-task relevance term extraction (#10, 2026-07 deep-loop uplift).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetAgentContext = vi.fn<() => { agentId?: string } | undefined>(() => undefined)
vi.mock('../agents/agentContext', () => ({
  getAgentContext: () => mockGetAgentContext(),
}))

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }
let mockTodos: Todo[] = []
let mockObjective = ''
vi.mock('../tools/TodoWriteTool', () => ({
  getTodos: () => mockTodos,
  getTodoObjective: () => mockObjective,
}))

type Step = { taskId: string; subject: string; status: string }
let mockSteps: Step[] | null = null
vi.mock('../planning/planRuntime', () => ({
  getActivePlanStepsSnapshot: () =>
    mockSteps ? { planFilePath: '/p.md', steps: mockSteps } : null,
}))

import {
  MAX_RELEVANCE_TERMS,
  collectActiveTaskRelevanceTerms,
  extractPathLikeTerms,
} from './activeTaskRelevance'

beforeEach(() => {
  mockTodos = []
  mockObjective = ''
  mockSteps = null
  mockGetAgentContext.mockReturnValue(undefined)
})

describe('extractPathLikeTerms', () => {
  it('extracts separator paths and extension filenames, lowercased and deduped', () => {
    const terms = extractPathLikeTerms([
      '修复 electron/ai/stream.ts 的重试逻辑',
      'Update Stream.TS retry and add tests in stream.test.ts',
    ])
    expect(terms).toContain('electron/ai/stream.ts')
    expect(terms).toContain('stream.test.ts')
    // Deduped case-insensitively: stream.ts appears once.
    expect(terms.filter((t) => t === 'stream.ts')).toHaveLength(1)
  })

  it('produces NO terms for prose-only work items (writing tasks unaffected)', () => {
    expect(extractPathLikeTerms(['润色第三章的开头段落', '统一全文语气为书面语'])).toEqual([])
  })

  it('ignores version-like tokens and ultra-short matches', () => {
    const terms = extractPathLikeTerms(['upgrade to 1.2.3 and fix a.b'])
    expect(terms).not.toContain('1.2.3')
    expect(terms).not.toContain('a.b')
  })

  it('caps the term list', () => {
    const texts = Array.from({ length: 100 }, (_, i) => `edit src/file${i}.ts`)
    expect(extractPathLikeTerms(texts).length).toBeLessThanOrEqual(MAX_RELEVANCE_TERMS)
  })
})

describe('collectActiveTaskRelevanceTerms', () => {
  it('collects from open todos + objective, skipping completed items', () => {
    mockObjective = 'Fix the flaky retry in electron/ai/withRetry.ts'
    mockTodos = [
      { content: 'read src/app.tsx', status: 'in_progress' },
      { content: 'old work on legacy/main.js', status: 'completed' },
    ]
    const terms = collectActiveTaskRelevanceTerms()
    expect(terms).toContain('electron/ai/withretry.ts')
    expect(terms).toContain('src/app.tsx')
    expect(terms).not.toContain('legacy/main.js')
  })

  it('main chat additionally contributes open plan step subjects', () => {
    mockGetAgentContext.mockReturnValue({ agentId: 'main' })
    mockSteps = [
      { taskId: 't1', subject: 'implement parser in electron/parser.ts', status: 'in_progress' },
      { taskId: 't2', subject: 'done step touching old/done.ts', status: 'completed' },
    ]
    const terms = collectActiveTaskRelevanceTerms()
    expect(terms).toContain('electron/parser.ts')
    expect(terms).not.toContain('old/done.ts')
  })

  it('returns [] when nothing tracked (legacy eviction order applies)', () => {
    expect(collectActiveTaskRelevanceTerms()).toEqual([])
  })
})
