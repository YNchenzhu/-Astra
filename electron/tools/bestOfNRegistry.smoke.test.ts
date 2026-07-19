/**
 * Audit-H2 guard: the production tool registry must load without a circular-
 * import crash, and the new tools must be registered + well-formed.
 *
 * We import the canonical entry (`./registry`, the same one the agentic loop
 * uses) rather than `./registryBuiltinTools` directly — importing the builtin
 * list as the FIRST module hits a pre-existing registry↔tool-module cycle that
 * production never triggers. The H2 concern (BestOfNTool statically pulling in
 * subAgentRunner → registry) is what this exercises: if that static edge ever
 * comes back, loading `toolRegistry` here throws or yields a broken entry.
 */
import { describe, expect, it } from 'vitest'
import { toolRegistry } from './registry'

describe('tool registry (audit H2 smoke)', () => {
  it('loads without a circular-import crash and has tools', () => {
    const all = toolRegistry.getAll()
    expect(Array.isArray(all)).toBe(true)
    expect(all.length).toBeGreaterThan(0)
    expect(all.every((t) => t && typeof t.name === 'string')).toBe(true)
  })

  it('registers the Await and BestOfN tools', () => {
    expect(toolRegistry.has('Await')).toBe(true)
    expect(toolRegistry.has('BestOfN')).toBe(true)
  })

  it('BestOfN is a mutating tool with a Zod schema and an executor', () => {
    const bestOfN = toolRegistry.get('BestOfN')!
    expect(bestOfN).toBeTruthy()
    expect(bestOfN.isReadOnly).toBe(false)
    expect(bestOfN.zInputSchema).toBeTruthy()
    expect(typeof bestOfN.execute).toBe('function')
  })
})
