import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  anthropicAdaptiveThinkingLikelySupported,
  anthropicExtendedThinkingLikelySupported,
  anthropicThinkingRequestBetaTokens,
  buildAnthropicThinkingForStreamRequest,
} from './anthropicExtendedThinking'

describe('anthropicExtendedThinking (§10.1)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns null when alwaysThinking is off', () => {
    expect(
      buildAnthropicThinkingForStreamRequest({
        model: 'claude-sonnet-4-20250514',
        maxOutputTokens: 8192,
        alwaysThinking: false,
      }),
    ).toBeNull()
  })

  it('returns null for non-Anthropic-style model ids', () => {
    expect(
      buildAnthropicThinkingForStreamRequest({
        model: 'qwen-plus',
        maxOutputTokens: 8192,
        alwaysThinking: true,
      }),
    ).toBeNull()
  })

  it('treats DeepSeek reasoning / v4 models as thinking-capable', () => {
    // DeepSeek 的 Anthropic 兼容接口明确支持 `thinking` 字段（budget_tokens 被忽略）。
    // 仅 `deepseek-reasoner`（即将弃用）与 `deepseek-v4-*` 命中扩展思考启发式，
    // 兼容模式下 budget_tokens 会被服务端忽略但不会报错。
    expect(anthropicExtendedThinkingLikelySupported('deepseek-reasoner')).toBe(true)
    expect(anthropicExtendedThinkingLikelySupported('deepseek-v4-pro')).toBe(true)
    expect(anthropicExtendedThinkingLikelySupported('deepseek-v4-flash')).toBe(true)
    // 而即将弃用的 `deepseek-chat` 只对应非思考模式，保持屏蔽。
    expect(anthropicExtendedThinkingLikelySupported('deepseek-chat')).toBe(false)
    const t = buildAnthropicThinkingForStreamRequest({
      model: 'deepseek-v4-pro',
      maxOutputTokens: 8192,
      alwaysThinking: true,
    })
    expect(t).toEqual({ type: 'enabled', budget_tokens: 8191 })
  })

  it('returns null when max_output headroom is too small', () => {
    expect(
      buildAnthropicThinkingForStreamRequest({
        model: 'claude-sonnet-4-20250514',
        maxOutputTokens: 1024,
        alwaysThinking: true,
      }),
    ).toBeNull()
  })

  it('uses adaptive for Sonnet 4.5-style ids', () => {
    expect(anthropicAdaptiveThinkingLikelySupported('claude-sonnet-4-5-20250929')).toBe(true)
    const t = buildAnthropicThinkingForStreamRequest({
      model: 'claude-sonnet-4-5-20250929',
      maxOutputTokens: 8192,
      alwaysThinking: true,
    })
    expect(t).toEqual({ type: 'adaptive' })
  })

  it('uses enabled + budget for Sonnet 4 (non-4.5)', () => {
    expect(anthropicAdaptiveThinkingLikelySupported('claude-sonnet-4-20250514')).toBe(false)
    const t = buildAnthropicThinkingForStreamRequest({
      model: 'claude-sonnet-4-20250514',
      maxOutputTokens: 8192,
      alwaysThinking: true,
    })
    expect(t).toEqual({ type: 'enabled', budget_tokens: 8191 })
  })

  it('caps Haiku thinking budget', () => {
    const t = buildAnthropicThinkingForStreamRequest({
      model: 'claude-haiku-4-5-20251001',
      maxOutputTokens: 32_000,
      alwaysThinking: true,
    })
    expect(t?.type).toBe('enabled')
    if (t?.type === 'enabled') {
      expect(t.budget_tokens).toBe(4096)
    }
  })

  it('detects Bedrock-style model arns/names', () => {
    expect(anthropicExtendedThinkingLikelySupported('us.anthropic.claude-sonnet-4-20250514-v1:0')).toBe(
      true,
    )
  })

  it('exposes optional thinking beta tokens from env', () => {
    vi.stubEnv('POLE_ANTHROPIC_THINKING_BETA', ' beta-a , beta-b ')
    expect(anthropicThinkingRequestBetaTokens(true)).toEqual(['beta-a', 'beta-b'])
    expect(anthropicThinkingRequestBetaTokens(false)).toEqual([])
  })
})
