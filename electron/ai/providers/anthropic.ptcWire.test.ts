/**
 * Wire-level tests for PTC server-tool injection + tool-examples beta token.
 *
 * These are "pure" unit tests — they don't spin up an HTTP client. We
 * replicate the two small decisions the Anthropic provider makes before
 * calling `messages.stream`:
 *   1. When any tool declares `allowed_callers: ['code_execution_*']`, the
 *      `code_execution_20260120` server-tool entry is prepended to the tools
 *      array (so Anthropic's backend spins up the sandbox).
 *   2. When any tool declares non-empty `input_examples`, the
 *      `tool-examples-2025-10-29` beta token is attached to the stream
 *      request headers.
 *
 * The goal is to catch regressions in the two helper predicates that the
 * provider relies on (`toolsContainInputExamples`,
 * `toolsRequirePtcServerTool`) plus a sanity check on the server-tool
 * entry shape we prepend.
 */

import { describe, it, expect } from 'vitest'
import {
  prepareToolsForWire,
  toolsContainInputExamples,
  toolsRequirePtcServerTool,
} from '../toolSchemaSanitizer'
import {
  ANTHROPIC_TOOL_EXAMPLES_BETA_TOKEN,
  resolvePtcEnabled,
  resolveToolExamplesMode,
  BUILTIN_QUIRKS,
} from '../providerQuirks'

const baseTool = {
  name: 'read_file',
  description: 'Read a file',
  input_schema: {
    type: 'object',
    properties: { filePath: { type: 'string' } },
    required: ['filePath'],
  },
}

describe('PTC server-tool + allowed_callers wire injection', () => {
  it('anthropic native + PTC: tools[0] is the code_execution server-tool descriptor', () => {
    const tool = { ...baseTool, allowed_callers: ['code_execution_20260120'] }
    const ptcActive = true
    const sanitized = prepareToolsForWire([tool], 'anthropic', {
      examples: 'native',
      ptcEnabled: ptcActive,
    })
    expect(toolsRequirePtcServerTool(sanitized)).toBe(true)

    // Emulate the provider's server-tool prepend (see
    // `electron/ai/providers/anthropic.ts`).
    const wireTools: Array<Record<string, unknown>> = [...sanitized]
    if (toolsRequirePtcServerTool(sanitized)) {
      wireTools.unshift({
        type: 'code_execution_20260120',
        name: 'code_execution',
      })
    }
    expect(wireTools[0]).toEqual({
      type: 'code_execution_20260120',
      name: 'code_execution',
    })
    expect(wireTools[1]!.name).toBe('read_file')
  })

  it('when PTC not active, allowed_callers is stripped AND no server-tool is prepended', () => {
    const tool = { ...baseTool, allowed_callers: ['code_execution_20260120'] }
    const sanitized = prepareToolsForWire([tool], 'anthropic-compat', {
      examples: 'description-fallback',
      ptcEnabled: false,
    })
    expect(sanitized[0]!.allowed_callers).toBeUndefined()
    expect(toolsRequirePtcServerTool(sanitized)).toBe(false)
  })

  it('tool with allowed_callers: ["direct"] (no code_execution) is not PTC-eligible', () => {
    const tool = { ...baseTool, allowed_callers: ['direct'] }
    const sanitized = prepareToolsForWire([tool], 'anthropic', {
      examples: 'native',
      ptcEnabled: true,
    })
    expect(toolsRequirePtcServerTool(sanitized)).toBe(false)
  })
})

describe('Tool Examples beta token attachment', () => {
  it('examples token emitted when any tool carries input_examples on anthropic native wire', () => {
    const tool = {
      ...baseTool,
      input_examples: [{ filePath: 'a.ts' }],
    }
    const examplesMode = resolveToolExamplesMode(
      BUILTIN_QUIRKS.anthropic,
      'claude-opus-4-5',
    )
    expect(examplesMode).toBe('native')
    const sanitized = prepareToolsForWire([tool], 'anthropic', {
      examples: 'native',
      ptcEnabled: false,
    })
    expect(toolsContainInputExamples(sanitized)).toBe(true)

    // Emulate the provider's beta token assembly: token attached iff
    // examples survived AND wire supports it.
    const betas: string[] = []
    if (
      toolsContainInputExamples(sanitized) &&
      BUILTIN_QUIRKS.anthropic.supportsToolExamples
    ) {
      betas.push(ANTHROPIC_TOOL_EXAMPLES_BETA_TOKEN)
    }
    expect(betas).toContain('tool-examples-2025-10-29')
  })

  it('examples token NOT emitted on anthropic-compat even when examples declared', () => {
    const tool = {
      ...baseTool,
      input_examples: [{ filePath: 'a.ts' }],
    }
    const sanitized = prepareToolsForWire([tool], 'anthropic-compat', {
      examples: 'description-fallback',
      ptcEnabled: false,
    })
    expect(toolsContainInputExamples(sanitized)).toBe(false) // examples folded into description
    expect(
      BUILTIN_QUIRKS.zhipu.supportsToolExamples,
    ).toBe(false)
  })

  it('examples token NOT emitted on OpenAI/Gemini wires (fallback policy)', () => {
    const tool = {
      ...baseTool,
      input_examples: [{ filePath: 'a.ts' }],
    }
    for (const wire of ['openai-native', 'gemini-native'] as const) {
      const sanitized = prepareToolsForWire([tool], wire, {
        examples: 'description-fallback',
        ptcEnabled: false,
      })
      expect(toolsContainInputExamples(sanitized)).toBe(false)
    }
  })
})

describe('resolvePtcEnabled gating (mirrored here for the Anthropic provider)', () => {
  it('Zhipu / Kimi / DeepSeek NEVER get PTC regardless of env', () => {
    process.env.POLE_PTC_ENABLED = '1'
    try {
      expect(resolvePtcEnabled(BUILTIN_QUIRKS.zhipu, 'claude-opus-4-5')).toBe(false)
      expect(resolvePtcEnabled(BUILTIN_QUIRKS.kimi, 'claude-opus-4-5')).toBe(false)
      expect(resolvePtcEnabled(BUILTIN_QUIRKS.deepseek, 'claude-opus-4-5')).toBe(
        false,
      )
      expect(resolvePtcEnabled(BUILTIN_QUIRKS.dashscope, 'claude-opus-4-5')).toBe(
        false,
      )
      expect(resolvePtcEnabled(BUILTIN_QUIRKS.minimax, 'claude-opus-4-5')).toBe(
        false,
      )
    } finally {
      delete process.env.POLE_PTC_ENABLED
    }
  })
})
