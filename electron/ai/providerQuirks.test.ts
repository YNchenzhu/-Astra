import { describe, it, expect } from 'vitest'
import {
  BUILTIN_QUIRKS,
  dashscopeModelSupportsThinking,
  getProviderQuirks,
  modelLikelySupportsVision,
  quirksIsThirdPartyAnthropicCompat,
  quirksUseAnthropicWire,
} from './providerQuirks'
import type { ProviderConfig } from './client'

function mkConfig(id: ProviderConfig['id'], baseUrl?: string): ProviderConfig {
  return {
    id,
    name: id,
    apiKey: 'k',
    ...(baseUrl ? { baseUrl } : {}),
  }
}

describe('getProviderQuirks', () => {
  it('official anthropic is full-feature', () => {
    const q = getProviderQuirks(mkConfig('anthropic', 'https://api.anthropic.com'))
    expect(q.toolSchema).toBe('full')
    expect(q.supportsCacheControl).toBe(true)
    expect(q.supportsThinkingBlocks).toBe(true)
    expect(q.supportsBetaHeaders).toBe(true)
    expect(q.useAnthropicCompatHttpClient).toBe(false)
    expect(q.wire).toBe('anthropic')
  })

  it('anthropic with non-official baseUrl is routed as compat', () => {
    const q = getProviderQuirks(mkConfig('anthropic', 'https://gateway.example/v1'))
    expect(q.wire).toBe('anthropic-compat')
    expect(q.supportsCacheControl).toBe(false)
    expect(q.supportsThinkingBlocks).toBe(true)
    expect(q.useAnthropicCompatHttpClient).toBe(true)
  })

  it('allows custom Anthropic thinking support to be disabled explicitly', () => {
    const q = getProviderQuirks({
      ...mkConfig('anthropic', 'https://gateway.example/v1'),
      anthropicThinkingCapability: 'unsupported',
    })
    expect(q.supportsThinkingBlocks).toBe(false)
  })

  it('all Chinese Anthropic-compat gateways route through compat HTTP client', () => {
    for (const id of ['zhipu', 'kimi', 'deepseek', 'dashscope', 'minimax'] as const) {
      const q = getProviderQuirks(mkConfig(id))
      expect(q.useAnthropicCompatHttpClient, `${id} should use compat HTTP`).toBe(true)
      expect(q.wire).toBe('anthropic-compat')
      expect(q.supportsCacheControl, `${id} no cache_control`).toBe(false)
      // 这五家 Anthropic 兼容端点均已确认支持 `thinking` 字段（各家官方文档：
      // 智谱「深度思考」、Kimi「Using Thinking Models」、DeepSeek anthropic 指南、
      // 阿里百炼 Anthropic 兼容、MiniMax Anthropic SDK）。
      expect(q.supportsThinkingBlocks, `${id} thinking blocks`).toBe(true)
    }
  })

  it('compat gateways that mandate verbatim reasoning echo set thinkingRequiresHistoryEcho', () => {
    // DeepSeek（改动 thinking 块即 400）、Kimi（k2.6/k2.7-code Preserved
    // Thinking 强制开启）、MiniMax（Interleaved Thinking 要求原样回传）都必须
    // 把历史 thinking 块原样回传；智谱 / 通义不强制。
    for (const id of ['deepseek', 'kimi', 'minimax'] as const) {
      expect(
        getProviderQuirks(mkConfig(id)).thinkingRequiresHistoryEcho,
        `${id} strict echo`,
      ).toBe(true)
    }
    for (const id of ['zhipu', 'dashscope'] as const) {
      expect(
        getProviderQuirks(mkConfig(id)).thinkingRequiresHistoryEcho ?? false,
        `${id} no strict echo`,
      ).toBe(false)
    }
  })

  it('all Anthropic-compat gateways default to a 64000 max_tokens cap', () => {
    for (const id of ['zhipu', 'kimi', 'deepseek', 'dashscope', 'minimax'] as const) {
      const q = getProviderQuirks(mkConfig(id))
      expect(q.maxTokensCap, `${id} cap`).toBe(64_000)
    }
    // Third-party Anthropic relay (custom baseUrl) inherits the same ceiling —
    // this is the DeepSeek-via-claude-endpoint case.
    const relay = getProviderQuirks(mkConfig('anthropic', 'https://relay.example/anthropic'))
    expect(relay.maxTokensCap).toBe(64_000)
  })

  it('DeepSeek Anthropic-compat opts into thinking and effort per official docs', () => {
    const q = getProviderQuirks(mkConfig('deepseek'))
    expect(q.supportsThinkingBlocks).toBe(true)
    expect(q.supportsEffort).toBe(true)
    expect(q.supportsCacheControl).toBe(false)
    expect(q.supportsBetaHeaders).toBe(false)
  })

  it('native gemini uses strict-subset schema policy', () => {
    const q = getProviderQuirks(mkConfig('gemini'))
    expect(q.toolSchema).toBe('strict-subset')
    expect(q.wire).toBe('gemini-native')
    expect(q.useAnthropicCompatHttpClient).toBe(false)
  })

  it('native openai keeps full schema', () => {
    const q = getProviderQuirks(mkConfig('openai'))
    expect(q.toolSchema).toBe('full')
    expect(q.wire).toBe('openai-native')
  })

  it('openai2 is compat-leaning but keeps full schema', () => {
    const q = getProviderQuirks(mkConfig('openai2'))
    expect(q.wire).toBe('openai2-native')
    expect(q.preferCompatibleHttp).toBe(true)
  })

  it('compatible provider with /anthropic baseUrl routes through compat HTTP', () => {
    const q = getProviderQuirks(mkConfig('compatible', 'https://custom.example/anthropic'))
    expect(q.wire).toBe('anthropic-compat')
    expect(q.useAnthropicCompatHttpClient).toBe(true)
  })

  it('compatible provider with Gemini-ish baseUrl routes as Gemini compat', () => {
    const q = getProviderQuirks(
      mkConfig('compatible', 'https://generativelanguage.googleapis.com/v1beta'),
    )
    expect(q.wire).toBe('gemini-compat')
  })

  it('compatible provider with generic baseUrl defaults to openai-compat', () => {
    const q = getProviderQuirks(mkConfig('compatible', 'https://custom.example/v1'))
    expect(q.wire).toBe('openai-compat')
    expect(q.useAnthropicCompatHttpClient).toBe(false)
  })
})

describe('BUILTIN_QUIRKS', () => {
  it('has an entry for every built-in provider id', () => {
    const ids = [
      'anthropic',
      'openai',
      'openai2',
      'gemini',
      'bedrock',
      'vertex',
      'foundry',
      'compatible',
      'dashscope',
      'minimax',
      'zhipu',
      'kimi',
      'deepseek',
    ] as const
    for (const id of ids) {
      expect(BUILTIN_QUIRKS[id], `missing quirks for ${id}`).toBeDefined()
    }
  })
})

describe('modelLikelySupportsVision', () => {
  it('recognises Claude / Gemini 1.5+ / GPT-4o / GPT-5 vision families', () => {
    for (const m of [
      'claude-sonnet-4-5-20251001',
      'claude-opus-4-7',
      'claude-haiku-4-5-20251001',
      'anthropic.claude-sonnet-4-5',
      'gemini-1.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-3-pro',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-5',
      'gpt-5-thinking',
      'o3',
      'o4-mini',
      'gpt-4-vision-preview',
    ]) {
      expect(modelLikelySupportsVision(m), `${m} should be vision-capable`).toBe(true)
    }
  })

  it('recognises Chinese vision SKUs reachable through Anthropic-compat gateways', () => {
    for (const m of [
      // Qwen-VL (DashScope)
      'qwen3-vl-plus',
      'qwen2.5-vl-72b-instruct',
      'qwen-vl-max',
      // DashScope Qwen 3.5+ Plus/Flash multimodal lineup (Anthropic-compat
      // endpoint accepts image blocks for these per Aliyun vision-model docs)
      'qwen3.7-plus',
      'qwen3.7-plus-2026-05-26',
      'qwen3.6-plus',
      'qwen3.6-flash',
      'qwen3.5-plus',
      'qwen3.5-flash',
      // Moonshot vision
      'moonshot-v1-32k-vision-preview',
      'moonshot-v1-8k-vision-preview',
      // Zhipu GLM-4V / GLM-5V
      'glm-4v',
      'glm-4v-plus',
      'glm-4.1v-flash',
      'glm-5v',
      // MiniMax vision
      'minimax-vl-01',
      // MiniMax M3+ — natively multimodal (image/video input), 2026-06
      'MiniMax-M3',
      'minimax-m3',
      'MiniMax-M3-highspeed',
      // DeepSeek-VL
      'deepseek-vl-7b-chat',
      // Generic tokens
      'some-multimodal-model',
      'custom-model-vision',
    ]) {
      expect(modelLikelySupportsVision(m), `${m} should be vision-capable`).toBe(true)
    }
  })

  it('returns false for plain text models on the same providers', () => {
    for (const m of [
      'kimi-k2.5',
      'kimi-k2-thinking',
      'glm-4.7',
      'glm-4.5-air',
      'qwen3-max',
      // Qwen Max family is TEXT-ONLY (Aliyun vision-model doc + DashScope
      // gateway rejects image blocks with 400 "Unexpected item type in
      // content."). Regression guard for the 2026-06 over-broad whitelist
      // that matched `qwen3.7-max` and caused exactly that 400 in production.
      'qwen3.7-max',
      'qwen3.7-max-2026-05-20',
      'qwen3.6-max-preview',
      'qwen-plus',
      'deepseek-v4-pro',
      'deepseek-chat',
      'MiniMax-M2.7',
      'MiniMax-M2.5-highspeed',
      'gpt-3.5-turbo',
      'gemini-1.0-pro',
      '',
    ]) {
      expect(modelLikelySupportsVision(m), `${m} should NOT be vision-capable`).toBe(false)
    }
  })

  it('tolerates undefined / null / whitespace', () => {
    expect(modelLikelySupportsVision(undefined)).toBe(false)
    expect(modelLikelySupportsVision(null)).toBe(false)
    expect(modelLikelySupportsVision('   ')).toBe(false)
  })
})

describe('dashscopeModelSupportsThinking', () => {
  it('returns true for thinking-capable Qwen SKUs', () => {
    for (const m of [
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.6-plus',
      'qwen3-max',
      'qwen3.5-plus',
      'qwen3.5-flash',
      'qwen-plus',
      'qwen-turbo',
      'qwen-max',
      'qwq-plus',
      // Qwen3-VL supports thinking and must NOT be caught by the legacy
      // qwen-vl-* exclusion.
      'qwen3-vl-plus',
      'qwen3-vl-flash',
    ]) {
      expect(dashscopeModelSupportsThinking(m), `${m} should allow thinking`).toBe(true)
    }
  })

  it('returns false for Qwen families that reject the thinking param', () => {
    for (const m of [
      // Coder family — no thinking mode.
      'qwen3-coder-plus',
      'qwen3-coder-next',
      'qwen3-coder-flash',
      'qwen3-coder-plus-2025-09-23',
      // Long-context model — no thinking.
      'qwen-long',
      // Legacy Qwen2.x VL.
      'qwen-vl-max',
      'qwen-vl-plus',
    ]) {
      expect(dashscopeModelSupportsThinking(m), `${m} should skip thinking`).toBe(false)
    }
  })

  it('tolerates undefined / null / whitespace', () => {
    expect(dashscopeModelSupportsThinking(undefined)).toBe(false)
    expect(dashscopeModelSupportsThinking(null)).toBe(false)
    expect(dashscopeModelSupportsThinking('   ')).toBe(false)
  })
})

describe('quirks helpers', () => {
  it('quirksUseAnthropicWire detects both official and compat', () => {
    expect(
      quirksUseAnthropicWire(getProviderQuirks(mkConfig('anthropic', 'https://api.anthropic.com'))),
    ).toBe(true)
    expect(quirksUseAnthropicWire(getProviderQuirks(mkConfig('zhipu')))).toBe(true)
    expect(quirksUseAnthropicWire(getProviderQuirks(mkConfig('openai')))).toBe(false)
  })

  it('quirksIsThirdPartyAnthropicCompat only for compat wire', () => {
    expect(
      quirksIsThirdPartyAnthropicCompat(
        getProviderQuirks(mkConfig('anthropic', 'https://api.anthropic.com')),
      ),
    ).toBe(false)
    expect(
      quirksIsThirdPartyAnthropicCompat(getProviderQuirks(mkConfig('zhipu'))),
    ).toBe(true)
  })
})
