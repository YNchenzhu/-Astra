import { describe, it, expect } from 'vitest'
import {
  ZHIPU_MAX_TOOL_DESCRIPTION_CHARS,
  applyZhipuToolSurfaceToSystem,
  sanitizeToolsForZhipuGateway,
  buildZhipuToolSurfaceSystemAppendix,
} from './zhipuToolGateway'

describe('sanitizeToolsForZhipuGateway', () => {
  it('leaves short descriptions unchanged', () => {
    const tools = [{ name: 'Read', description: 'Read a file' }]
    expect(sanitizeToolsForZhipuGateway(tools)).toEqual(tools)
  })

  it('truncates long descriptions and keeps marker', () => {
    const long = 'x'.repeat(ZHIPU_MAX_TOOL_DESCRIPTION_CHARS + 500)
    const out = sanitizeToolsForZhipuGateway([{ description: long }])
    expect(out[0].description.length).toBeLessThan(long.length)
    expect(out[0].description).toContain('[Truncated by client:')
    expect(out[0].description.startsWith('x'.repeat(100))).toBe(true)
  })
})

describe('buildZhipuToolSurfaceSystemAppendix', () => {
  it('returns empty for no names', () => {
    expect(buildZhipuToolSurfaceSystemAppendix([])).toBe('')
  })

  it('dedupes, sorts, and lists names', () => {
    const s = buildZhipuToolSurfaceSystemAppendix(['Zed', 'Agent', 'Read', 'Agent', ''])
    expect(s).toContain('Agent, Read, Zed')
  })

  it('tells the model not to deny these tools (anti-hallucination)', () => {
    const s = buildZhipuToolSurfaceSystemAppendix(['Read', 'Edit'])
    expect(s).toMatch(/do not claim you lack/i)
  })

  it('tells the model NOT to route through ToolSearch for active tools', () => {
    const s = buildZhipuToolSurfaceSystemAppendix(['Read', 'Edit'])
    // Strong signal: the model should call active tools directly without
    // going through ToolSearch (common GLM detour that wastes a turn).
    expect(s).toMatch(/toolsearch/i)
    expect(s).toMatch(/deferred/i)
  })

  it('instructs the model that names are case-sensitive', () => {
    // GLM tends to lowercase tool names when it synthesises a call, which
    // silently fails against the registry. The appendix must flag this.
    const s = buildZhipuToolSurfaceSystemAppendix(['Read'])
    expect(s).toMatch(/case[- ]?sensitive|verbatim/i)
  })

  it('starts with a blank-line separator so the concatenation into an existing system prompt reads cleanly', () => {
    const s = buildZhipuToolSurfaceSystemAppendix(['Read'])
    expect(s.startsWith('\n\n')).toBe(true)
  })
})

describe('applyZhipuToolSurfaceToSystem — wire integration helper', () => {
  it('concatenates onto a string system prompt', () => {
    const out = applyZhipuToolSurfaceToSystem('You are helpful.', ['Edit', 'Read'])
    expect(out).toMatch(/^You are helpful\./)
    expect(out).toContain('Tool surface (Zhipu / GLM)')
    expect(out).toContain('Edit, Read')
  })

  it('appends as a separate text block to an array system prompt', () => {
    const system = [{ type: 'text', text: 'You are helpful.' }]
    const out = applyZhipuToolSurfaceToSystem(system, ['Edit'])
    expect(Array.isArray(out)).toBe(true)
    const arr = out as Array<{ type?: string; text?: string }>
    expect(arr).toHaveLength(2)
    expect(arr[0]!.text).toBe('You are helpful.')
    expect(arr[1]!.text).toMatch(/^# Tool surface/)
  })

  it('uses the appendix as-is when system is undefined', () => {
    const out = applyZhipuToolSurfaceToSystem(undefined, ['Edit'])
    expect(typeof out).toBe('string')
    expect(out).toMatch(/^# Tool surface/)
  })

  it('returns the original system unchanged when no wire tool names are provided', () => {
    const systemStr = 'existing prompt'
    expect(applyZhipuToolSurfaceToSystem(systemStr, [])).toBe(systemStr)

    const systemArr = [{ type: 'text', text: 'existing' }]
    expect(applyZhipuToolSurfaceToSystem(systemArr, [])).toBe(systemArr)

    expect(applyZhipuToolSurfaceToSystem(undefined, [])).toBeUndefined()
  })

  it('the resulting prompt lists ALL provided tools (regression: GLM missing tools)', () => {
    const allTools = [
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'Bash',
      'Agent',
      'WebSearch',
      'TodoWrite',
      'mcp__playwright__browser_navigate',
    ]
    const out = applyZhipuToolSurfaceToSystem('base', allTools) as string
    for (const name of allTools) {
      expect(out, `missing ${name} in appendix`).toContain(name)
    }
  })
})
