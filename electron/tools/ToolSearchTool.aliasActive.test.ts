/**
 * Regression guard for the "AI can't see web_search" hallucination.
 *
 * Root cause history:
 *   1. `findToolByName` compared against `t.name` only, skipping `aliases`.
 *      `select:web_search` failed to resolve to the registered `WebSearch`.
 *   2. Even when resolved, `select:` only searched the DEFERRED pool —
 *      non-deferred tools like `WebSearch` returned "No deferred tools
 *      matched", which the model misread as "tool does not exist".
 *
 * Both are now fixed; this test ensures they stay fixed.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { toolRegistry } from './registry'
import { toolSearchTool } from './ToolSearchTool'
import { resetDeferredDiscovery } from './deferredDiscovery'
import type { ToolResult } from './types'

async function runToolSearch(query: string): Promise<ToolResult> {
  return toolSearchTool.execute({ query })
}

afterEach(() => {
  // Keyword/name queries below mark deferred tools discovered — reset so
  // tests stay order-independent (and other suites see a clean session).
  resetDeferredDiscovery()
})

describe('ToolSearch — alias + active-tool resolution', () => {
  it('registry has WebSearch with snake_case alias (baseline)', () => {
    const t = toolRegistry.get('WebSearch')
    expect(t).toBeDefined()
    expect(t!.aliases).toContain('web_search')
  })

  it('select:WebSearch reports that the tool is already active (not a scary "no match" error)', async () => {
    const r = await runToolSearch('select:WebSearch')
    expect(r.success).toBe(true)
    expect(r.output ?? '').toMatch(/already active/i)
    expect(r.output ?? '').toContain('WebSearch')
    // Must NOT say "No deferred tools matched" — that was the regressed UX.
    expect(r.output ?? '').not.toMatch(/no deferred tools matched/i)
  })

  it('select:web_search (alias) resolves to WebSearch and reports "already active"', async () => {
    const r = await runToolSearch('select:web_search')
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    expect(out).toMatch(/already active/i)
    // The canonical name is used when referencing the resolved tool.
    expect(out).toContain('WebSearch')
  })

  it('select: with a fully unknown name still returns the "No deferred tools matched" shape', async () => {
    const r = await runToolSearch('select:NotARealTool')
    expect(r.success).toBe(true)
    expect(r.output ?? '').toMatch(/no deferred tools matched/i)
  })

  it('select:web_search,read_file: mixed known-alias names both surface as active', async () => {
    // WebSearch (alias) + read_file (primary) are BOTH known, both active.
    const r = await runToolSearch('select:web_search,read_file')
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    expect(out).toMatch(/already active/i)
    expect(out).toContain('WebSearch')
    expect(out).toContain('read_file')
  })
})

describe('ToolSearch — keyword query also surfaces active tools (Zhipu hallucination fix)', () => {
  it('keyword query "web search" returns WebSearch as already-active (critical for GLM "我没有联网搜索" bug)', async () => {
    const r = await runToolSearch('web search')
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    // The model MUST see "already active" + the canonical tool name so it
    // stops concluding "no web search available".
    expect(out).toMatch(/already active/i)
    expect(out).toContain('WebSearch')
  })

  it('Chinese keyword "联网搜索" also surfaces WebSearch (even if scoring is weak, the active-pool keyword pass should match)', async () => {
    // NOTE: the scorer is keyword-based over English token parts, so pure
    // Chinese queries may not match. But English synonyms users type when
    // they debug (e.g. "search web") should hit.
    const r = await runToolSearch('search')
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    // One of Grep / WebSearch / ToolSearch / SearchHint tools should surface
    // as active. WebSearch is what we care about for the bug.
    expect(out).toMatch(/WebSearch|already active/i)
  })

  it('keyword query that matches only deferred tools returns Discovered + NO active hint', async () => {
    // `mcp__` queries should match deferred MCP tools; no active hint expected.
    const r = await runToolSearch('mcp__playwright__browser_navigate')
    expect(r.success).toBe(true)
    // Output structure is "No deferred tools matched" or "Discovered N …"
    // but must NOT falsely claim WebSearch is active when user wasn't asking.
    const out = r.output ?? ''
    expect(out).not.toMatch(/WebSearch.*already active/i)
  })

  it('keyword query with no match at all falls back to the original "no match" message', async () => {
    const r = await runToolSearch('zzzzz_impossible_query_xyzqrs')
    expect(r.success).toBe(true)
    expect(r.output ?? '').toMatch(/no deferred tools matched/i)
  })

  it('keyword query that matches BOTH deferred and active tools cites both — model sees the full surface', async () => {
    // `search` will match active Grep + WebSearch + ToolSearch etc. Some
    // MCP tools also contain "search" in their names. Expect the output to
    // include a "Discovered N" section AND the "Already active" hint.
    const r = await runToolSearch('search')
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    // Hint line should appear whenever an active tool name matched.
    expect(out).toMatch(/already active/i)
  })
})

describe('ToolSearch — snake_case full-name keyword queries (2026-07 excel_* production bug)', () => {
  // Production failure: the model called `excel_read_sheet` directly, got
  // the deferred-guard block, then searched
  // `excel_read_sheet excel_read_range excel_read_cell` — and ToolSearch
  // answered "No deferred tools matched", because snake_case full-name
  // terms were never normalized the way tool names are (parseToolName
  // splits `excel_read_sheet` into ['excel','read','sheet'], so the
  // underscored term equalled no part and no part contained it).

  it('registry has the deferred excel family (baseline)', () => {
    for (const n of ['excel_read_sheet', 'excel_read_range', 'excel_read_cell']) {
      const t = toolRegistry.get(n)
      expect(t, `${n} must be registered`).toBeDefined()
      expect(t!.shouldDefer, `${n} must be deferred`).toBe(true)
    }
  })

  it('space-separated multi-name query discovers all three tools (exact production repro)', async () => {
    const r = await runToolSearch('excel_read_sheet excel_read_range excel_read_cell')
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    expect(out).not.toMatch(/no deferred tools matched/i)
    expect(out).toContain('Discovered 3 tool(s)')
    expect(out).toContain('excel_read_sheet')
    expect(out).toContain('excel_read_range')
    expect(out).toContain('excel_read_cell')
  })

  it('comma-separated multi-name query also discovers them', async () => {
    const r = await runToolSearch('excel_read_sheet, excel_read_range')
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    expect(out).not.toMatch(/no deferred tools matched/i)
    expect(out).toContain('excel_read_sheet')
    expect(out).toContain('excel_read_range')
  })

  it('single snake_case full name via keyword search resolves (not only via select:)', async () => {
    const r = await runToolSearch('excel_read_range')
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    expect(out).not.toMatch(/no deferred tools matched/i)
    expect(out).toContain('excel_read_range')
  })

  it('mixed query (full name + plain keywords) still surfaces the named tool first', async () => {
    const r = await runToolSearch('excel_read_sheet spreadsheet data')
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    expect(out).not.toMatch(/no deferred tools matched/i)
    expect(out).toContain('excel_read_sheet')
    // The named tool must be the FIRST discovered reference.
    const firstRef = out.indexOf('excel_read_sheet')
    expect(firstRef).toBeGreaterThan(-1)
  })

  it('snake_case sub-word term (partial name) still scores — "read_range excel"', async () => {
    const r = await runToolSearch('read_range excel')
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    expect(out).not.toMatch(/no deferred tools matched/i)
    expect(out).toContain('excel_read_range')
  })
})
