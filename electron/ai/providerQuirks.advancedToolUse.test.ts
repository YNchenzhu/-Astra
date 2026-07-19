/**
 * Coverage for the Advanced Tool Use (Examples + PTC) capability resolution in
 * {@link providerQuirks}. Critical because the same functions gate both the
 * schema layer and the beta-header latch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  BUILTIN_QUIRKS,
  modelSupportsAdvancedToolUse,
  resolvePtcEnabled,
  resolveToolExamplesMode,
} from './providerQuirks'

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

describe('modelSupportsAdvancedToolUse', () => {
  it('matches Opus 4.5+ and Sonnet 4.5+', () => {
    expect(modelSupportsAdvancedToolUse('claude-opus-4-5-20251101')).toBe(true)
    expect(modelSupportsAdvancedToolUse('claude-opus-4-6')).toBe(true)
    expect(modelSupportsAdvancedToolUse('claude-opus-4-7')).toBe(true)
    expect(modelSupportsAdvancedToolUse('claude-sonnet-4-5-20250929')).toBe(true)
    expect(modelSupportsAdvancedToolUse('claude-sonnet-4-6')).toBe(true)
  })

  it('rejects older / unrelated models', () => {
    expect(modelSupportsAdvancedToolUse('claude-3-5-sonnet')).toBe(false)
    expect(modelSupportsAdvancedToolUse('claude-sonnet-4-0')).toBe(false)
    expect(modelSupportsAdvancedToolUse('gpt-4o')).toBe(false)
    expect(modelSupportsAdvancedToolUse('gemini-2.0-flash')).toBe(false)
    expect(modelSupportsAdvancedToolUse('')).toBe(false)
    expect(modelSupportsAdvancedToolUse(undefined)).toBe(false)
    expect(modelSupportsAdvancedToolUse(null)).toBe(false)
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(modelSupportsAdvancedToolUse('  CLAUDE-OPUS-4-5  ')).toBe(true)
    expect(modelSupportsAdvancedToolUse('Claude-Sonnet-4-5')).toBe(true)
  })
})

describe('resolveToolExamplesMode', () => {
  it('returns native on Anthropic wire with eligible model', () => {
    expect(
      resolveToolExamplesMode(BUILTIN_QUIRKS.anthropic, 'claude-opus-4-5'),
    ).toBe('native')
  })

  it('returns description-fallback on Anthropic-compat (zhipu/kimi/…)', () => {
    expect(resolveToolExamplesMode(BUILTIN_QUIRKS.zhipu, 'claude-opus-4-5')).toBe(
      'description-fallback',
    )
    expect(resolveToolExamplesMode(BUILTIN_QUIRKS.kimi, 'claude-opus-4-5')).toBe(
      'description-fallback',
    )
  })

  it('returns description-fallback on OpenAI / Gemini wires', () => {
    expect(resolveToolExamplesMode(BUILTIN_QUIRKS.openai, 'gpt-4o')).toBe(
      'description-fallback',
    )
    expect(resolveToolExamplesMode(BUILTIN_QUIRKS.gemini, 'gemini-2.0-pro')).toBe(
      'description-fallback',
    )
    expect(resolveToolExamplesMode(BUILTIN_QUIRKS.openai2, 'gpt-4o')).toBe(
      'description-fallback',
    )
  })

  it('returns description-fallback on Anthropic wire with ineligible model', () => {
    expect(
      resolveToolExamplesMode(BUILTIN_QUIRKS.anthropic, 'claude-3-5-sonnet'),
    ).toBe('description-fallback')
  })

  it('Bedrock / Vertex / Foundry fall back (PTC disabled, beta not allowed)', () => {
    expect(
      resolveToolExamplesMode(BUILTIN_QUIRKS.bedrock, 'claude-opus-4-5'),
    ).toBe('description-fallback')
    expect(
      resolveToolExamplesMode(BUILTIN_QUIRKS.vertex, 'claude-opus-4-5'),
    ).toBe('description-fallback')
    expect(
      resolveToolExamplesMode(BUILTIN_QUIRKS.foundry, 'claude-opus-4-5'),
    ).toBe('description-fallback')
  })
})

describe('resolvePtcEnabled', () => {
  let savedEnv: string | undefined
  beforeEach(() => {
    savedEnv = process.env.POLE_PTC_ENABLED
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.POLE_PTC_ENABLED
    else process.env.POLE_PTC_ENABLED = savedEnv
  })

  it('disabled by default (no env var)', () => {
    withEnv('POLE_PTC_ENABLED', undefined, () => {
      expect(
        resolvePtcEnabled(BUILTIN_QUIRKS.anthropic, 'claude-opus-4-5'),
      ).toBe(false)
    })
  })

  it('requires POLE_PTC_ENABLED=1 to enable', () => {
    withEnv('POLE_PTC_ENABLED', '1', () => {
      expect(
        resolvePtcEnabled(BUILTIN_QUIRKS.anthropic, 'claude-opus-4-5'),
      ).toBe(true)
    })
  })

  it('respects supportsPTC=false on compat wires even with env var on', () => {
    withEnv('POLE_PTC_ENABLED', '1', () => {
      expect(resolvePtcEnabled(BUILTIN_QUIRKS.zhipu, 'claude-opus-4-5')).toBe(false)
      expect(resolvePtcEnabled(BUILTIN_QUIRKS.kimi, 'claude-opus-4-5')).toBe(false)
      expect(resolvePtcEnabled(BUILTIN_QUIRKS.deepseek, 'claude-opus-4-5')).toBe(
        false,
      )
      expect(resolvePtcEnabled(BUILTIN_QUIRKS.openai, 'gpt-4o')).toBe(false)
      expect(resolvePtcEnabled(BUILTIN_QUIRKS.gemini, 'gemini-2.0-pro')).toBe(
        false,
      )
      expect(
        resolvePtcEnabled(BUILTIN_QUIRKS.bedrock, 'claude-opus-4-5'),
      ).toBe(false)
    })
  })

  it('requires an eligible model even when quirks + env allow', () => {
    withEnv('POLE_PTC_ENABLED', '1', () => {
      expect(
        resolvePtcEnabled(BUILTIN_QUIRKS.anthropic, 'claude-3-5-sonnet'),
      ).toBe(false)
      expect(resolvePtcEnabled(BUILTIN_QUIRKS.anthropic, '')).toBe(false)
    })
  })
})

describe('BUILTIN_QUIRKS shape — all providers declare the two flags', () => {
  it('every provider has supportsToolExamples and supportsPTC defined', () => {
    for (const [id, q] of Object.entries(BUILTIN_QUIRKS)) {
      expect(
        typeof q.supportsToolExamples,
        `${id}.supportsToolExamples`,
      ).toBe('boolean')
      expect(typeof q.supportsPTC, `${id}.supportsPTC`).toBe('boolean')
    }
  })

  it('only api.anthropic.com is provisioned for native advanced tool use', () => {
    expect(BUILTIN_QUIRKS.anthropic.supportsToolExamples).toBe(true)
    expect(BUILTIN_QUIRKS.anthropic.supportsPTC).toBe(true)
    for (const id of ['bedrock', 'vertex', 'foundry'] as const) {
      expect(BUILTIN_QUIRKS[id].supportsToolExamples).toBe(false)
      expect(BUILTIN_QUIRKS[id].supportsPTC).toBe(false)
    }
    for (const id of [
      'zhipu',
      'kimi',
      'deepseek',
      'dashscope',
      'minimax',
      'openai',
      'openai2',
      'gemini',
      'compatible',
    ] as const) {
      expect(BUILTIN_QUIRKS[id].supportsToolExamples).toBe(false)
      expect(BUILTIN_QUIRKS[id].supportsPTC).toBe(false)
    }
  })
})
