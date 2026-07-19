/**
 * Unit tests for Advanced Tool Use (Examples + PTC) sanitization.
 *
 * Covers both the per-wire policy matrix
 * ({@link applyAdvancedToolUsePolicies}) and the high-level wire-builder
 * entry point ({@link prepareToolsForWire}).
 */

import { describe, it, expect } from 'vitest'
import {
  applyAdvancedToolUsePolicies,
  appendExamplesToDescription,
  defaultExamplesPolicyForWire,
  prepareToolsForWire,
  renderExamplesAsDescriptionAppendix,
  toolsContainInputExamples,
  toolsRequirePtcServerTool,
  ANTHROPIC_MAX_TOOL_EXAMPLES,
} from './toolSchemaSanitizer'

describe('renderExamplesAsDescriptionAppendix', () => {
  it('returns empty string when no examples', () => {
    expect(renderExamplesAsDescriptionAppendix(undefined)).toBe('')
    expect(renderExamplesAsDescriptionAppendix([])).toBe('')
  })

  it('renders numbered JSON examples under a header', () => {
    const out = renderExamplesAsDescriptionAppendix([
      { filePath: 'a.ts' },
      { filePath: 'b.ts', offset: 0 },
    ])
    expect(out).toMatch(/^### Usage examples/)
    expect(out).toContain('Example 1:')
    expect(out).toContain('Example 2:')
    expect(out).toContain('"filePath": "a.ts"')
    expect(out).toContain('"offset": 0')
  })

  it('caps to the Anthropic-documented 20 examples', () => {
    const twenty5 = Array.from({ length: 25 }, (_, i) => ({ i }))
    const out = renderExamplesAsDescriptionAppendix(twenty5)
    expect(out).toContain(`Example ${ANTHROPIC_MAX_TOOL_EXAMPLES}:`)
    expect(out).not.toContain(`Example ${ANTHROPIC_MAX_TOOL_EXAMPLES + 1}:`)
  })
})

describe('appendExamplesToDescription', () => {
  it('no-ops when examples is empty', () => {
    expect(appendExamplesToDescription('hello', undefined)).toBe('hello')
  })
  it('appends with a blank-line separator', () => {
    const out = appendExamplesToDescription('tool help', [{ q: 1 }])
    expect(out.startsWith('tool help\n\n### Usage examples')).toBe(true)
  })
})

describe('applyAdvancedToolUsePolicies', () => {
  const base = {
    name: 'read_file',
    description: 'Read a file',
    input_schema: { type: 'object', properties: { filePath: { type: 'string' } } },
    input_examples: [{ filePath: 'a.ts' }],
    allowed_callers: ['code_execution_20260120'],
  }

  it('native policy keeps input_examples and caps at 20', () => {
    const big = { ...base, input_examples: Array.from({ length: 30 }, (_, i) => ({ i })) }
    const out = applyAdvancedToolUsePolicies(big, { examples: 'native', ptcEnabled: true })
    expect(out.input_examples).toBeDefined()
    expect(out.input_examples!.length).toBe(ANTHROPIC_MAX_TOOL_EXAMPLES)
  })

  it('description-fallback folds examples into description and drops input_examples', () => {
    const out = applyAdvancedToolUsePolicies(base, {
      examples: 'description-fallback',
      ptcEnabled: false,
    })
    expect(out.input_examples).toBeUndefined()
    expect(out.description).toContain('### Usage examples')
    expect(out.description).toContain('"filePath": "a.ts"')
  })

  it('drop policy strips input_examples without touching description', () => {
    const out = applyAdvancedToolUsePolicies(base, {
      examples: 'drop',
      ptcEnabled: false,
    })
    expect(out.input_examples).toBeUndefined()
    expect(out.description).toBe('Read a file')
  })

  it('ptcEnabled=false strips allowed_callers', () => {
    const out = applyAdvancedToolUsePolicies(base, {
      examples: 'drop',
      ptcEnabled: false,
    })
    expect(out.allowed_callers).toBeUndefined()
  })

  it('ptcEnabled=true preserves non-empty allowed_callers', () => {
    const out = applyAdvancedToolUsePolicies(base, {
      examples: 'native',
      ptcEnabled: true,
    })
    expect(out.allowed_callers).toEqual(['code_execution_20260120'])
  })

  it('ptcEnabled=true drops empty allowed_callers array', () => {
    const withEmpty = { ...base, allowed_callers: [] }
    const out = applyAdvancedToolUsePolicies(withEmpty, {
      examples: 'drop',
      ptcEnabled: true,
    })
    expect(out.allowed_callers).toBeUndefined()
  })
})

describe('defaultExamplesPolicyForWire', () => {
  it('returns native on anthropic when allowed', () => {
    expect(defaultExamplesPolicyForWire('anthropic', true)).toBe('native')
  })
  it('returns description-fallback elsewhere', () => {
    for (const wire of [
      'anthropic-compat',
      'openai-native',
      'openai-compat',
      'openai2-native',
      'openai2-compat',
      'gemini-native',
      'gemini-compat',
    ] as const) {
      expect(defaultExamplesPolicyForWire(wire, true)).toBe('description-fallback')
    }
  })
  it('falls back when native is not allowed even on anthropic wire', () => {
    expect(defaultExamplesPolicyForWire('anthropic', false)).toBe('description-fallback')
  })
})

describe('prepareToolsForWire — end-to-end wire handling', () => {
  const tool = {
    name: 'read_file',
    description: 'Read a file',
    input_schema: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
      additionalProperties: false,
    },
    input_examples: [{ filePath: 'a.ts' }],
    allowed_callers: ['code_execution_20260120'],
  }

  it('anthropic wire + native examples + PTC: preserves both fields', () => {
    const [out] = prepareToolsForWire([tool], 'anthropic', {
      examples: 'native',
      ptcEnabled: true,
    })
    expect(out.input_examples).toEqual([{ filePath: 'a.ts' }])
    expect(out.allowed_callers).toEqual(['code_execution_20260120'])
    // additionalProperties kept on `anthropic` wire.
    expect(out.input_schema.additionalProperties).toBe(false)
  })

  it('zhipu-like anthropic-compat wire: strips both fields, folds examples into description', () => {
    const [out] = prepareToolsForWire([tool], 'anthropic-compat', {
      examples: 'description-fallback',
      ptcEnabled: false,
    })
    expect(out.input_examples).toBeUndefined()
    expect(out.allowed_callers).toBeUndefined()
    expect(out.description).toContain('### Usage examples')
    // additionalProperties stripped on anthropic-compat wire.
    expect(out.input_schema.additionalProperties).toBeUndefined()
  })

  it('openai-native: strips PTC and input_examples, folds into description', () => {
    const [out] = prepareToolsForWire([tool], 'openai-native', {
      examples: 'description-fallback',
      ptcEnabled: false,
    })
    expect(out.input_examples).toBeUndefined()
    expect(out.allowed_callers).toBeUndefined()
    expect(out.description).toContain('"filePath": "a.ts"')
  })

  it('gemini-native: strips PTC + input_examples + additionalProperties', () => {
    const [out] = prepareToolsForWire([tool], 'gemini-native', {
      examples: 'description-fallback',
      ptcEnabled: false,
    })
    expect(out.input_examples).toBeUndefined()
    expect(out.allowed_callers).toBeUndefined()
    expect(out.input_schema.additionalProperties).toBeUndefined()
  })
})

describe('helper predicates', () => {
  it('toolsContainInputExamples detects any non-empty input_examples', () => {
    expect(
      toolsContainInputExamples([
        { input_examples: [] },
        { input_examples: [{ a: 1 }] },
      ]),
    ).toBe(true)
    expect(toolsContainInputExamples([{ input_examples: [] }, {}])).toBe(false)
  })

  it('toolsRequirePtcServerTool detects code_execution_20260120 caller', () => {
    expect(
      toolsRequirePtcServerTool([
        { allowed_callers: ['direct'] },
        { allowed_callers: ['direct', 'code_execution_20260120'] },
      ]),
    ).toBe(true)
    expect(toolsRequirePtcServerTool([{ allowed_callers: ['direct'] }])).toBe(false)
    expect(toolsRequirePtcServerTool([{}])).toBe(false)
  })
})
