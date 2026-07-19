/**
 * Contract test: the `WebSearch` (aka `web_search`) tool must be present in
 * the registry with a description AND input schema that mention all three
 * supported engines (Brave / Baidu / DuckDuckGo). This is what the AI sees;
 * if any of these disappears, the model loses the ability to route or even
 * KNOW that Baidu is available.
 */

import { describe, expect, it } from 'vitest'
import { toolRegistry } from './registry'

describe('WebSearch tool — AI-facing registration', () => {
  const tool = toolRegistry.get('WebSearch')

  it('is registered in the tool registry', () => {
    expect(tool).toBeDefined()
  })

  it('is reachable via the OpenClaude-style snake_case alias', () => {
    expect(toolRegistry.get('web_search')).toBeDefined()
    expect(toolRegistry.get('web_search')?.name).toBe('WebSearch')
  })

  it('description mentions all three engines so the AI knows they exist', () => {
    const desc = tool!.description
    expect(desc).toMatch(/Brave/i)
    expect(desc).toMatch(/Baidu/i)
    expect(desc).toMatch(/DuckDuckGo/i)
  })

  it('description mentions the CJK auto-routing heuristic so the model understands why queries get routed', () => {
    const desc = tool!.description
    // Looser match — any phrase that surfaces "CJK" or "Chinese/中文" or
    // "auto-detects" is fine; we just need the model to know routing exists.
    expect(desc).toMatch(/CJK|中文|auto[- ]?detect/i)
  })

  it('inputSchema exposes `engine` with the four canonical enum values', () => {
    const param = tool!.inputSchema.find((p) => p.name === 'engine')
    expect(param).toBeDefined()
    expect(param!.enum).toEqual(
      expect.arrayContaining(['auto', 'brave', 'baidu', 'ddg']),
    )
  })

  it('inputSchema exposes `freshness` (Baidu-specific time filter)', () => {
    const param = tool!.inputSchema.find((p) => p.name === 'freshness')
    expect(param).toBeDefined()
    // Description should reference the Baidu-specific format so the model
    // doesn't try to send a freshness value to Brave.
    expect(param!.description).toMatch(/pd|pw|pm|py|YYYY-MM-DD/)
  })

  it('is tagged read-only + concurrency-safe (parallel tool use friendly)', () => {
    expect(tool!.isReadOnly).toBe(true)
    expect(tool!.isConcurrencySafe).toBe(true)
  })
})
