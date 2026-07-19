/**
 * Unit tests for `estimateToolDefinitionsTokens`.
 *
 * P2 audit fix regression: `tool.name` was previously excluded from the
 * sum, systematically under-counting tool-definition payloads. The fix
 * folds the name in via the same char-heuristic; these tests pin the
 * shape so a future refactor that drops the name again fails loudly.
 *
 * The tests deliberately do NOT assert exact token counts — the
 * char-heuristic isn't a contract — only relative orderings and the
 * invariant that adding `tool.name` chars monotonically increases the
 * estimate.
 */

import { describe, expect, it } from 'vitest'
import { estimateToolDefinitionsTokens } from './tokenCounter'

type ToolDef = Parameters<typeof estimateToolDefinitionsTokens>[0][number]

function toolDef(name: string, description = '', input_schema: Record<string, unknown> = {}): ToolDef {
  return { name, description, input_schema }
}

describe('estimateToolDefinitionsTokens', () => {
  it('returns 0 for an empty tool list', () => {
    expect(estimateToolDefinitionsTokens([])).toBe(0)
  })

  it('returns at least the per-tool overhead (50) for a tool with empty name / description / schema', () => {
    const t = estimateToolDefinitionsTokens([toolDef('', '', {})])
    expect(t).toBeGreaterThanOrEqual(50)
  })

  it('estimate increases when the tool name grows (regression: name was previously dropped)', () => {
    const short = estimateToolDefinitionsTokens([toolDef('r', 'd', { type: 'object' })])
    const longName = estimateToolDefinitionsTokens([
      toolDef('mcp__filesystem_server__read_text_file', 'd', { type: 'object' }),
    ])
    expect(longName).toBeGreaterThan(short)
  })

  it('two identical tools (same name) yield 2× the single-tool cost', () => {
    const t1 = estimateToolDefinitionsTokens([toolDef('read_file', 'desc', { foo: 1 })])
    const t2 = estimateToolDefinitionsTokens([
      toolDef('read_file', 'desc', { foo: 1 }),
      toolDef('read_file', 'desc', { foo: 1 }),
    ])
    expect(t2).toBe(t1 * 2)
  })

  it('name change alone (description + schema unchanged) shifts the estimate', () => {
    const a = estimateToolDefinitionsTokens([toolDef('a', 'shared', { x: 1 })])
    const b = estimateToolDefinitionsTokens([toolDef('extremely_long_tool_name_here', 'shared', { x: 1 })])
    expect(b).not.toBe(a)
    expect(b).toBeGreaterThan(a)
  })

  it('aggregates a realistic tool roster (smoke test for non-zero / non-negative)', () => {
    const tools = [
      toolDef('read_file', 'Read a file from disk.', { type: 'object', properties: { path: { type: 'string' } } }),
      toolDef('write_file', 'Write to a file.', { type: 'object', properties: { path: { type: 'string' }, contents: { type: 'string' } } }),
      toolDef('Grep', 'Search files via ripgrep.', { type: 'object', properties: { pattern: { type: 'string' } } }),
      toolDef('mcp__github__create_issue', 'Open a GitHub issue.', { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } }),
    ]
    const total = estimateToolDefinitionsTokens(tools)
    expect(total).toBeGreaterThan(200) // sanity floor: 4 tools × 50 overhead + bodies
  })
})
