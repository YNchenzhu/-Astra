import { describe, it, expect } from 'vitest'
import { matchesToolSearchQuery } from './ToolSearchTool'
import type { Tool } from './types'

const stubTool = (partial: Partial<Tool> & Pick<Tool, 'name' | 'description'>): Tool => ({
  inputSchema: [],
  isReadOnly: true,
  async execute() {
    return { success: true, output: '' }
  },
  ...partial,
})

describe('matchesToolSearchQuery', () => {
  it('matches "Explore agent" when description has whole words Explore and Agent but no substring "explore agent"', () => {
    const agent = stubTool({
      name: 'Agent',
      description:
        'Use the Agent tool with subagent_type. Explore: fast codebase search. Plan: design work.',
    })
    expect(matchesToolSearchQuery(agent, 'Explore agent')).toBe(true)
  })

  it('still matches single contiguous phrase', () => {
    const t = stubTool({ name: 'Glob', description: 'Find files by glob pattern' })
    expect(matchesToolSearchQuery(t, 'glob pattern')).toBe(true)
  })

  it('uses searchHint when description omits a token', () => {
    const t = stubTool({
      name: 'Foo',
      description: 'Does things.',
      searchHint: 'Explore subagent',
    })
    expect(matchesToolSearchQuery(t, 'Explore agent')).toBe(false)
    expect(matchesToolSearchQuery(t, 'Explore subagent')).toBe(true)
  })

  // 2026-07 excel_* production bug — snake_case full-name terms must match
  // the tool whose name parts they are composed of.
  it('matches a snake_case tool by its own full name as a query term', () => {
    const t = stubTool({
      name: 'excel_read_sheet',
      description: 'Read all cells in a sheet.',
    })
    expect(matchesToolSearchQuery(t, 'excel_read_sheet')).toBe(true)
  })

  it('does NOT match a snake_case name term against an unrelated tool', () => {
    const t = stubTool({
      name: 'excel_write_cell',
      description: 'Write a single cell.',
    })
    expect(matchesToolSearchQuery(t, 'excel_read_sheet')).toBe(false)
  })
})
