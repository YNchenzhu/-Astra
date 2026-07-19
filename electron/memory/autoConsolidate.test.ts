import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  consolidateMemories,
  markExtractionComplete,
  qualityScore,
  resetConsolidationGate,
  resetEmbeddingProbeCacheForTests,
  probeEmbeddingAvailability,
  secondsSinceLastConsolidation,
} from './autoConsolidate'
import { resetExtractionStateForTests } from './extractionState'
import { parseFrontmatter } from './storage'
import type { MemoryEntry } from './types'

function makeEntry(
  name: string,
  description: string,
  type: MemoryEntry['frontmatter']['type'],
  content: string,
  updated: string = '2025-06-01T00:00:00.000Z',
): MemoryEntry {
  const filename = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 64) + '.md'
  return {
    filename,
    frontmatter: {
      name,
      description,
      type,
      created: '2025-01-01T00:00:00.000Z',
      updated,
      scope: 'project',
      enabled: true,
    },
    content,
    ageDays: 10,
    isStale: false,
  }
}

function writeEntryFile(dir: string, e: MemoryEntry): void {
  const lines = [
    '---',
    `name: ${e.frontmatter.name}`,
    `description: ${e.frontmatter.description}`,
    `type: ${e.frontmatter.type}`,
    `created: ${e.frontmatter.created}`,
    `updated: ${e.frontmatter.updated}`,
    `scope: ${e.frontmatter.scope ?? 'project'}`,
  ]
  if (e.frontmatter.enabled !== undefined) {
    lines.push(`enabled: ${e.frontmatter.enabled}`)
  }
  if (e.frontmatter.tags?.length) {
    lines.push(`tags: ${JSON.stringify(e.frontmatter.tags)}`)
  }
  lines.push('---', '', e.content)
  fs.writeFileSync(path.join(dir, e.filename), lines.join('\n'), 'utf-8')
}

describe('consolidation gate', () => {
  beforeEach(() => {
    resetExtractionStateForTests()
    resetConsolidationGate()
  })

  it('fires after 8 extraction cycles', () => {
    for (let i = 0; i < 7; i++) {
      expect(markExtractionComplete()).toBe(false)
    }
    expect(markExtractionComplete()).toBe(true)
  })

  it('resets after consolidation', () => {
    for (let i = 0; i < 8; i++) {
      markExtractionComplete()
    }
    resetConsolidationGate()
    expect(markExtractionComplete()).toBe(false)
  })

  it('secondsSinceLastConsolidation returns a finite number after first reset', () => {
    // beforeEach already called resetConsolidationGate(), so lastConsolidationAt is set
    expect(secondsSinceLastConsolidation()).toBeLessThan(1)
  })
})

describe('consolidateMemories — exact hash dedup (Pass 0)', () => {
  let testDir: string

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `consolidate-test-${Date.now()}`)
    fs.mkdirSync(testDir, { recursive: true })
    resetExtractionStateForTests()
    resetConsolidationGate()
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('merges files with identical content', async () => {
    const a = makeEntry('alpha', 'First', 'project', 'identical content here')
    const b = makeEntry('beta', 'Second', 'project', 'identical content here')
    writeEntryFile(testDir, a)
    writeEntryFile(testDir, b)

    const result = await consolidateMemories(testDir, { embedAvailable: false })
    expect(result.merged).toBeGreaterThanOrEqual(1)
  })

  it('does not merge files with different content', async () => {
    const a = makeEntry('alpha', 'First', 'project', 'content A')
    const b = makeEntry('beta', 'Second', 'project', 'content B')
    writeEntryFile(testDir, a)
    writeEntryFile(testDir, b)

    const result = await consolidateMemories(testDir, { embedAvailable: false })
    expect(result.merged).toBe(0)
  })
})

describe('consolidateMemories — name-based dedup (Pass 1)', () => {
  let testDir: string

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `consolidate-test-${Date.now()}`)
    fs.mkdirSync(testDir, { recursive: true })
    resetExtractionStateForTests()
    resetConsolidationGate()
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('merges files with the same frontmatter name', async () => {
    // Same frontmatter name but different filenames on disk
    const a = makeEntry('my-memory', 'First description', 'project', 'content A')
    const b = makeEntry('my-memory', 'Second description', 'project', 'content B')
    // Force different filenames so they don't overwrite each other
    a.filename = 'my-memory-v1.md'
    b.filename = 'my-memory-v2.md'
    writeEntryFile(testDir, a)
    writeEntryFile(testDir, b)

    const result = await consolidateMemories(testDir, { embedAvailable: false })
    expect(result.merged).toBeGreaterThanOrEqual(1)
  })
})

describe('consolidateMemories — stale pruning (Pass 4)', () => {
  let testDir: string

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `consolidate-test-${Date.now()}`)
    fs.mkdirSync(testDir, { recursive: true })
    resetExtractionStateForTests()
    resetConsolidationGate()
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('prunes stale disabled non-user entries', async () => {
    const oldDate = new Date(Date.now() - 61 * 86_400_000).toISOString() // 61 days ago
    const e = makeEntry('old-disabled', 'Old disabled', 'project', 'content', oldDate)
    e.ageDays = 61
    e.isStale = true
    e.frontmatter.enabled = false
    e.frontmatter.updated = oldDate
    writeEntryFile(testDir, e)

    const result = await consolidateMemories(testDir, { embedAvailable: false })
    expect(result.pruned).toBe(1)
  })

  it('does NOT prune stale user-type entries', async () => {
    const oldDate = new Date(Date.now() - 61 * 86_400_000).toISOString()
    const e = makeEntry('user-old', 'Old user memory', 'user', 'content', oldDate)
    e.ageDays = 61
    e.isStale = true
    e.frontmatter.enabled = false
    e.frontmatter.updated = oldDate
    writeEntryFile(testDir, e)

    const result = await consolidateMemories(testDir, { embedAvailable: false })
    expect(result.pruned).toBe(0)
  })

  it('does NOT prune entries that are less than 60 days old', async () => {
    const e = makeEntry('recent-disabled', 'Recent disabled', 'project', 'content', new Date().toISOString())
    e.frontmatter.enabled = false
    writeEntryFile(testDir, e)

    const result = await consolidateMemories(testDir, { embedAvailable: false })
    expect(result.pruned).toBe(0)
  })
})

describe('consolidateMemories — empty directory', () => {
  it('returns zero results for an empty directory', async () => {
    const testDir = path.join(os.tmpdir(), `empty-consolidate-${Date.now()}`)
    fs.mkdirSync(testDir, { recursive: true })
    resetExtractionStateForTests()
    resetConsolidationGate()

    try {
      const result = await consolidateMemories(testDir, { embedAvailable: false })
      expect(result.merged).toBe(0)
      expect(result.pruned).toBe(0)
      expect(result.compressed).toBe(0)
      expect(result.errors.length).toBe(0)
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })
})

describe('formatConsolidationSummary', () => {
  it('formats a summary with all fields', async () => {
    const { formatConsolidationSummary } = await import('./autoConsolidate')
    const result = formatConsolidationSummary({
      merged: 3,
      pruned: 2,
      compressed: 1,
      unchanged: 5,
      errors: ['test error'],
    })
    expect(result).toContain('3 组合并')
    expect(result).toContain('2 条清理')
    expect(result).toContain('1 条压缩')
    expect(result).toContain('1 个错误')
  })

  it('formats empty result', async () => {
    const { formatConsolidationSummary } = await import('./autoConsolidate')
    const result = formatConsolidationSummary({
      merged: 0,
      pruned: 0,
      compressed: 0,
      unchanged: 0,
      errors: [],
    })
    expect(result).toBe('无需整理')
  })
})

// ---------------------------------------------------------------------------
// New behaviour: quality scoring
// ---------------------------------------------------------------------------

describe('qualityScore', () => {
  it('rewards length, structure, and user scope', () => {
    const short = makeEntry('a', '', 'project', 'short text')
    const long = makeEntry(
      'b',
      '',
      'project',
      ['# Heading', 'paragraph one', '', '- item 1', '- item 2', '', '```ts', 'code()', '```'].join('\n'),
    )
    const userScoped = makeEntry('c', 'a description', 'user', 'text\nmore text\n')
    userScoped.frontmatter.scope = 'user'
    expect(qualityScore(long)).toBeGreaterThan(qualityScore(short))
    // Two short entries differ only by scope+description → user-scoped should win.
    expect(qualityScore(userScoped)).toBeGreaterThan(qualityScore(short))
  })

  it('penalises previously-compressed entries', () => {
    const fresh = makeEntry('a', '', 'project', 'paragraph paragraph paragraph')
    const compressed = makeEntry('b', '', 'project', 'paragraph paragraph paragraph')
    compressed.frontmatter.originalLength = 12000
    expect(qualityScore(fresh)).toBeGreaterThan(qualityScore(compressed))
  })
})

// ---------------------------------------------------------------------------
// New behaviour: merge priority uses quality, not bare `updated`
// ---------------------------------------------------------------------------

describe('consolidateMemories — quality-based keeper selection', () => {
  let testDir: string
  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `consolidate-quality-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(testDir, { recursive: true })
    resetExtractionStateForTests()
    resetConsolidationGate()
  })
  afterEach(() => fs.rmSync(testDir, { recursive: true, force: true }))

  it('keeps the longer / better-structured entry on identical-name dedup even when the snippet is newer', async () => {
    // Long well-structured entry is OLDER but higher quality.
    const long = makeEntry(
      'shared-name',
      'detailed reference',
      'reference',
      ['# Reference', 'paragraph', '', '```ts', 'function foo() {}', '```'].join('\n'),
      '2025-01-01T00:00:00.000Z',
    )
    long.filename = 'long.md'
    // Short snippet is NEWER but low quality.
    const short = makeEntry('shared-name', '', 'reference', 'tiny note', '2025-12-01T00:00:00.000Z')
    short.filename = 'short.md'
    writeEntryFile(testDir, long)
    writeEntryFile(testDir, short)

    const result = await consolidateMemories(testDir, { embedAvailable: false })
    expect(result.merged).toBeGreaterThanOrEqual(1)
    // The longer file should still exist; the shorter one should be gone.
    expect(fs.existsSync(path.join(testDir, 'long.md'))).toBe(true)
    expect(fs.existsSync(path.join(testDir, 'short.md'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// New behaviour: dry-run preview API
// ---------------------------------------------------------------------------

describe('consolidateMemories — dryRun preview', () => {
  let testDir: string
  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `consolidate-dry-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(testDir, { recursive: true })
    resetExtractionStateForTests()
    resetConsolidationGate()
  })
  afterEach(() => fs.rmSync(testDir, { recursive: true, force: true }))

  it('returns a plan and performs no file mutations', async () => {
    const a = makeEntry('alpha', 'First', 'project', 'identical body')
    a.filename = 'a.md'
    const b = makeEntry('beta', 'Second', 'project', 'identical body')
    b.filename = 'b.md'
    writeEntryFile(testDir, a)
    writeEntryFile(testDir, b)

    const result = await consolidateMemories(testDir, { embedAvailable: false, dryRun: true })

    expect(result.plan).toBeDefined()
    expect(result.plan!.merges.length).toBeGreaterThanOrEqual(1)
    const merge = result.plan!.merges[0]
    expect(merge.pass).toBe('hash')
    expect([merge.keep, merge.drop].sort()).toEqual(['a.md', 'b.md'])

    // Both files should still exist on disk.
    expect(fs.existsSync(path.join(testDir, 'a.md'))).toBe(true)
    expect(fs.existsSync(path.join(testDir, 'b.md'))).toBe(true)
    // Index file should NOT have been written.
    expect(fs.existsSync(path.join(testDir, 'MEMORY.md'))).toBe(false)
  })

  it('plan reports compress + prune actions without writing them', async () => {
    const oldDate = new Date(Date.now() - 61 * 86_400_000).toISOString()
    const stale = makeEntry('stale', '', 'project', 'tiny stale', oldDate)
    stale.frontmatter.enabled = false
    stale.frontmatter.updated = oldDate
    stale.ageDays = 61
    writeEntryFile(testDir, stale)

    const huge = makeEntry('huge', '', 'project', 'x'.repeat(4000))
    huge.filename = 'huge.md'
    writeEntryFile(testDir, huge)

    const result = await consolidateMemories(testDir, { embedAvailable: false, dryRun: true })
    expect(result.plan!.prunes.some((p) => p.filename === stale.filename)).toBe(true)
    expect(result.plan!.compresses.some((c) => c.filename === 'huge.md')).toBe(true)

    // No mutations.
    expect(fs.existsSync(path.join(testDir, stale.filename))).toBe(true)
    const hugeRaw = fs.readFileSync(path.join(testDir, 'huge.md'), 'utf-8')
    expect(hugeRaw).toContain('x'.repeat(4000))
  })
})

// ---------------------------------------------------------------------------
// New behaviour: compression integrity metadata
// ---------------------------------------------------------------------------

describe('consolidateMemories — compression integrity', () => {
  let testDir: string
  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `consolidate-compress-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(testDir, { recursive: true })
    resetExtractionStateForTests()
    resetConsolidationGate()
  })
  afterEach(() => fs.rmSync(testDir, { recursive: true, force: true }))

  it('writes originalLength / originalHash / truncatedHash to frontmatter and warns in body', async () => {
    const huge = makeEntry('huge', '', 'project', 'x'.repeat(4000))
    huge.filename = 'huge.md'
    writeEntryFile(testDir, huge)

    const result = await consolidateMemories(testDir, { embedAvailable: false })
    expect(result.compressed).toBe(1)

    const after = fs.readFileSync(path.join(testDir, 'huge.md'), 'utf-8')
    const parsed = parseFrontmatter(after)
    expect(parsed).not.toBeNull()
    expect(parsed!.frontmatter.originalLength).toBe(4000)
    expect(parsed!.frontmatter.originalHash).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed!.frontmatter.truncatedHash).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed!.content).toMatch(/irreversible/i)
  })
})

// ---------------------------------------------------------------------------
// New behaviour: incremental skip via consolidatedAt
// ---------------------------------------------------------------------------

describe('consolidateMemories — incremental skip via consolidatedAt', () => {
  let testDir: string
  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `consolidate-incremental-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(testDir, { recursive: true })
    resetExtractionStateForTests()
    resetConsolidationGate()
  })
  afterEach(() => fs.rmSync(testDir, { recursive: true, force: true }))

  it('stamps consolidatedAt on survivors after a sweep', async () => {
    const e = makeEntry('solo', '', 'project', 'a-unique-content-that-wont-merge with at least eighty characters of body')
    e.filename = 'solo.md'
    writeEntryFile(testDir, e)

    await consolidateMemories(testDir, { embedAvailable: false })

    const after = fs.readFileSync(path.join(testDir, 'solo.md'), 'utf-8')
    const parsed = parseFrontmatter(after)
    expect(parsed).not.toBeNull()
    expect(parsed!.frontmatter.consolidatedAt).toBeTruthy()
    // consolidatedAt should be ≥ updated → entry is "clean since last sweep".
    expect(parsed!.frontmatter.consolidatedAt! >= parsed!.frontmatter.updated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// New behaviour: embedding availability probe
// ---------------------------------------------------------------------------

describe('probeEmbeddingAvailability', () => {
  beforeEach(() => {
    resetEmbeddingProbeCacheForTests()
  })

  it('does not throw and returns a boolean (cache TTL covered separately)', async () => {
    const r = await probeEmbeddingAvailability()
    expect(typeof r).toBe('boolean')
  })
})
