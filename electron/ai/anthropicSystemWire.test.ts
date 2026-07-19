import { describe, it, expect, afterEach } from 'vitest'
import { buildAnthropicSystemParam } from './anthropicSystemWire'

describe('buildAnthropicSystemParam (Stage 1: blocks + cache on by default)', () => {
  const layers = { systemContext: 'STATIC', userContext: 'DYNAMIC', userMessageContext: '' }

  afterEach(() => {
    delete process.env.POLE_ANTHROPIC_SYSTEM_BLOCKS_DISABLE
    delete process.env.POLE_ANTHROPIC_SYSTEM_BLOCK_CACHE_DISABLE
    delete process.env.POLE_ANTHROPIC_SYSTEM_BLOCKS
    delete process.env.POLE_ANTHROPIC_SYSTEM_BLOCK_CACHE
  })

  it('default — emits two text blocks with ephemeral cache on the prefix', () => {
    const r = buildAnthropicSystemParam('MERGED', layers) as Array<{
      type: string
      text: string
      cache_control?: { type: string }
    }>
    expect(Array.isArray(r)).toBe(true)
    expect(r).toHaveLength(2)
    expect(r[0]!.type).toBe('text')
    expect(r[0]!.text).toBe('STATIC')
    expect(r[0]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(r[1]!.text).toBe('DYNAMIC')
    expect(r[1]!.cache_control).toBeUndefined()
  })

  it('opt-out — POLE_ANTHROPIC_SYSTEM_BLOCKS_DISABLE=1 forces the merged-string path', () => {
    process.env.POLE_ANTHROPIC_SYSTEM_BLOCKS_DISABLE = '1'
    expect(buildAnthropicSystemParam('MERGED', layers)).toBe('MERGED')
  })

  it('opt-out — POLE_ANTHROPIC_SYSTEM_BLOCK_CACHE_DISABLE=1 keeps blocks but drops cache_control', () => {
    process.env.POLE_ANTHROPIC_SYSTEM_BLOCK_CACHE_DISABLE = '1'
    const r = buildAnthropicSystemParam('M', layers) as Array<{
      cache_control?: { type: string }
    }>
    expect(Array.isArray(r)).toBe(true)
    expect(r[0]!.cache_control).toBeUndefined()
    expect(r[1]!.cache_control).toBeUndefined()
  })

  it('legacy enable flags are no-ops (set or not set, default behavior is the same)', () => {
    // POLE_ANTHROPIC_SYSTEM_BLOCKS=1 was the old opt-in marker; with the new
    // default that matches the same behavior, leaving it set must produce
    // identical output to leaving it unset. Same for the cache flag.
    process.env.POLE_ANTHROPIC_SYSTEM_BLOCKS = '1'
    process.env.POLE_ANTHROPIC_SYSTEM_BLOCK_CACHE = '1'
    const r1 = buildAnthropicSystemParam('M', layers)
    delete process.env.POLE_ANTHROPIC_SYSTEM_BLOCKS
    delete process.env.POLE_ANTHROPIC_SYSTEM_BLOCK_CACHE
    const r2 = buildAnthropicSystemParam('M', layers)
    expect(r1).toEqual(r2)
  })

  it('falls back to merged string when layers are absent', () => {
    expect(buildAnthropicSystemParam('FALL', undefined)).toBe('FALL')
  })

  it('falls back to merged string when both layer fields are empty', () => {
    expect(
      buildAnthropicSystemParam('FALL', {
        systemContext: '',
        userContext: '',
        userMessageContext: '',
      }),
    ).toBe('FALL')
  })

  it('only userContext present: single block, no cache_control (no stable prefix to cache)', () => {
    const r = buildAnthropicSystemParam('FALL', {
      systemContext: '',
      userContext: 'U',
      userMessageContext: '',
    }) as Array<{ text: string; cache_control?: unknown }>
    expect(r).toHaveLength(1)
    expect(r[0]!.text).toBe('U')
    expect(r[0]!.cache_control).toBeUndefined()
  })

  it('returns undefined when both merged and layers are absent/empty', () => {
    expect(buildAnthropicSystemParam(undefined, undefined)).toBeUndefined()
    expect(buildAnthropicSystemParam('', undefined)).toBeUndefined()
  })
})
