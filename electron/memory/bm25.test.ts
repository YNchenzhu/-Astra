import { describe, expect, it, beforeEach } from 'vitest'
import { bm25Rank, tokenize, _clearBm25Cache } from './bm25'
import type { MemoryEntry } from './types'

function makeMem(
  name: string,
  content: string,
  opts: { description?: string; updated?: string } = {},
): MemoryEntry {
  return {
    filename: `${name}.md`,
    frontmatter: {
      name,
      description: opts.description ?? `Description of ${name}`,
      type: 'project',
      scope: 'project',
      enabled: true,
      tags: [],
      created: '2025-01-01T00:00:00Z',
      updated: opts.updated ?? '2025-01-01T00:00:00Z',
    },
    content,
    ageDays: 0,
    isStale: false,
  }
}

describe('bm25 tokenizer', () => {
  it('splits ASCII words and keeps CJK uni/bi-grams', () => {
    expect(tokenize('hello WORLD')).toEqual(['hello', 'world'])
    expect(tokenize('鉴权模块')).toContain('鉴权')
  })
})

describe('bm25 corpus cache invalidation (audit M3)', () => {
  beforeEach(() => {
    _clearBm25Cache()
  })

  it('busts the cache on a SAME-LENGTH body edit with an unchanged `updated` stamp', () => {
    // Identical length AND identical `updated` — the prior length+updated key
    // would NOT have invalidated, returning stale rankings. The content-hash
    // key must catch it.
    const mem = makeMem('m1', 'alpha alpha alpha') // 17 chars
    expect(bm25Rank('alpha', [mem]).length).toBe(1)

    mem.content = 'gamma gamma gamma' // also 17 chars, same `updated`
    expect(bm25Rank('alpha', [mem]).length).toBe(0)
    expect(bm25Rank('gamma', [mem]).length).toBe(1)
  })

  it('busts the cache when only `description` changes (indexed head text)', () => {
    const mem = makeMem('m2', 'body text here', { description: 'redis cache notes' })
    expect(bm25Rank('redis', [mem]).length).toBe(1)

    mem.frontmatter.description = 'postgres index notes'
    expect(bm25Rank('redis', [mem]).length).toBe(0)
    expect(bm25Rank('postgres', [mem]).length).toBe(1)
  })

  it('reuses the cache when nothing indexed changed', () => {
    const mem = makeMem('m3', 'stable content about kafka streams')
    const first = bm25Rank('kafka', [mem])
    const second = bm25Rank('kafka', [mem])
    expect(first.length).toBe(1)
    expect(second.length).toBe(1)
  })
})
