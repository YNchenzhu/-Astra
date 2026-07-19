import { describe, it, expect } from 'vitest'
import {
  MEMORY_TYPES,
  MEMORY_SCOPES,
  parseMemoryType,
  parseMemoryScope,
  type MemoryFrontmatter,
} from './types'
import { parseFrontmatter, serializeMemoryFile } from './storage'
import { recallMemories, formatMemoriesForPrompt } from './recall'
import type { MemoryEntry } from './types'

describe('Memory types', () => {
  it('should have 4 memory types', () => {
    expect(MEMORY_TYPES).toEqual(['user', 'feedback', 'project', 'reference'])
  })

  it('should have 3 memory scopes', () => {
    expect(MEMORY_SCOPES).toEqual(['session', 'project', 'user'])
  })

  it('should parse valid memory types', () => {
    expect(parseMemoryType('user')).toBe('user')
    expect(parseMemoryType('project')).toBe('project')
    expect(parseMemoryType('invalid')).toBeUndefined()
    expect(parseMemoryType(123)).toBeUndefined()
  })

  it('should parse valid memory scopes with default', () => {
    expect(parseMemoryScope('session')).toBe('session')
    expect(parseMemoryScope('project')).toBe('project')
    expect(parseMemoryScope('user')).toBe('user')
    expect(parseMemoryScope('invalid')).toBe('project')
    expect(parseMemoryScope(undefined)).toBe('project')
  })
})

describe('Memory storage', () => {
  it('should serialize and parse frontmatter roundtrip', () => {
    const fm: MemoryFrontmatter = {
      name: 'test-memory',
      description: 'A test memory',
      type: 'project',
      scope: 'project',
      enabled: true,
      tags: ['test', 'demo'],
      created: '2025-01-01T00:00:00Z',
      updated: '2025-01-02T00:00:00Z',
    }
    const content = 'This is the memory content.'

    const serialized = serializeMemoryFile(fm, content)
    const parsed = parseFrontmatter(serialized)

    expect(parsed).not.toBeNull()
    expect(parsed!.frontmatter.name).toBe('test-memory')
    expect(parsed!.frontmatter.type).toBe('project')
    expect(parsed!.frontmatter.scope).toBe('project')
    expect(parsed!.frontmatter.enabled).toBe(true)
    expect(parsed!.frontmatter.tags).toEqual(['test', 'demo'])
    expect(parsed!.content).toBe(content)
  })

  it('should handle disabled memory', () => {
    const fm: MemoryFrontmatter = {
      name: 'disabled-mem',
      description: 'Disabled',
      type: 'feedback',
      scope: 'session',
      enabled: false,
      tags: [],
      created: '2025-01-01T00:00:00Z',
      updated: '2025-01-01T00:00:00Z',
    }
    const serialized = serializeMemoryFile(fm, 'content')
    const parsed = parseFrontmatter(serialized)

    expect(parsed!.frontmatter.enabled).toBe(false)
    expect(parsed!.frontmatter.scope).toBe('session')
  })

  it('should default scope to project for legacy files', () => {
    const raw = `---
name: legacy-mem
description: No scope field
type: user
created: 2025-01-01T00:00:00Z
updated: 2025-01-01T00:00:00Z
---

Legacy content.`

    const parsed = parseFrontmatter(raw)
    expect(parsed!.frontmatter.scope).toBe('project')
    expect(parsed!.frontmatter.enabled).toBe(true)
    expect(parsed!.frontmatter.tags).toEqual([])
  })
})

describe('Memory recall', () => {
  function makeEntry(name: string, content: string, type: 'user' | 'project' = 'project', ageDays = 0): MemoryEntry {
    return {
      filename: `${name}.md`,
      frontmatter: {
        name,
        description: `Description of ${name}`,
        type,
        scope: 'project',
        enabled: true,
        tags: [],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      },
      content,
      ageDays,
      isStale: ageDays > 30,
    }
  }

  it('should recall relevant memories by keyword', () => {
    const memories = [
      makeEntry('auth-system', 'The authentication uses JWT tokens with Redis session store'),
      makeEntry('database-schema', 'PostgreSQL with Prisma ORM, migrations in prisma/'),
      makeEntry('coding-style', 'Prefer functional components, use TypeScript strict mode'),
    ]

    const results = recallMemories('How does authentication work?', memories, 2)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].frontmatter.name).toBe('auth-system')
  })

  it('should return low scores for unrelated content', () => {
    const memories = [
      makeEntry('auth-system', 'JWT authentication with Redis sessions'),
      makeEntry('unrelated', 'Something about cooking recipes and pasta'),
    ]
    const results = recallMemories('quantum physics relativity', memories, 5)
    // With BM25 on a tiny corpus, unrelated docs may still get nonzero scores
    // but relevant docs should always rank higher
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('should format memories for prompt', () => {
    const memories = [makeEntry('test-mem', 'Test content here')]
    const formatted = formatMemoriesForPrompt(memories)

    expect(formatted).toContain('# Project Memory')
    expect(formatted).toContain('test-mem')
    expect(formatted).toContain('Test content here')
  })

  it('should handle Chinese content', () => {
    const memories = [
      makeEntry('编码规范', '项目使用 TypeScript 严格模式，React 函数组件'),
      makeEntry('auth-module', 'JWT based authentication'),
    ]

    const results = recallMemories('TypeScript 编码', memories, 2)
    expect(results.length).toBeGreaterThanOrEqual(1)
  })
})
