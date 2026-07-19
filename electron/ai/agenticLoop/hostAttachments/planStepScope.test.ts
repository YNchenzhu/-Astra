/**
 * Plan-step scope collector (#4, 2026-07 deep-loop uplift) tests.
 *
 * Contract under test:
 *   - silent when: no plan / no in_progress step / step has no resolvable scope
 *   - glob + fragment matching, other steps' declared scopes count as in-scope
 *   - accumulates DISTINCT out-of-scope files; one nudge per step at the
 *     threshold; counter resets when the step changes
 *   - subject-derived fallback scope; env kill-switch; main-chat only
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mockGetAgentContext = vi.fn<() => { agentId?: string; streamConversationId?: string } | undefined>(
  () => ({ agentId: 'main', streamConversationId: 'conv-1' }),
)
vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => mockGetAgentContext(),
}))

type Step = { taskId: string; subject: string; status: string; files?: string[] }
let mockSteps: Step[] | null = null
vi.mock('../../../planning/planRuntime', () => ({
  getActivePlanStepsSnapshot: () =>
    mockSteps ? { planFilePath: '/p.md', steps: mockSteps } : null,
}))

import {
  PLAN_STEP_SCOPE_MARKER,
  planStepScopeCollector,
  resolveStepScopeTerms,
  scopeTermMatchesPath,
  __resetPlanStepScopeTrackingForTests,
} from './planStepScope'
import type { AttachmentContext } from '../hostAttachments'
import type { LoopState } from '../loopShared'

function ctxWithEdits(paths: string[]): AttachmentContext {
  const state = {
    apiMessages: [],
    iteration: 1,
    appendixReport: () => {},
    toolUseBlocks: paths.map((p, i) => ({
      id: `tu_${i}`,
      name: 'edit_file',
      input: { file_path: p, old_string: 'a', new_string: 'b' },
    })),
  } as unknown as LoopState
  return { state, systemPrompt: 'sys', callSite: 'post_tool' }
}

async function runWith(paths: string[]): Promise<string | null> {
  const raw = await planStepScopeCollector.run(ctxWithEdits(paths))
  if (!raw || Array.isArray(raw)) return null
  return String((raw.message as { content?: unknown }).content)
}

beforeEach(() => {
  __resetPlanStepScopeTrackingForTests()
  mockSteps = null
  mockGetAgentContext.mockReturnValue({ agentId: 'main', streamConversationId: 'conv-1' })
})

afterEach(() => {
  delete process.env.POLE_PLAN_STEP_SCOPE
  delete process.env.POLE_PLAN_STEP_SCOPE_MIN_FILES
})

describe('scopeTermMatchesPath', () => {
  it('plain fragments match by inclusion, case/separator-insensitively', () => {
    expect(scopeTermMatchesPath('src/parser', 'g:/ws/SRC/Parser/index.ts'.toLowerCase())).toBe(true)
    expect(scopeTermMatchesPath('parser.ts', 'src/other/lexer.ts')).toBe(false)
  })

  it('globs: * stays within a segment, ** spans segments', () => {
    expect(scopeTermMatchesPath('src/*.ts', 'ws/src/main.ts')).toBe(true)
    expect(scopeTermMatchesPath('src/*.ts', 'ws/src/deep/main.ts')).toBe(false)
    expect(scopeTermMatchesPath('src/**/*.ts', 'ws/src/deep/main.ts')).toBe(true)
  })
})

describe('resolveStepScopeTerms', () => {
  it('prefers declared files, falls back to subject path tokens, else empty', () => {
    expect(
      resolveStepScopeTerms({ taskId: 't', subject: 'x', status: 'pending', files: ['src/a.ts'] }),
    ).toEqual(['src/a.ts'])
    expect(
      resolveStepScopeTerms({ taskId: 't', subject: 'refactor electron/parser.ts', status: 'pending' }),
    ).toContain('electron/parser.ts')
    expect(
      resolveStepScopeTerms({ taskId: 't', subject: '润色第三章', status: 'pending' }),
    ).toEqual([])
  })
})

describe('planStepScopeCollector', () => {
  it('nudges once after 2 distinct out-of-scope files, listing the offenders', async () => {
    mockSteps = [
      { taskId: 't1', subject: 'parser work', status: 'in_progress', files: ['src/parser/**'] },
    ]
    // First out-of-scope file — below threshold, silent.
    expect(await runWith(['src/ui/button.tsx'])).toBeNull()
    // Second distinct out-of-scope file — nudge fires.
    const body = await runWith(['src/store/cart.ts'])
    expect(body).not.toBeNull()
    expect(body!).toContain(PLAN_STEP_SCOPE_MARKER)
    expect(body!).toContain('parser work')
    expect(body!).toContain('src/ui/button.tsx')
    expect(body!).toContain('src/store/cart.ts')
    // One-shot per step: further offenders stay silent.
    expect(await runWith(['src/api/client.ts'])).toBeNull()
  })

  it('in-scope edits (current step glob) never count', async () => {
    mockSteps = [
      { taskId: 't1', subject: 's', status: 'in_progress', files: ['src/parser/**'] },
    ]
    expect(await runWith(['src/parser/lexer.ts', 'src/parser/ast.ts'])).toBeNull()
  })

  it("edits matching ANOTHER step's declared scope are in-scope (working ahead ≠ drift)", async () => {
    mockSteps = [
      { taskId: 't1', subject: 's1', status: 'in_progress', files: ['src/parser/**'] },
      { taskId: 't2', subject: 's2', status: 'pending', files: ['src/ui/**'] },
    ]
    expect(await runWith(['src/ui/button.tsx', 'src/ui/panel.tsx'])).toBeNull()
  })

  it("audit fix: another step's SUBJECT-derived scope also counts as in-scope", async () => {
    // Plans that never declare `files` resolve every step via subject
    // path-tokens — working ahead on step 2's named file must not be
    // reported as drift.
    mockSteps = [
      { taskId: 't1', subject: 'fix electron/parser.ts', status: 'in_progress' },
      { taskId: 't2', subject: 'then update electron/lexer.ts', status: 'pending' },
    ]
    expect(await runWith(['electron/lexer.ts', 'electron/lexer.ts'])).toBeNull()
    // A file named by NO step still counts as the offender path.
    expect(await runWith(['docs/readme.md'])).toBeNull() // 1st offender
    const body = await runWith(['src/unrelated.ts']) // 2nd offender
    expect(body).not.toBeNull()
  })

  it('falls back to subject-derived scope when no files are declared', async () => {
    mockSteps = [
      { taskId: 't1', subject: 'fix bug in electron/parser.ts', status: 'in_progress' },
    ]
    expect(await runWith(['docs/readme.md'])).toBeNull() // 1st offender
    const body = await runWith(['src/other.ts']) // 2nd offender
    expect(body).not.toBeNull()
    expect(body!).toContain('docs/readme.md')
  })

  it('stays silent when the step has no resolvable scope (prose-only subject)', async () => {
    mockSteps = [{ taskId: 't1', subject: '润色第三章开头', status: 'in_progress' }]
    expect(await runWith(['a.ts', 'b.ts', 'c.ts'])).toBeNull()
  })

  it('resets accumulation when the current step changes', async () => {
    mockSteps = [{ taskId: 't1', subject: 's1', status: 'in_progress', files: ['src/a/**'] }]
    expect(await runWith(['x/one.ts'])).toBeNull()
    mockSteps = [{ taskId: 't2', subject: 's2', status: 'in_progress', files: ['src/b/**'] }]
    expect(await runWith(['x/two.ts'])).toBeNull() // fresh counter for t2
  })

  it('duplicate offender paths count once', async () => {
    mockSteps = [{ taskId: 't1', subject: 's', status: 'in_progress', files: ['src/a/**'] }]
    expect(await runWith(['x/same.ts'])).toBeNull()
    expect(await runWith(['x/same.ts'])).toBeNull() // still 1 distinct file
  })

  it('main-chat only + kill-switch', async () => {
    mockSteps = [{ taskId: 't1', subject: 's', status: 'in_progress', files: ['src/a/**'] }]
    mockGetAgentContext.mockReturnValue({ agentId: 'explore-1', streamConversationId: 'conv-1' })
    expect(await runWith(['x/1.ts', 'x/2.ts'])).toBeNull()

    mockGetAgentContext.mockReturnValue({ agentId: 'main', streamConversationId: 'conv-1' })
    process.env.POLE_PLAN_STEP_SCOPE = '0'
    expect(await runWith(['x/1.ts', 'x/2.ts'])).toBeNull()
  })
})
