/**
 * upstream report §1.3 — product-registered tools must pass Zod at registry.execute.
 * MCP dynamic tools (`mcp__*`) are exempt (schema from server).
 */

import { describe, expect, it } from 'vitest'
import { initAgentTools, toolRegistry } from './registry'

describe('initAgentTools — zInputSchema coverage', () => {
  it('every static product tool has zInputSchema', () => {
    initAgentTools(undefined, undefined)
    const missing: string[] = []
    for (const t of toolRegistry.getAll()) {
      if (t.name.startsWith('mcp__')) continue
      if (!t.zInputSchema) missing.push(t.name)
    }
    expect(missing, `Add zInputSchema for: ${missing.join(', ')}`).toEqual([])
  })
})
