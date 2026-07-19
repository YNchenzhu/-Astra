import { describe, it, expect } from 'vitest'
import type { Tool } from './types'
import { orderToolsForModelListing } from './schema'

function stubTool(name: string): Tool {
  return {
    name,
    description: 'stub',
    inputSchema: [],
    isReadOnly: true,
    execute: async () => ({ success: true, output: '' }),
  }
}

describe('orderToolsForModelListing', () => {
  it('sorts non-mcp tools by name then mcp__ tools by name', () => {
    const ordered = orderToolsForModelListing([
      stubTool('mcp__b__z'),
      stubTool('zebra'),
      stubTool('mcp__a__y'),
      stubTool('apple'),
    ])
    expect(ordered.map((t) => t.name)).toEqual(['apple', 'zebra', 'mcp__a__y', 'mcp__b__z'])
  })

  it('dedupes duplicate names keeping first occurrence', () => {
    const ordered = orderToolsForModelListing([stubTool('dup'), stubTool('mcp__x__dup'), stubTool('dup')])
    expect(ordered.map((t) => t.name)).toEqual(['dup', 'mcp__x__dup'])
  })
})
