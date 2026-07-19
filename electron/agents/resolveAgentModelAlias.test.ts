/**
 * Tests for Agent-level model alias resolution.
 *
 * These close Gap 1 identified in the custom-agent orchestration audit:
 * upstream's convention is to accept `sonnet` / `opus` / `haiku` /
 * `inherit` as `model:` values in agent frontmatter, but before this change
 * the app passed them verbatim to the provider — which fails outside the
 * first-party Anthropic SDK.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the shared resolver before importing the module under test.
// We don't want these tests to depend on the real provider model catalog.
vi.mock('../skills/skillModelResolve', () => ({
  resolveSkillModelAlias: vi.fn((model: string) => {
    // Minimal alias table mirroring the production behaviour.
    const lower = model.trim().toLowerCase()
    if (lower === 'sonnet' || lower === 'claude-sonnet') {
      return 'claude-sonnet-4-5-20250929'
    }
    if (lower === 'opus' || lower === 'claude-opus') {
      return 'claude-opus-4-7'
    }
    if (lower === 'haiku' || lower === 'claude-haiku') {
      return 'claude-haiku-4-0'
    }
    // Anything else is assumed to be a full deployment id — pass through.
    return model
  }),
}))

import { resolveAgentModelAlias } from './resolveAgentModelAlias'
import { resolveSkillModelAlias } from '../skills/skillModelResolve'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveAgentModelAlias — Gap 1 fix', () => {
  it('empty declared → parent model (no provider call)', () => {
    expect(resolveAgentModelAlias(undefined, 'gpt-4o', 'openai')).toBe('gpt-4o')
    expect(resolveAgentModelAlias('', 'gpt-4o', 'openai')).toBe('gpt-4o')
    expect(resolveAgentModelAlias(null, 'gpt-4o', 'openai')).toBe('gpt-4o')
    expect(resolveSkillModelAlias).not.toHaveBeenCalled()
  })

  it('explicit "inherit" sentinel → parent model (no provider call)', () => {
    expect(resolveAgentModelAlias('inherit', 'gpt-4o', 'openai')).toBe('gpt-4o')
    expect(resolveAgentModelAlias('Inherit', 'gpt-4o', 'openai')).toBe('gpt-4o')
    expect(resolveAgentModelAlias('  inherit  ', 'gpt-4o', 'openai')).toBe('gpt-4o')
    expect(resolveSkillModelAlias).not.toHaveBeenCalled()
  })

  it('short aliases resolve via shared skill resolver', () => {
    expect(resolveAgentModelAlias('sonnet', 'gpt-4o', 'anthropic')).toBe(
      'claude-sonnet-4-5-20250929',
    )
    expect(resolveAgentModelAlias('opus', 'gpt-4o', 'anthropic')).toBe('claude-opus-4-7')
    expect(resolveAgentModelAlias('haiku', 'gpt-4o', 'anthropic')).toBe('claude-haiku-4-0')
    // claude- prefixed aliases also work.
    expect(resolveAgentModelAlias('claude-sonnet', 'gpt-4o', 'anthropic')).toBe(
      'claude-sonnet-4-5-20250929',
    )
  })

  it('full deployment ids pass through unchanged', () => {
    expect(
      resolveAgentModelAlias('claude-opus-4-5-20251101', 'claude-sonnet-4-5', 'anthropic'),
    ).toBe('claude-opus-4-5-20251101')
    expect(resolveAgentModelAlias('gpt-4o', 'gpt-3.5', 'openai')).toBe('gpt-4o')
  })

  it('resolver receives the declared provider id so it can pick from the right catalog', () => {
    resolveAgentModelAlias('sonnet', 'irrelevant', 'zhipu')
    expect(resolveSkillModelAlias).toHaveBeenCalledWith('sonnet', 'zhipu')
  })

  it('when resolver returns falsy, falls back to parent model (safety net)', () => {
    vi.mocked(resolveSkillModelAlias).mockImplementationOnce(() => '')
    expect(resolveAgentModelAlias('haiku', 'gpt-4o', 'openai')).toBe('gpt-4o')
  })

  it('whitespace-only declared is treated as empty', () => {
    expect(resolveAgentModelAlias('   ', 'gpt-4o', 'openai')).toBe('gpt-4o')
    expect(resolveSkillModelAlias).not.toHaveBeenCalled()
  })
})
