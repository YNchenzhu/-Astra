import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoopState } from '../loopShared'
import {
  SYSTEM_DRIVE_CONTEXT_MARKER,
  buildSystemDriveContextBody,
  inferTaskType,
  systemDriveContextCollector,
} from './systemDriveContext'
import { getActiveBundleId } from '../../../agents/bundles/bundleRegistryQueries'

// F3 — hostQualityGatesApply now resolves through the shared
// `hostVerificationScopeApplies` predicate (verificationGate.ts), which
// reads `getActiveBundle()` + the bundle's executionPolicy. Derive the
// bundle object from the same mocked id so both read paths agree.
vi.mock('../../../agents/bundles/bundleRegistryQueries', () => {
  const getActiveBundleId = vi.fn((): string | undefined => undefined)
  return {
    getActiveBundleId,
    getActiveBundle: () => {
      const id = getActiveBundleId()
      return id === undefined ? undefined : { meta: { id } }
    },
  }
})

const mockedGetActiveBundleId = vi.mocked(getActiveBundleId)

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    apiMessages: [{ role: 'user', content: 'please implement the AgentLoop context fix' }],
    chatMode: 'agent',
    enableTools: true,
    iteration: 2,
    transition: 'tool_use',
    systemPromptLayers: {
      systemContext: 'system',
      userContext: 'user',
      userMessageContext: 'project memory',
    },
    ...overrides,
  } as unknown as LoopState
}

describe('systemDriveContext', () => {
  beforeEach(() => {
    mockedGetActiveBundleId.mockReturnValue(undefined)
  })

  it('builds a bounded turn-entry task contract', () => {
    const body = buildSystemDriveContextBody({
      state: makeState(),
      systemPrompt: 'system prompt',
    })

    expect(body).toContain(SYSTEM_DRIVE_CONTEXT_MARKER)
    expect(body).toContain('<task_contract>')
    expect(body).toContain('Current request: please implement the AgentLoop context fix')
    expect(body).toContain('Task type: implementation')
    expect(body).toContain('<quality_gate>')
    expect(body).toContain('<context_provenance>')
    expect(body).toContain('<completion_criteria>')
  })

  it('summarizes a tool batch produced AFTER the current query as this-turn evidence', () => {
    const body = buildSystemDriveContextBody({
      state: makeState({
        apiMessages: [
          { role: 'user', content: 'fix the issue' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'read_1', name: 'read_file', input: {} }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'read_1', content: 'opened target file' },
            ],
          },
        ],
      }),
      systemPrompt: 'system prompt',
    })

    expect(body).toContain('Most recent tool batch (this turn): 1 tool result(s).')
    expect(body).toContain('read_1: observed; opened target file')
  })

  // ── 2026-07 复审 item 4 — task-scoped observation digest ─────────────

  it('labels a previous-turn batch with provenance when the new query continues the same task', () => {
    const body = buildSystemDriveContextBody({
      state: makeState({
        apiMessages: [
          { role: 'user', content: '重构 checkout 支付模块的重试逻辑' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'grep_1', name: 'grep', input: {} }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'grep_1', content: 'found retry sites' },
            ],
          },
          // New user turn — same task (shares 重试/支付 tokens).
          { role: 'user', content: '继续把支付重试的常量抽出来' },
        ],
      }),
      systemPrompt: 'system prompt',
    })
    expect(body).toContain('from the PREVIOUS user turn — verify relevance')
    expect(body).toContain('grep_1: observed; found retry sites')
  })

  it('F6: uses a NEUTRAL label when no user turn remains to attribute against (post-compaction)', () => {
    const body = buildSystemDriveContextBody({
      state: makeState({
        apiMessages: [
          // Compact summary replaced the user turn — host envelope only.
          {
            role: 'user',
            content:
              '<system-reminder>\n[Previous conversation was compacted to save context …]\nSummary: …\n</system-reminder>',
            _convertedFromSystem: true,
            _sideChannelKind: 'compact_summary',
          },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'grep_1', name: 'grep', input: {} }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'grep_1', content: 'found retry sites' },
            ],
          },
        ],
      }),
      systemPrompt: 'system prompt',
    })
    expect(body).toContain('turn attribution unavailable')
    expect(body).not.toContain('(this turn)')
  })

  it('WITHHOLDS a previous-turn batch when the new query changes direction (task switch)', () => {
    const body = buildSystemDriveContextBody({
      state: makeState({
        apiMessages: [
          { role: 'user', content: '重构 checkout 支付模块的重试逻辑' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'grep_1', name: 'grep', input: {} }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'grep_1', content: 'found retry sites' },
            ],
          },
          // New user turn — unrelated task (zero informative-token overlap).
          { role: 'user', content: '帮我调查登录白屏线上事故的根因' },
        ],
      }),
      systemPrompt: 'system prompt',
    })
    expect(body).toContain('Previous-turn tool observations withheld')
    expect(body).not.toContain('found retry sites')
  })

  it('injects only on the first inner iteration of a user turn', async () => {
    const firstIteration = await systemDriveContextCollector.run({
      state: makeState({ iteration: 1 }),
      systemPrompt: 'system prompt',
      callSite: 'iteration_top',
    })
    expect(firstIteration).not.toBeNull()

    const continuationIteration = await systemDriveContextCollector.run({
      state: makeState({ iteration: 2 }),
      systemPrompt: 'system prompt',
      callSite: 'iteration_top',
    })
    expect(continuationIteration).toBeNull()
  })

  it('infers task type from Chinese requests', () => {
    expect(inferTaskType('帮我审查这份接口设计的安全风险')).toBe('review')
    expect(inferTaskType('分析一下这个函数的调用链')).toBe('analysis')
    expect(inferTaskType('写一份产品宣传文案')).toBe('documentation')
    expect(inferTaskType('修复登录页的报错并新增校验')).toBe('implementation')
    expect(inferTaskType('你好')).toBe('general')
  })

  it('does not misread “解决方案” in an implementation request as documentation', () => {
    // P2 audit fix — bare “方案” only counts as documentation when paired
    // with a writing verb (写/拟/起草/出具) or as “方案书”.
    expect(inferTaskType('给出这个bug的解决方案并修复')).toBe('implementation')
    expect(inferTaskType('帮我写一份技术方案')).toBe('documentation')
    expect(inferTaskType('起草一版上线方案')).toBe('documentation')
  })

  it('keeps host quality gates for the code-dev workpack', () => {
    mockedGetActiveBundleId.mockReturnValue('code-dev')
    const body = buildSystemDriveContextBody({
      state: makeState(),
      systemPrompt: 'system prompt',
    })
    expect(body).toContain('<quality_gate>')
    expect(body).toContain('<completion_criteria>')
  })

  it('yields quality gates to the bundle prompt for non-code-dev workpacks', () => {
    mockedGetActiveBundleId.mockReturnValue('legal-writing')
    const body = buildSystemDriveContextBody({
      state: makeState(),
      systemPrompt: 'system prompt',
    })
    // Domain-neutral sections stay; host-authored quality/verification
    // framing yields to the workpack's own prompt (design decision:
    // non-coding verification is prompt-driven).
    expect(body).toContain('<task_contract>')
    expect(body).toContain('<context_provenance>')
    expect(body).toContain('<latest_observation_digest>')
    expect(body).not.toContain('<quality_gate>')
    expect(body).not.toContain('<completion_criteria>')
  })
})
