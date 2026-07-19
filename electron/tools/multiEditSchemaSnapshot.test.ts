/**
 * Snapshot the JSON Schema we emit to the AI for `multi_edit_file`. This is
 * the single source of truth for what the model actually sees on the wire —
 * if this drifts, the model's tool calls will mis-shape and silently fail
 * Zod validation. The snapshot lives in-source (not a separate `.snap` file)
 * so that intentional changes show up as line-by-line diffs in PRs.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { toolRegistry } from './registry'
import { builtinTools } from './registryBuiltinTools'

beforeAll(() => {
  for (const t of builtinTools) {
    if (!toolRegistry.get(t.name)) toolRegistry.register(t)
  }
})

describe('multi_edit_file API schema', () => {
  it('exposes the nested edits.items shape with required oldString/newString', () => {
    const tool = toolRegistry.get('multi_edit_file')
    expect(tool).toBeTruthy()
    const editsParam = tool!.inputSchema.find((p) => p.name === 'edits')
    expect(editsParam).toBeTruthy()
    expect(editsParam!.type).toBe('array')
    expect(editsParam!.required).toBe(true)
    const items = editsParam!.items as Record<string, unknown>
    expect(items.type).toBe('object')
    expect(items.required).toEqual(['oldString', 'newString'])
    const props = items.properties as Record<string, { type: string }>
    expect(props.oldString.type).toBe('string')
    expect(props.newString.type).toBe('string')
    expect(props.replaceAll.type).toBe('boolean')
  })

  it('description tells the model the chained-clobber rule and readId rotation', () => {
    const tool = toolRegistry.get('multi_edit_file')!
    expect(tool.description).toMatch(/chained-clobber|substring of any earlier/i)
    expect(tool.description).toMatch(/readId|baseReadId/i)
    expect(tool.description).toMatch(/atomic|atomically/i)
    // The placeholder-ellipsis hard rule must be in the model-facing prompt
    expect(tool.description).toMatch(/placeholders|\.\.\./)
    expect(tool.description).toMatch(/semantic oldString\/newString values/i)
    expect(tool.description).toMatch(/serializes quotes, backslashes, and newlines/i)
    expect(tool.description).not.toMatch(/MUST be written as `\\"`/)
    // Multi-edit's "we don't create" carve-out must be in the description so
    // the model doesn't try to use it for new-file creation.
    expect(tool.description).toMatch(/does NOT create files|does not create/i)
  })

  it('zInputSchema rejects empty edits array via superRefine path', async () => {
    const tool = toolRegistry.get('multi_edit_file')!
    const zod = tool.zInputSchema!
    const r = zod.safeParse({ filePath: '/x', edits: [] })
    expect(r.success).toBe(false)
  })

  it('zInputSchema accepts snake_case alias edits[i].old_string', async () => {
    const tool = toolRegistry.get('multi_edit_file')!
    const zod = tool.zInputSchema!
    const r = zod.safeParse({
      file_path: '/x',
      edits: [{ old_string: 'a', new_string: 'b' }],
    })
    expect(r.success).toBe(true)
    if (r.success) {
      const parsed = r.data as {
        filePath: string
        edits: Array<{ oldString: string; newString: string }>
      }
      expect(parsed.filePath).toBe('/x')
      expect(parsed.edits[0]).toEqual({
        oldString: 'a',
        newString: 'b',
        replaceAll: undefined,
      })
    }
  })

  it('zInputSchema preserves replaceAll per-entry independently', async () => {
    const tool = toolRegistry.get('multi_edit_file')!
    const zod = tool.zInputSchema!
    const r = zod.safeParse({
      filePath: '/x',
      edits: [
        { oldString: 'a', newString: 'A', replaceAll: true },
        { oldString: 'b', newString: 'B' }, // no replaceAll
      ],
    })
    expect(r.success).toBe(true)
    if (r.success) {
      const parsed = r.data as {
        edits: Array<{ replaceAll: boolean | undefined }>
      }
      expect(parsed.edits[0]!.replaceAll).toBe(true)
      expect(parsed.edits[1]!.replaceAll).toBeUndefined()
    }
  })
})
