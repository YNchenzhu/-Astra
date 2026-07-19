import { describe, expect, it } from 'vitest'
import { groupBlocks } from './groupBlocks'
import type { ContentBlock } from '../../../types'

const tool = (id: string) => ({ type: 'tool_use', id, name: 'X', input: {} }) as unknown as ContentBlock
const text = (t: string) => ({ type: 'text', text: t }) as unknown as ContentBlock
const thinking = () => ({ type: 'thinking', text: 'tk' }) as unknown as ContentBlock

describe('groupBlocks', () => {
  it('returns [] for empty input', () => {
    expect(groupBlocks([])).toEqual([])
  })

  it('keeps a single tool_use ungrouped (emitted as a single block)', () => {
    const out = groupBlocks([tool('a')])
    expect(Array.isArray(out[0])).toBe(false)
    expect((out[0] as ContentBlock).type).toBe('tool_use')
  })

  it('groups consecutive tool_use blocks into one array', () => {
    const out = groupBlocks([tool('a'), tool('b'), tool('c')])
    expect(out).toHaveLength(1)
    expect(Array.isArray(out[0])).toBe(true)
    expect((out[0] as ContentBlock[]).map((b) => (b as { id: string }).id)).toEqual(['a', 'b', 'c'])
  })

  it('matches the documented layout example', () => {
    const out = groupBlocks([
      thinking(),
      tool('1'),
      tool('2'),
      text('t'),
      tool('3'),
      tool('4'),
      tool('5'),
    ])
    // [thinking, [tool,tool], text, [tool,tool,tool]]
    expect(out).toHaveLength(4)
    expect((out[0] as ContentBlock).type).toBe('thinking')
    expect(Array.isArray(out[1])).toBe(true)
    expect((out[1] as ContentBlock[]).length).toBe(2)
    expect((out[2] as ContentBlock).type).toBe('text')
    expect((out[3] as ContentBlock[]).length).toBe(3)
  })

  it('does not merge tool runs separated by a non-tool block', () => {
    const out = groupBlocks([tool('a'), text('x'), tool('b')])
    expect(out).toHaveLength(3)
    expect((out[0] as ContentBlock).type).toBe('tool_use')
    expect((out[1] as ContentBlock).type).toBe('text')
    expect((out[2] as ContentBlock).type).toBe('tool_use')
  })
})
