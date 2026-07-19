/**
 * Unit tests for CommandPalette pure helpers — filterCommands.
 *
 * Commands are a flat array with id/label/shortcut/icon/category. The filter
 * matches only on `label` (case-insensitive substring) — this is the same
 * logic used by the inline `useMemo`-style derivation in the component.
 */

import { describe, expect, it } from 'vitest'
import { filterCommands, COMMANDS } from './CommandPalette'

describe('COMMANDS array', () => {
  it('has at least one command for each expected category', () => {
    const categories = new Set(COMMANDS.map((c) => c.category))
    expect(categories.has('AI')).toBe(true)
    expect(categories.has('Diff')).toBe(true)
  })

  it('has no duplicate ids', () => {
    const ids = COMMANDS.map((c) => c.id)
    expect(ids.length).toBe(new Set(ids).size)
  })

  it('every command has a non-empty label', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.label.trim().length).toBeGreaterThan(0)
    }
  })

  it('every command has a stable, kebab-case id', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.id).toMatch(/^[a-z][\w-]*[a-z]$/)
    }
  })
})

describe('filterCommands', () => {
  it('returns all commands for empty query', () => {
    expect(filterCommands('')).toEqual(COMMANDS)
  })

  it('returns empty for whitespace-only query (no labels have leading whitespace)', () => {
    expect(filterCommands('   ')).toEqual([])
  })

  it('matches case-insensitive substring', () => {
    const r = filterCommands('ai')
    expect(r.length).toBeGreaterThan(0)
    expect(r.every((c) => c.label.toLowerCase().includes('ai'))).toBe(true)
  })

  it('matches Chinese characters', () => {
    const r = filterCommands('设置')
    expect(r.length).toBeGreaterThan(0)
    expect(r.every((c) => c.label.includes('设置'))).toBe(true)
  })

  it('matches by label substring (shortcuts are NOT searchable)', () => {
    // Shortcut field is display-only; only label is filterable.
    // Verifying that "AI 编辑" finds the ai-edit command.
    const r = filterCommands('AI 编辑')
    expect(r.some((c) => c.id === 'ai-edit')).toBe(true)
  })

  it('returns empty for a query that matches nothing', () => {
    expect(filterCommands('zzz_nonexistent')).toEqual([])
  })

  it('monotonically non-increasing as query gets more specific', () => {
    // Each longer query must be ≤ previous — the filter only removes, never adds.
    const r1 = filterCommands('文件')
    const r2 = filterCommands('文件:')
    const r3 = filterCommands('文件: 新建')
    expect(r1.length).toBeGreaterThanOrEqual(r2.length)
    expect(r2.length).toBeGreaterThanOrEqual(r3.length)
    // At least one step must actually narrow the list
    const narrowed = r1.length > r2.length || r2.length > r3.length
    expect(narrowed).toBe(true)
  })
})
