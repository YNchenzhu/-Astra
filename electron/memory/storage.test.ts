import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseFrontmatter,
  serializeMemoryFile,
  sanitizeFilename,
  rebuildIndexInDir,
  resolveFilenameWithoutCollision,
  writeMemoryFile,
} from './storage'
import type { MemoryFrontmatter } from './types'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('sanitizeFilename', () => {
  it('converts to lowercase with hyphens', () => {
    expect(sanitizeFilename('User Coding Style')).toBe('user-coding-style.md')
  })

  it('preserves CJK characters', () => {
    expect(sanitizeFilename('用户偏好')).toBe('用户偏好.md')
  })

  it('truncates long names to 64 chars', () => {
    const long = 'a'.repeat(100)
    const result = sanitizeFilename(long)
    expect(result.length).toBeLessThanOrEqual(67) // 64 + '.md'
    expect(result.endsWith('.md')).toBe(true)
  })

  it('removes leading and trailing hyphens', () => {
    expect(sanitizeFilename('---test---')).toBe('test.md')
  })

  it('handles empty name', () => {
    expect(sanitizeFilename('')).toBe('.md')
  })
})

describe('parseFrontmatter', () => {
  it('parses a complete memory file', () => {
    const raw = [
      '---',
      'name: user-preference',
      'description: User likes short responses',
      'type: user',
      'created: 2025-01-15T10:00:00.000Z',
      'updated: 2025-06-01T10:00:00.000Z',
      'scope: project',
      'enabled: true',
      '---',
      '',
      'The user prefers concise responses with minimal formatting.',
    ].join('\n')

    const result = parseFrontmatter(raw)
    expect(result).not.toBeNull()
    expect(result!.frontmatter.name).toBe('user-preference')
    expect(result!.frontmatter.description).toBe('User likes short responses')
    expect(result!.frontmatter.type).toBe('user')
    expect(result!.frontmatter.enabled).toBe(true)
    expect(result!.content).toBe('The user prefers concise responses with minimal formatting.')
  })

  it('parses tags as JSON array', () => {
    const raw = [
      '---',
      'name: test',
      'description: test',
      'type: feedback',
      'created: 2025-01-01T00:00:00.000Z',
      'updated: 2025-01-01T00:00:00.000Z',
      'tags: ["coding-style", "review"]',
      '---',
      '',
      'content',
    ].join('\n')

    const result = parseFrontmatter(raw)
    expect(result!.frontmatter.tags).toEqual(['coding-style', 'review'])
  })

  it('parses tags as comma-separated', () => {
    const raw = [
      '---',
      'name: test',
      'description: test',
      'type: feedback',
      'created: 2025-01-01T00:00:00.000Z',
      'updated: 2025-01-01T00:00:00.000Z',
      'tags: coding-style, review',
      '---',
      '',
      'content',
    ].join('\n')

    const result = parseFrontmatter(raw)
    expect(result!.frontmatter.tags).toEqual(['coding-style', 'review'])
  })

  it('returns null for invalid frontmatter', () => {
    expect(parseFrontmatter('just plain text')).toBeNull()
    expect(parseFrontmatter('---\nbroken\ncontent')).toBeNull()
  })

  it('handles CRLF line endings', () => {
    const raw = '---\r\nname: test\r\ndescription: desc\r\ntype: project\r\ncreated: 2025-01-01T00:00:00.000Z\r\nupdated: 2025-01-01T00:00:00.000Z\r\n---\r\n\r\ncontent'
    const result = parseFrontmatter(raw)
    expect(result).not.toBeNull()
    expect(result!.frontmatter.name).toBe('test')
  })

  it('defaults missing fields', () => {
    const raw = [
      '---',
      'name: minimal',
      'type: reference',
      '---',
      '',
      'content',
    ].join('\n')

    const result = parseFrontmatter(raw)
    expect(result!.frontmatter.description).toBe('')
    expect(result!.frontmatter.enabled).toBe(true)
    expect(result!.frontmatter.scope).toBe('project')
  })
})

describe('serializeMemoryFile', () => {
  it('produces valid markdown with frontmatter', () => {
    const fm = {
      name: 'test-memory',
      description: 'A test memory',
      type: 'feedback' as const,
      created: '2025-01-01T00:00:00.000Z',
      updated: '2025-01-01T00:00:00.000Z',
      scope: 'project' as const,
      enabled: true,
    }
    const content = 'This is the content.'
    const serialized = serializeMemoryFile(fm, content)

    // Verify round-trip
    const parsed = parseFrontmatter(serialized)
    expect(parsed).not.toBeNull()
    expect(parsed!.frontmatter.name).toBe('test-memory')
    expect(parsed!.frontmatter.type).toBe('feedback')
    expect(parsed!.content).toBe('This is the content.')
  })

  it('includes tags in JSON format', () => {
    const fm = {
      name: 'tagged',
      description: 'Has tags',
      type: 'project' as const,
      created: '2025-01-01T00:00:00.000Z',
      updated: '2025-01-01T00:00:00.000Z',
      tags: ['frontend', 'react'],
    }
    const serialized = serializeMemoryFile(fm, 'content')
    expect(serialized).toContain('tags: ["frontend","react"]')
  })
})

describe('rebuildIndexInDir', () => {
  let testDir: string

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `memory-test-${Date.now()}`)
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('creates MEMORY.md with entry links', () => {
    // Create a fake memory file
    fs.writeFileSync(
      path.join(testDir, 'test-memory.md'),
      [
        '---',
        'name: test-memory',
        'description: Test description',
        'type: project',
        'created: 2025-01-01T00:00:00.000Z',
        'updated: 2025-01-01T00:00:00.000Z',
        '---',
        '',
        'content',
      ].join('\n'),
    )

    rebuildIndexInDir(testDir)
    const indexPath = path.join(testDir, 'MEMORY.md')
    expect(fs.existsSync(indexPath)).toBe(true)
    const content = fs.readFileSync(indexPath, 'utf-8')
    expect(content).toContain('test-memory')
    expect(content).toContain('Test description')
  })

  it('handles empty directory', () => {
    rebuildIndexInDir(testDir)
    const indexPath = path.join(testDir, 'MEMORY.md')
    expect(fs.existsSync(indexPath)).toBe(true)
    const content = fs.readFileSync(indexPath, 'utf-8')
    expect(content).toContain('No memories stored yet')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// resolveFilenameWithoutCollision (F8 audit fix)
// ──────────────────────────────────────────────────────────────────────────
describe('resolveFilenameWithoutCollision', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-collision-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  function fmOf(name: string): MemoryFrontmatter {
    return {
      name,
      description: 'fixture',
      type: 'project',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
    }
  }

  it('returns the desired filename when nothing is on disk', () => {
    const out = resolveFilenameWithoutCollision(
      testDir,
      'editor-preferences.md',
      'editor preferences',
    )
    expect(out).toBe('editor-preferences.md')
  })

  it('returns the desired filename when the existing file is for the SAME name (update case)', () => {
    writeMemoryFile(testDir, 'editor-preferences.md', fmOf('editor preferences'), 'old')
    const out = resolveFilenameWithoutCollision(
      testDir,
      'editor-preferences.md',
      'editor preferences',
    )
    expect(out).toBe('editor-preferences.md')
  })

  it('case-insensitive name comparison: "Editor Preferences" still treated as the same memory', () => {
    writeMemoryFile(testDir, 'editor-preferences.md', fmOf('Editor Preferences'), 'old')
    const out = resolveFilenameWithoutCollision(
      testDir,
      'editor-preferences.md',
      'editor preferences',
    )
    expect(out).toBe('editor-preferences.md')
  })

  it('hash-suffixes the filename when an unrelated memory occupies the same sanitised slot', () => {
    writeMemoryFile(testDir, '编辑器-偏好.md', fmOf('编辑器 配色偏好'), 'first')
    const out = resolveFilenameWithoutCollision(
      testDir,
      '编辑器-偏好.md',
      '编辑器 字体偏好',
    )
    expect(out).not.toBe('编辑器-偏好.md')
    expect(out.endsWith('.md')).toBe(true)
    // Suffix must be 6 hex chars (stable for the same logical name).
    expect(/-[a-f0-9]{6}\.md$/.test(out)).toBe(true)
  })

  it('is deterministic: same newName → same suffix across calls', () => {
    writeMemoryFile(testDir, 'a.md', fmOf('different memory'), 'first')
    const out1 = resolveFilenameWithoutCollision(testDir, 'a.md', 'collide')
    const out2 = resolveFilenameWithoutCollision(testDir, 'a.md', 'collide')
    expect(out1).toBe(out2)
  })

  it('returns the original filename when absDir does not exist', () => {
    const ghost = path.join(testDir, 'does-not-exist')
    expect(resolveFilenameWithoutCollision(ghost, 'x.md', 'whatever')).toBe('x.md')
  })
})
