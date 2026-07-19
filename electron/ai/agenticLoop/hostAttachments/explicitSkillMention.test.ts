/**
 * Explicit-skill-mention collector (skill-attention uplift, 2026-07) tests.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mockGetAgentContext = vi.fn<() => { agentId?: string; streamConversationId?: string } | undefined>(
  () => ({ agentId: 'main', streamConversationId: 'conv-1' }),
)
vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => mockGetAgentContext(),
}))

interface MockSkill {
  name: string
  description: string
  disableModelInvocation: boolean
  argumentHint?: string
}
let mockSkills: MockSkill[] = []
vi.mock('../../../skills/skillTool', () => ({
  findSkill: (raw: string) => {
    const normalized = raw.replace(/^[/@]/, '').toLowerCase()
    return mockSkills.find((s) => s.name.toLowerCase() === normalized)
  },
}))

import {
  EXPLICIT_SKILL_MENTION_MARKER,
  MAX_MENTIONED_SKILLS,
  extractExplicitSkillMentions,
  explicitSkillMentionCollector,
  renderExplicitSkillMentionBody,
  __resetExplicitSkillMentionTrackingForTests,
} from './explicitSkillMention'
import type { AttachmentContext } from '../hostAttachments'
import type { LoopState } from '../loopShared'
import type { SkillDefinition } from '../../../skills/types'

function makeCtx(
  query: string,
  overrides: Partial<{
    iteration: number
    enableTools: boolean
    activeSkillName: string
  }> = {},
): AttachmentContext {
  const state = {
    apiMessages: [{ role: 'user', content: query }],
    iteration: overrides.iteration ?? 1,
    enableTools: overrides.enableTools ?? true,
    ...(overrides.activeSkillName
      ? { activeInlineSkillSession: { skillName: overrides.activeSkillName } }
      : {}),
    appendixReport: () => {},
  } as unknown as LoopState
  return { state, systemPrompt: 'sys', callSite: 'iteration_top' }
}

async function runWith(
  query: string,
  overrides: Parameters<typeof makeCtx>[1] = {},
): Promise<string | null> {
  const raw = await explicitSkillMentionCollector.run(makeCtx(query, overrides))
  if (!raw || Array.isArray(raw)) return null
  return String((raw.message as { content?: unknown }).content)
}

beforeEach(() => {
  __resetExplicitSkillMentionTrackingForTests()
  mockSkills = [
    { name: 'debug', description: 'Diagnose and investigate errors', disableModelInvocation: false },
    { name: 'deep-research', description: '自主深度研究专家', disableModelInvocation: false, argumentHint: '<topic>' },
    { name: 'manual-only', description: 'User-triggered workflow', disableModelInvocation: true },
    { name: 'batch', description: 'Run a batch workflow', disableModelInvocation: false },
    { name: 'loop', description: 'Run refinement loops', disableModelInvocation: false },
    { name: 'verify', description: 'Verify a change works', disableModelInvocation: false },
  ]
  mockGetAgentContext.mockReturnValue({ agentId: 'main', streamConversationId: 'conv-1' })
})

afterEach(() => {
  delete process.env.POLE_EXPLICIT_SKILL_MENTION
})

describe('extractExplicitSkillMentions', () => {
  it('matches /name and @name at string start and after whitespace', () => {
    expect(extractExplicitSkillMentions('/debug the failing test')).toEqual(['debug'])
    expect(extractExplicitSkillMentions('please run @deep-research on this')).toEqual([
      'deep-research',
    ])
  })

  it('matches directly after CJK characters (no space needed)', () => {
    expect(extractExplicitSkillMentions('请用/debug排查一下')).toEqual(['debug'])
  })

  it('dedupes and preserves first-mention order', () => {
    expect(extractExplicitSkillMentions('/debug then @batch then /debug again')).toEqual([
      'debug',
      'batch',
    ])
  })

  it('does NOT match path / URL / scoped-package segments', () => {
    expect(extractExplicitSkillMentions('open src/debug/index.ts')).toEqual([])
    expect(extractExplicitSkillMentions('see https://example.com/debug')).toEqual([])
    expect(extractExplicitSkillMentions('install @types/node')).toEqual(['types'])
    expect(extractExplicitSkillMentions('g:/workspace/debug')).toEqual([])
    expect(extractExplicitSkillMentions('a.b/debug')).toEqual([])
  })

  it('does not match bare names without a / or @ prefix', () => {
    expect(extractExplicitSkillMentions('use the debug skill')).toEqual([])
  })
})

describe('renderExplicitSkillMentionBody', () => {
  it('carries the marker, skill lines, and argument hints', () => {
    const body = renderExplicitSkillMentionBody(
      mockSkills.slice(0, 2) as unknown as SkillDefinition[],
    )
    expect(body.startsWith(EXPLICIT_SKILL_MENTION_MARKER)).toBe(true)
    expect(body).toContain('- /debug — Diagnose and investigate errors')
    expect(body).toContain('- /deep-research — 自主深度研究专家 (args: <topic>)')
    expect(body).toContain('Skill')
  })
})

describe('explicitSkillMentionCollector', () => {
  it('fires when the user names a loaded skill, once per (query, names) pair', async () => {
    const body = await runWith('用 /debug 查一下这个报错')
    expect(body).not.toBeNull()
    expect(body!).toContain(EXPLICIT_SKILL_MENTION_MARKER)
    expect(body!).toContain('/debug')
    // Retry / regenerate of the same turn → silent.
    expect(await runWith('用 /debug 查一下这个报错')).toBeNull()
    // A different turn mentioning the same skill re-fires.
    expect(await runWith('再用 /debug 看另一个问题')).not.toBeNull()
  })

  it('skips unknown names and manual-only skills', async () => {
    expect(await runWith('run /nonexistent please')).toBeNull()
    expect(await runWith('run /manual-only please')).toBeNull()
  })

  it('skips the active inline skill session\'s own name', async () => {
    expect(await runWith('continue with /debug', { activeSkillName: 'debug' })).toBeNull()
    // …but still surfaces OTHER skills mentioned alongside it.
    const body = await runWith('use /debug and /batch', { activeSkillName: 'debug' })
    expect(body).not.toBeNull()
    expect(body!).toContain('/batch')
    expect(body!).not.toContain('- /debug')
  })

  it('caps surfaced skills at MAX_MENTIONED_SKILLS', async () => {
    const body = await runWith('/debug /batch /loop /verify /deep-research')
    expect(body).not.toBeNull()
    const count = (body!.match(/^- \//gm) ?? []).length
    expect(count).toBe(MAX_MENTIONED_SKILLS)
  })

  it('silent on later iterations, sub-agents, disabled tools, and kill-switch', async () => {
    expect(await runWith('/debug it', { iteration: 3 })).toBeNull()
    expect(await runWith('/debug it', { enableTools: false })).toBeNull()

    mockGetAgentContext.mockReturnValue({ agentId: 'explore-1', streamConversationId: 'c' })
    expect(await runWith('/debug it')).toBeNull()

    mockGetAgentContext.mockReturnValue({ agentId: 'main', streamConversationId: 'conv-1' })
    process.env.POLE_EXPLICIT_SKILL_MENTION = '0'
    expect(await runWith('/debug it')).toBeNull()
  })
})
