import { describe, it, expect } from 'vitest'
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  COMPACT_PLANNING_WINDOW_CAP_TOKENS,
  MANUAL_COMPACT_BUFFER_TOKENS,
  deriveContextThresholdsFromOpenClaudeWindow,
  getCompactPlanningWindowTokens,
  getContextCollapseDrainThresholdTokens,
  getEffectiveContextWindowTokens,
  getModelContextWindowTokens,
} from './openClaudeParityConstants'

/**
 * upstream 上下文报告 §6.3 — threshold ordering and auto-compact buffer (AC-6.4).
 */
describe('deriveContextThresholdsFromOpenClaudeWindow', () => {
  const W = 180_000

  it('auto-compact tier equals effective window minus AUTOCOMPACT_BUFFER_TOKENS', () => {
    const th = deriveContextThresholdsFromOpenClaudeWindow(W)
    expect(th.autoCompactTokens).toBe(Math.max(12_000, W - AUTOCOMPACT_BUFFER_TOKENS))
    expect(th.autoCompactTokens).toBe(W - AUTOCOMPACT_BUFFER_TOKENS)
  })

  it('blocking tier uses manual compact buffer below window', () => {
    const th = deriveContextThresholdsFromOpenClaudeWindow(W)
    expect(th.blockingTokens).toBe(Math.max(16_000, W - MANUAL_COMPACT_BUFFER_TOKENS))
    expect(th.blockingTokens).toBe(W - MANUAL_COMPACT_BUFFER_TOKENS)
  })

  it('orders warning < error < micro < auto < blocking', () => {
    const th = deriveContextThresholdsFromOpenClaudeWindow(250_000)
    expect(th.warningTokens).toBeLessThan(th.errorTokens)
    expect(th.errorTokens).toBeLessThan(th.microCompactTokens)
    expect(th.microCompactTokens).toBeLessThan(th.autoCompactTokens)
    expect(th.autoCompactTokens).toBeLessThan(th.blockingTokens)
  })
})

describe('getModelContextWindowTokens', () => {
  it('recognizes 1M-tier models (GPT-4.1, Gemini Pro/Flash, DeepSeek V4 Pro, Qwen Turbo)', () => {
    expect(getModelContextWindowTokens('deepseek-v4-pro')).toBe(1_000_000)
    expect(getModelContextWindowTokens('openrouter/deepseek/deepseek-v4-pro-0326')).toBe(1_000_000)
    expect(getModelContextWindowTokens('gpt-4.1')).toBe(1_000_000)
    expect(getModelContextWindowTokens('gpt-4.1-mini')).toBe(1_000_000)
    expect(getModelContextWindowTokens('gemini-1.5-pro')).toBe(1_000_000)
    expect(getModelContextWindowTokens('gemini-2.5-flash')).toBe(1_000_000)
    expect(getModelContextWindowTokens('qwen-2.5-turbo')).toBe(1_000_000)
    expect(getModelContextWindowTokens('qwen-3-turbo')).toBe(1_000_000)
    expect(getModelContextWindowTokens('qwen3-coder-plus')).toBe(1_000_000)
    expect(getModelContextWindowTokens('qwen3-coder-next')).toBe(1_000_000)
    expect(getEffectiveContextWindowTokens('deepseek-v4-pro')).toBe(980_000)
  })

  it('recognizes 1M via generic suffix (kimi-k2-1m, glm-4.6-1m, grok-4-1m, [1M])', () => {
    expect(getModelContextWindowTokens('kimi-k2-1m')).toBe(1_000_000)
    expect(getModelContextWindowTokens('glm-4.6-1m')).toBe(1_000_000)
    expect(getModelContextWindowTokens('grok-4-1m')).toBe(1_000_000)
    expect(getModelContextWindowTokens('claude-sonnet-4-5-[1M]')).toBe(1_000_000)
    expect(getModelContextWindowTokens('something-1m-context')).toBe(1_000_000)
  })

  it('recognizes 256k-tier (Grok 3/4 base, Kimi K2, Qwen Max, Qwen3.5+ Plus/Flash)', () => {
    expect(getModelContextWindowTokens('grok-4')).toBe(256_000)
    expect(getModelContextWindowTokens('grok-3-beta')).toBe(256_000)
    expect(getModelContextWindowTokens('kimi-k2')).toBe(256_000)
    expect(getModelContextWindowTokens('qwen-3-max')).toBe(256_000)
    expect(getModelContextWindowTokens('qwen3-max')).toBe(256_000)
    // Aliyun DashScope Qwen3.5+/3.6+/3.7+ Plus|Flash variants
    expect(getModelContextWindowTokens('qwen3.5-plus')).toBe(256_000)
    expect(getModelContextWindowTokens('qwen3.6-plus')).toBe(256_000)
    expect(getModelContextWindowTokens('qwen3.5-flash')).toBe(256_000)
  })

  it('recognizes 200k-tier (Claude 3/4 family)', () => {
    expect(getModelContextWindowTokens('claude-sonnet-4-20250514')).toBe(200_000)
    expect(getModelContextWindowTokens('claude-opus-4-20250514')).toBe(200_000)
    expect(getModelContextWindowTokens('claude-3-5-sonnet-20241022')).toBe(200_000)
    expect(getModelContextWindowTokens('claude-3-7-sonnet-20250219')).toBe(200_000)
  })

  it('recognizes 128k-tier (GPT-4 Turbo/4o/5, DeepSeek V3, GLM-4, Qwen base, Llama 3.1)', () => {
    expect(getModelContextWindowTokens('gpt-4-turbo')).toBe(128_000)
    expect(getModelContextWindowTokens('gpt-4o')).toBe(128_000)
    expect(getModelContextWindowTokens('gpt-5')).toBe(128_000)
    expect(getModelContextWindowTokens('deepseek-chat')).toBe(128_000)
    expect(getModelContextWindowTokens('deepseek-v3')).toBe(128_000)
    expect(getModelContextWindowTokens('deepseek-coder-v2')).toBe(128_000)
    expect(getModelContextWindowTokens('glm-4')).toBe(128_000)
    expect(getModelContextWindowTokens('glm-4.5-air')).toBe(128_000)
    expect(getModelContextWindowTokens('glm-4.5-flash')).toBe(128_000)
    expect(getModelContextWindowTokens('qwen-2.5')).toBe(128_000)
    expect(getModelContextWindowTokens('qwen-3')).toBe(128_000)
    expect(getModelContextWindowTokens('qwen3')).toBe(128_000)
    expect(getModelContextWindowTokens('llama-3.1-70b')).toBe(128_000)
    expect(getModelContextWindowTokens('mistral-large-2411')).toBe(128_000)
  })

  it('does NOT misclassify Qwen3.5+/3.6+ point variants as 128k (regression: 94k showed 74% on qwen3.6-plus)', () => {
    // Before the tightened lookahead, `\b` between `3` and `.` made these
    // hit the 128k Qwen pattern. Confirm they stay on the 256k tier now.
    expect(getModelContextWindowTokens('qwen3.6-plus')).not.toBe(128_000)
    expect(getModelContextWindowTokens('qwen3.5-plus')).not.toBe(128_000)
  })

  it('does NOT classify GLM-4.6+/4.7+ as 128k (falls through to 200k default)', () => {
    // Same defensive lookahead — `glm-4.6` / `glm-4.7` should not silently
    // be downgraded to 128k. They fall through to the 200k default until
    // an explicit registry entry is added.
    expect(getModelContextWindowTokens('glm-4.6')).not.toBe(128_000)
    expect(getModelContextWindowTokens('glm-4.7')).not.toBe(128_000)
  })

  it('recognizes legacy/small tiers', () => {
    expect(getModelContextWindowTokens('gpt-4-32k')).toBe(32_000)
    expect(getModelContextWindowTokens('gpt-3.5-turbo-16k')).toBe(16_000)
    expect(getModelContextWindowTokens('moonshot-v1-8k')).toBe(8_000)
  })

  it('falls back to 200k default when the model name is unknown', () => {
    expect(getModelContextWindowTokens('some-unknown-model-xyz')).toBe(200_000)
  })

  describe('compact-planning window cap (Codex-parity proactive compaction)', () => {
    it('caps 1M models at COMPACT_PLANNING_WINDOW_CAP_TOKENS', () => {
      expect(getCompactPlanningWindowTokens('qwen3-coder-plus')).toBe(
        COMPACT_PLANNING_WINDOW_CAP_TOKENS,
      )
      expect(getCompactPlanningWindowTokens('claude-sonnet-4-5-[1M]')).toBe(
        COMPACT_PLANNING_WINDOW_CAP_TOKENS,
      )
    })

    it('leaves models at or under the cap untouched', () => {
      expect(getCompactPlanningWindowTokens('claude-sonnet-4-6')).toBe(
        getEffectiveContextWindowTokens('claude-sonnet-4-6'),
      )
      expect(getCompactPlanningWindowTokens('kimi-k2')).toBe(
        getEffectiveContextWindowTokens('kimi-k2'),
      )
    })

    it('POLE_COMPACT_PLANNING_WINDOW_CAP_TOKENS overrides the cap; 0 disables it', () => {
      const prev = process.env.POLE_COMPACT_PLANNING_WINDOW_CAP_TOKENS
      try {
        process.env.POLE_COMPACT_PLANNING_WINDOW_CAP_TOKENS = '300000'
        expect(getCompactPlanningWindowTokens('qwen3-coder-plus')).toBe(300_000)
        process.env.POLE_COMPACT_PLANNING_WINDOW_CAP_TOKENS = '0'
        expect(getCompactPlanningWindowTokens('qwen3-coder-plus')).toBe(980_000)
      } finally {
        if (prev === undefined) delete process.env.POLE_COMPACT_PLANNING_WINDOW_CAP_TOKENS
        else process.env.POLE_COMPACT_PLANNING_WINDOW_CAP_TOKENS = prev
      }
    })

    it('keeps the collapse-drain gate BELOW the capped auto-compact tier on 1M models', () => {
      const planning = getCompactPlanningWindowTokens('qwen3-coder-plus')
      const drain = getContextCollapseDrainThresholdTokens('qwen3-coder-plus')
      const { autoCompactTokens } = deriveContextThresholdsFromOpenClaudeWindow(planning)
      expect(drain).toBeLessThan(autoCompactTokens)
    })
  })

  it('ENV POLE_CONTEXT_WINDOW_TOKENS overrides registry', () => {
    const prev = process.env.POLE_CONTEXT_WINDOW_TOKENS
    process.env.POLE_CONTEXT_WINDOW_TOKENS = '420000'
    try {
      expect(getModelContextWindowTokens('deepseek-v4-pro')).toBe(420_000)
    } finally {
      if (prev === undefined) delete process.env.POLE_CONTEXT_WINDOW_TOKENS
      else process.env.POLE_CONTEXT_WINDOW_TOKENS = prev
    }
  })

  it('CLAUDE_CODE_DISABLE_1M_CONTEXT=1 forces 1M models back to default', () => {
    const prev = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
    try {
      expect(getModelContextWindowTokens('deepseek-v4-pro')).toBe(200_000)
      expect(getModelContextWindowTokens('gpt-4.1')).toBe(200_000)
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
      else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = prev
    }
  })
})
