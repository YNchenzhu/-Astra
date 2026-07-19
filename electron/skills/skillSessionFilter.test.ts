import { describe, it, expect } from 'vitest'
import { filterToolDefinitionsForSkill } from './skillSessionFilter'
import type { ToolDefinition } from '../tools/types'

const defs: ToolDefinition[] = [
  {
    name: 'Read',
    description: 'r',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'Write',
    description: 'w',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'mcp__x__y',
    description: 'm',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
]

describe('filterToolDefinitionsForSkill', () => {
  it('returns all when allowlist empty or undefined', () => {
    expect(filterToolDefinitionsForSkill(defs, undefined)).toEqual(defs)
    expect(filterToolDefinitionsForSkill(defs, [])).toEqual(defs)
  })

  it('keeps only explicitly allowed names; MCP tools are NOT allowed by default (Bug O15 fix)', () => {
    // Previous behavior (pre-O15) kept every `mcp__*` tool regardless of
    // allowlist, which made `allowedTools` effectively useless for
    // restricting MCP exposure. Now the skill author must opt in.
    const out = filterToolDefinitionsForSkill(defs, ['read_file'])
    expect(out.map((d) => d.name).sort()).toEqual(['Read'])
  })

  it('explicit `mcp__*` keeps all MCP tools (opt-in wildcard)', () => {
    const out = filterToolDefinitionsForSkill(defs, ['read_file', 'mcp__*'])
    expect(out.map((d) => d.name).sort()).toEqual(['Read', 'mcp__x__y'])
  })

  it('`mcp__server__*` keeps that server\'s tools only', () => {
    const extra: ToolDefinition[] = [
      ...defs,
      {
        name: 'mcp__other__tool',
        description: 'o',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
    ]
    const out = filterToolDefinitionsForSkill(extra, ['Read', 'mcp__x__*'])
    expect(out.map((d) => d.name).sort()).toEqual(['Read', 'mcp__x__y'])
  })

  it('exact `mcp__server__tool` keeps only that tool', () => {
    const out = filterToolDefinitionsForSkill(defs, ['Read', 'mcp__x__y'])
    expect(out.map((d) => d.name).sort()).toEqual(['Read', 'mcp__x__y'])
  })
})
