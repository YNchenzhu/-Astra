/**
 * Verifies that the schema layer faithfully propagates
 * {@link Tool.examples} / {@link Tool.ptcAllowedCaller} onto the wire
 * {@link ToolDefinition} shape, and that invalid configurations are rejected
 * at registration time (loud failure is strictly better than a silent 400).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { toolRegistry } from './registry'
import { toolDefinitionFor } from './schema'
import type { Tool } from './types'

const TEST_NAMES: string[] = []

function register(tool: Tool): void {
  TEST_NAMES.push(tool.name)
  toolRegistry.register(tool)
}

afterEach(() => {
  while (TEST_NAMES.length) {
    const name = TEST_NAMES.pop()
    if (name) toolRegistry.unregister(name)
  }
})

const makeTool = (overrides: Partial<Tool>): Tool => ({
  name: `_ptc_${Math.random().toString(36).slice(2, 8)}`,
  description: 'tmp',
  inputSchema: [
    { name: 'q', type: 'string', description: 'query', required: true },
  ],
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async () => ({ success: true, output: '' }),
  ...overrides,
})

describe('schema.toolToDefinition — examples', () => {
  it('propagates examples when declared', () => {
    const tool = makeTool({
      examples: [{ q: 'hello' }, { q: 'world' }],
    })
    register(tool)
    const def = toolDefinitionFor(tool.name)
    expect(def).toBeTruthy()
    expect(def!.input_examples).toEqual([{ q: 'hello' }, { q: 'world' }])
  })

  it('omits input_examples when none declared', () => {
    const tool = makeTool({})
    register(tool)
    const def = toolDefinitionFor(tool.name)
    expect(def!.input_examples).toBeUndefined()
  })

  it('defensively deep-copies example objects (callers cannot mutate in-place)', () => {
    const source = [{ q: 'hi' }]
    const tool = makeTool({ examples: source })
    register(tool)
    const def = toolDefinitionFor(tool.name)!
    // Should not be the same reference as our source object.
    expect(def.input_examples![0]).not.toBe(source[0])
    // Original stays untouched.
    expect(source).toEqual([{ q: 'hi' }])
  })

  it('rejects > 20 examples at registration time', () => {
    const tool = makeTool({
      examples: Array.from({ length: 21 }, (_, i) => ({ q: String(i) })),
    })
    expect(() => register(tool)).toThrow(/limits `input_examples` to 20/)
  })

  it('rejects non-object examples', () => {
    const tool = makeTool({
      // @ts-expect-error — deliberately invalid
      examples: [{ q: 'ok' }, 'not an object'],
    })
    expect(() => register(tool)).toThrow(/not a plain object/)
  })
})

describe('schema.toolToDefinition — PTC allowed_callers', () => {
  it('"direct" (or undefined) → no allowed_callers', () => {
    register(makeTool({ name: '_tc_direct', ptcAllowedCaller: 'direct' }))
    register(makeTool({ name: '_tc_unset' }))
    expect(toolDefinitionFor('_tc_direct')!.allowed_callers).toBeUndefined()
    expect(toolDefinitionFor('_tc_unset')!.allowed_callers).toBeUndefined()
  })

  it('"code_execution" → exactly ["code_execution_20260120"]', () => {
    register(makeTool({ name: '_tc_ce', ptcAllowedCaller: 'code_execution' }))
    expect(toolDefinitionFor('_tc_ce')!.allowed_callers).toEqual([
      'code_execution_20260120',
    ])
  })

  it('"both" → ["direct", "code_execution_20260120"]', () => {
    register(makeTool({ name: '_tc_both', ptcAllowedCaller: 'both' }))
    expect(toolDefinitionFor('_tc_both')!.allowed_callers).toEqual([
      'direct',
      'code_execution_20260120',
    ])
  })

  it('rejects PTC opt-in on MCP bridge tools', () => {
    const tool = makeTool({
      name: '_tc_mcp',
      isMcpBridge: true,
      ptcAllowedCaller: 'code_execution',
    })
    expect(() => register(tool)).toThrow(/MCP bridge/)
  })

  it('rejects PTC opt-in on deferred tools', () => {
    const tool = makeTool({
      name: '_tc_deferred',
      shouldDefer: true,
      ptcAllowedCaller: 'code_execution',
    })
    expect(() => register(tool)).toThrow(/deferred/)
  })
})
