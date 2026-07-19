/**
 * Unit tests for ChatMessage pure helpers — groupBlocks, chatMessagePropsEqual.
 *
 * These are pure functions that don't touch DOM / React — safe in `environment: 'node'`.
 */

import { describe, expect, it } from 'vitest'
import { groupBlocks } from './ChatMessage'
import type { ContentBlock } from '../../types'

// Block-shape helpers must match the canonical `ContentBlock` discriminated
// union in `src/types/tool.ts` — text/thinking variants intentionally have
// no `id` field, and tool_use's status enum is
// 'running'|'completed'|'error'|'failed'|'stopped' (no 'pending').
function txt(text: string): ContentBlock {
  return { type: 'text', text }
}

function tool(name: string, id = 'tu1'): ContentBlock {
  return { type: 'tool_use', id, name, input: {}, status: 'running' }
}

function think(text: string): ContentBlock {
  return { type: 'thinking', text, isStreaming: false }
}

describe('groupBlocks', () => {
  it('returns empty array for empty input', () => {
    expect(groupBlocks([])).toEqual([])
  })

  it('keeps a single text block as-is', () => {
    const b = txt('hello')
    expect(groupBlocks([b])).toEqual([b])
  })

  it('keeps a single tool_use block as-is (not wrapped in array)', () => {
    const b = tool('read')
    expect(groupBlocks([b])).toEqual([b])
  })

  it('groups two consecutive tool_use blocks into one array', () => {
    const read = tool('read_file', 't1')
    const edit = tool('edit_file', 't2')
    expect(groupBlocks([read, edit])).toEqual([[read, edit]])
  })

  it('groups three consecutive tool_use blocks into one array', () => {
    const a = tool('a', '1')
    const b = tool('b', '2')
    const c = tool('c', '3')
    expect(groupBlocks([a, b, c])).toEqual([[a, b, c]])
  })

  it('does not group a tool_use block separated by text', () => {
    const t1 = tool('read', 't1')
    const text = txt('hi')
    const t2 = tool('write', 't2')
    expect(groupBlocks([t1, text, t2])).toEqual([t1, text, t2])
  })

  it('mixes text, tool groups, and thinking blocks correctly', () => {
    const th = think('hmm')
    const t1 = tool('read', 't1')
    const t2 = tool('edit', 't2')
    const mid = txt('done')
    const t3 = tool('save', 't3')
    expect(groupBlocks([th, t1, t2, mid, t3])).toEqual([
      th,
      [t1, t2],
      mid,
      t3,
    ])
  })

  it('handles alternating text-tool-text-tool sequence', () => {
    const t1 = txt('a')
    const tu1 = tool('r1', '1')
    const t2 = txt('b')
    const tu2 = tool('r2', '2')
    expect(groupBlocks([t1, tu1, t2, tu2])).toEqual([
      t1, tu1, t2, tu2,
    ])
  })

  it('preserves ask_user_question blocks outside tool groups', () => {
    const ask = { type: 'ask_user_question' as const, id: 'aq1', requestId: 'r1', questions: [], status: 'pending' as const }
    const tu = tool('read', 't1')
    expect(groupBlocks([ask, tu])).toEqual([ask, tu])
  })

  // Edge: consecutive tool groups separated by non-tool blocks
  it('creates separate groups for tool runs separated by other content', () => {
    const g1a = tool('a', '1')
    const g1b = tool('b', '2')
    const sep = txt('---')
    const g2a = tool('c', '3')
    const g2b = tool('d', '4')
    expect(groupBlocks([g1a, g1b, sep, g2a, g2b])).toEqual([
      [g1a, g1b],
      sep,
      [g2a, g2b],
    ])
  })

  // Regression: last item flush
  it('flushes the final tool group at end of input', () => {
    const a = tool('a', '1')
    const b = tool('b', '2')
    expect(groupBlocks([a, b])).toEqual([[a, b]])
  })
})
