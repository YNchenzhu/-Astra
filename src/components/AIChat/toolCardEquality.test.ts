/**
 * Tests for the ToolUseCard / ToolBlockGroup memo comparators. Pure functions
 * over plain objects — no React needed. The matrix asserts every
 * render-affecting field flips the result to "not equal", and that unchanged
 * props compare equal.
 */
import { describe, it, expect } from 'vitest'
import type { SubAgentDisplay, ToolUseDisplay } from '../../types'
import {
  toolUseCardPropsEqual,
  toolBlockGroupPropsEqual,
  type ToolUseCardPropsLike,
  type ToolBlockGroupPropsLike,
  type ToolBlockGroupToolLike,
} from './toolCardEquality'

const noop = () => {}
const noop2 = () => {}

function baseToolUse(): ToolUseDisplay {
  return {
    id: 't1',
    name: 'write_file',
    input: { filePath: 'a.ts' },
    status: 'running',
  } as ToolUseDisplay
}

function baseProps(toolUse = baseToolUse()): ToolUseCardPropsLike {
  return { toolUse, taskId: 'task-1', subAgents: undefined, compact: false, onStop: noop, onRetry: noop }
}

describe('toolUseCardPropsEqual', () => {
  it('returns true for identical props (same refs)', () => {
    const p = baseProps()
    expect(toolUseCardPropsEqual(p, { ...p })).toBe(true)
  })

  it('returns true when the toolUse wrapper is rebuilt with equal fields', () => {
    const a = baseProps()
    // New wrapper object + new toolUse object, but every field equal-by-value
    // and same input reference.
    const b: ToolUseCardPropsLike = {
      ...a,
      toolUse: { ...a.toolUse },
    }
    expect(toolUseCardPropsEqual(a, b)).toBe(true)
  })

  const primitiveChanges: Array<[string, Partial<ToolUseDisplay>]> = [
    ['id', { id: 't2' }],
    ['name', { name: 'edit_file' }],
    ['status', { status: 'completed' }],
    ['result', { result: 'done' }],
    ['error', { error: 'boom' }],
    ['toolErrorClass', { toolErrorClass: 'timeout' } as Partial<ToolUseDisplay>],
    ['errorWhat', { errorWhat: 'failed' } as Partial<ToolUseDisplay>],
  ]
  for (const [field, patch] of primitiveChanges) {
    it(`returns false when toolUse.${field} changes`, () => {
      const a = baseProps()
      const b = baseProps({ ...a.toolUse, ...patch })
      expect(toolUseCardPropsEqual(a, b)).toBe(false)
    })
  }

  const refChanges: Array<[string, Partial<ToolUseDisplay>]> = [
    ['input', { input: { filePath: 'b.ts' } }],
    ['streamingProgress', { streamingProgress: { text: 'x' } }],
    ['streamingInput', { streamingInput: { partialJson: '{' } }],
    ['errorNext', { errorNext: ['retry'] } as Partial<ToolUseDisplay>],
    ['errorTried', { errorTried: ['a'] } as Partial<ToolUseDisplay>],
    ['errorContext', { errorContext: { k: 1 } } as Partial<ToolUseDisplay>],
  ]
  for (const [field, patch] of refChanges) {
    it(`returns false when toolUse.${field} reference changes`, () => {
      const a = baseProps()
      const b = baseProps({ ...a.toolUse, ...patch })
      expect(toolUseCardPropsEqual(a, b)).toBe(false)
    })
  }

  it('returns false when taskId / compact / subAgents / onStop / onRetry change', () => {
    const a = baseProps()
    expect(toolUseCardPropsEqual(a, { ...a, taskId: 'task-2' })).toBe(false)
    expect(toolUseCardPropsEqual(a, { ...a, compact: true })).toBe(false)
    expect(toolUseCardPropsEqual(a, { ...a, subAgents: [{} as SubAgentDisplay] })).toBe(false)
    expect(toolUseCardPropsEqual(a, { ...a, onStop: noop2 })).toBe(false)
    expect(toolUseCardPropsEqual(a, { ...a, onRetry: noop2 })).toBe(false)
  })
})

function baseTool(): ToolBlockGroupToolLike {
  return { id: 't1', name: 'read_file', input: { p: 1 }, status: 'running' }
}

function baseGroup(tools: ToolBlockGroupToolLike[] = [baseTool()]): ToolBlockGroupPropsLike {
  return { tools, onStop: noop, onRetry: noop }
}

describe('toolBlockGroupPropsEqual', () => {
  it('returns true when tools rebuilt with equal fields', () => {
    const a = baseGroup()
    const b = baseGroup([{ ...a.tools[0] }])
    expect(toolBlockGroupPropsEqual(a, b)).toBe(true)
  })

  it('returns false when tools length differs', () => {
    const a = baseGroup()
    const b = baseGroup([baseTool(), { ...baseTool(), id: 't2' }])
    expect(toolBlockGroupPropsEqual(a, b)).toBe(false)
  })

  it('returns false when a tool field changes', () => {
    const a = baseGroup()
    expect(toolBlockGroupPropsEqual(a, baseGroup([{ ...a.tools[0], status: 'completed' }]))).toBe(false)
    expect(toolBlockGroupPropsEqual(a, baseGroup([{ ...a.tools[0], result: 'ok' }]))).toBe(false)
    expect(toolBlockGroupPropsEqual(a, baseGroup([{ ...a.tools[0], input: { p: 2 } }]))).toBe(false)
    expect(toolBlockGroupPropsEqual(a, baseGroup([{ ...a.tools[0], name: 'glob' }]))).toBe(false)
    expect(toolBlockGroupPropsEqual(a, baseGroup([{ ...a.tools[0], error: 'boom' }]))).toBe(false)
    expect(toolBlockGroupPropsEqual(a, baseGroup([{ ...a.tools[0], taskId: 'task-x' }]))).toBe(false)
    expect(
      toolBlockGroupPropsEqual(a, baseGroup([{ ...a.tools[0], streamingInput: { partialJson: '{' } }])),
    ).toBe(false)
    expect(
      toolBlockGroupPropsEqual(a, baseGroup([{ ...a.tools[0], streamingProgress: { text: 'x' } }])),
    ).toBe(false)
    expect(
      toolBlockGroupPropsEqual(a, baseGroup([{ ...a.tools[0], subAgents: [{} as SubAgentDisplay] }])),
    ).toBe(false)
  })

  it('returns false when a structured error field changes', () => {
    const a = baseGroup()
    expect(toolBlockGroupPropsEqual(a, baseGroup([{ ...a.tools[0], toolErrorClass: 'timeout' }]))).toBe(false)
    expect(toolBlockGroupPropsEqual(a, baseGroup([{ ...a.tools[0], errorWhat: 'failed' }]))).toBe(false)
    expect(toolBlockGroupPropsEqual(a, baseGroup([{ ...a.tools[0], errorTried: ['x'] }]))).toBe(false)
    expect(toolBlockGroupPropsEqual(a, baseGroup([{ ...a.tools[0], errorContext: { k: 1 } }]))).toBe(false)
    expect(toolBlockGroupPropsEqual(a, baseGroup([{ ...a.tools[0], errorNext: ['retry'] }]))).toBe(false)
  })

  it('returns false when onStop / onRetry change', () => {
    const a = baseGroup()
    expect(toolBlockGroupPropsEqual(a, { ...a, onStop: noop2 })).toBe(false)
    expect(toolBlockGroupPropsEqual(a, { ...a, onRetry: noop2 })).toBe(false)
  })
})
