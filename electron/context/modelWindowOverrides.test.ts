import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetModelWindowOverridesForTest,
  clearUserContextWindowOverride,
  getOverrideContextWindowTokens,
  getRegistryContextWindows,
  getUserContextWindowOverrides,
  setRegistryContextWindows,
  setUserContextWindowOverride,
  setUserContextWindowOverridesBulk,
} from './modelWindowOverrides'
import { getModelContextWindowTokens } from './openClaudeParityConstants'

afterEach(() => {
  __resetModelWindowOverridesForTest()
})

describe('modelWindowOverrides — store semantics', () => {
  it('set / get / clear single user override', () => {
    expect(setUserContextWindowOverride('my-model', 256_000)).toBe(true)
    expect(getOverrideContextWindowTokens('my-model')).toBe(256_000)
    clearUserContextWindowOverride('my-model')
    expect(getOverrideContextWindowTokens('my-model')).toBeUndefined()
  })

  it('lookup is case-insensitive on model id', () => {
    setUserContextWindowOverride('Qwen3.6-Plus', 256_000)
    expect(getOverrideContextWindowTokens('qwen3.6-plus')).toBe(256_000)
    expect(getOverrideContextWindowTokens('QWEN3.6-PLUS')).toBe(256_000)
  })

  it('user override wins over registry-declared window', () => {
    setRegistryContextWindows({ 'qwen3.6-plus': 128_000 })
    expect(getOverrideContextWindowTokens('qwen3.6-plus')).toBe(128_000)
    setUserContextWindowOverride('qwen3.6-plus', 256_000)
    expect(getOverrideContextWindowTokens('qwen3.6-plus')).toBe(256_000)
  })

  it('rejects invalid windows (non-positive, NaN, > 100M)', () => {
    expect(setUserContextWindowOverride('m', 0)).toBe(false)
    expect(setUserContextWindowOverride('m', -1)).toBe(false)
    expect(setUserContextWindowOverride('m', NaN)).toBe(false)
    expect(setUserContextWindowOverride('m', 200_000_000)).toBe(false)
    expect(getOverrideContextWindowTokens('m')).toBeUndefined()
  })

  it('setRegistryContextWindows replaces wholesale, ignores invalid entries', () => {
    setRegistryContextWindows({ a: 256_000, b: 128_000 })
    setRegistryContextWindows({ c: 1_000_000, bad: -1 as number, also: NaN as number })
    const snap = getRegistryContextWindows()
    expect(snap).toEqual({ c: 1_000_000 })
  })

  it('setUserContextWindowOverridesBulk replaces wholesale', () => {
    setUserContextWindowOverride('a', 100_000)
    setUserContextWindowOverridesBulk({ b: 200_000 })
    expect(getOverrideContextWindowTokens('a')).toBeUndefined()
    expect(getOverrideContextWindowTokens('b')).toBe(200_000)
  })

  it('snapshots are alphabetical', () => {
    setUserContextWindowOverride('zebra', 128_000)
    setUserContextWindowOverride('alpha', 256_000)
    setUserContextWindowOverride('mango', 200_000)
    expect(Object.keys(getUserContextWindowOverrides())).toEqual(['alpha', 'mango', 'zebra'])
  })
})

describe('getModelContextWindowTokens — resolution priority', () => {
  it('user override wins over regex tier', () => {
    // Without override, `qwen-3-max` regex says 256k; user picks 100k.
    expect(getModelContextWindowTokens('qwen-3-max')).toBe(256_000)
    setUserContextWindowOverride('qwen-3-max', 100_000)
    expect(getModelContextWindowTokens('qwen-3-max')).toBe(100_000)
  })

  it('registry-declared window wins over regex tier', () => {
    // qwen-2.5 hits the 128k regex tier. Registry can set it to 1M.
    expect(getModelContextWindowTokens('qwen-2.5')).toBe(128_000)
    setRegistryContextWindows({ 'qwen-2.5': 1_000_000 })
    expect(getModelContextWindowTokens('qwen-2.5')).toBe(1_000_000)
  })

  it('user override wins over registry', () => {
    setRegistryContextWindows({ 'qwen3.6-plus': 256_000 })
    setUserContextWindowOverride('qwen3.6-plus', 512_000)
    expect(getModelContextWindowTokens('qwen3.6-plus')).toBe(512_000)
  })

  it('falls through to regex when neither user nor registry has the id', () => {
    expect(getModelContextWindowTokens('claude-sonnet-4-foo')).toBe(200_000)
    expect(getModelContextWindowTokens('grok-4')).toBe(256_000)
  })

  it('falls through to MODEL_CONTEXT_WINDOW_DEFAULT (200K) for fully unknown ids', () => {
    expect(getModelContextWindowTokens('totally-novel-model-xyz')).toBe(200_000)
  })

  it('CLAUDE_CODE_DISABLE_1M_CONTEXT downgrades 1M overrides too', () => {
    setUserContextWindowOverride('big-model', 1_000_000)
    const prev = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
    try {
      expect(getModelContextWindowTokens('big-model')).toBe(200_000)
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
      else process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = prev
    }
  })

  it('ENV POLE_CONTEXT_WINDOW_TOKENS still wins over user override', () => {
    setUserContextWindowOverride('pinned', 100_000)
    const prev = process.env.POLE_CONTEXT_WINDOW_TOKENS
    process.env.POLE_CONTEXT_WINDOW_TOKENS = '999000'
    try {
      expect(getModelContextWindowTokens('pinned')).toBe(999_000)
    } finally {
      if (prev === undefined) delete process.env.POLE_CONTEXT_WINDOW_TOKENS
      else process.env.POLE_CONTEXT_WINDOW_TOKENS = prev
    }
  })
})
