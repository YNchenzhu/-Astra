/**
 * Verify PTC-specific Anthropic content blocks (`server_tool_use`,
 * `code_execution_tool_result`, `tool_use.caller`) degrade safely when the
 * request is routed through a non-Anthropic wire transformer.
 *
 * This matters because users can switch providers mid-session — if a PTC
 * transcript survived in the conversation history and then got routed to
 * OpenAI / Gemini without this downgrade, the transformer would silently
 * drop the blocks and lose reasoning context.
 */

import { describe, it, expect } from 'vitest'
import { claudeToOpenAIChat } from './claudeToOpenAI'
import { claudeToOpenAI2 } from './claudeToOpenAI2'
import { claudeToGemini } from './claudeToGemini'
import { createTransformContext } from './index'
import type { ClaudeRequest } from './types'

const ptcAssistant: ClaudeRequest = {
  model: 'claude-opus-4-5',
  max_tokens: 1024,
  messages: [
    {
      role: 'user',
      content: 'Summarize revenue across West/East/Central regions',
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Running the aggregation in a sandbox.' },
        {
          type: 'server_tool_use',
          id: 'srvtoolu_abc123',
          name: 'code_execution',
          input: { code: 'total = sum([r["rev"] for r in regions])\nprint(total)' },
        },
        {
          type: 'code_execution_tool_result',
          tool_use_id: 'srvtoolu_abc123',
          content: {
            type: 'code_execution_result',
            stdout: 'Total: 125000',
            stderr: '',
            return_code: 0,
            content: [],
          },
        },
      ],
    },
  ],
}

const ptcAssistantWithToolUse: ClaudeRequest = {
  model: 'claude-opus-4-5',
  max_tokens: 1024,
  messages: [
    { role: 'user', content: 'list teams' },
    {
      role: 'assistant',
      content: [
        {
          type: 'server_tool_use',
          id: 'srvtoolu_xyz',
          name: 'code_execution',
          input: { code: 'await get_teams()' },
        },
        {
          type: 'tool_use',
          id: 'toolu_qqq',
          name: 'get_teams',
          input: {},
          caller: {
            type: 'code_execution_20260120',
            tool_id: 'srvtoolu_xyz',
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_qqq', content: '["a","b"]' },
      ],
    },
  ],
}

describe('claudeToOpenAIChat — PTC downgrade', () => {
  it('renders server_tool_use + code_execution_tool_result as text inside the assistant message', () => {
    const ctx = createTransformContext()
    const req = claudeToOpenAIChat(ptcAssistant, ctx)
    const assistant = req.messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    const content =
      typeof assistant!.content === 'string' ? assistant!.content : ''
    expect(content).toContain('Running the aggregation in a sandbox.')
    expect(content).toContain('[PTC: Claude ran the following Python')
    expect(content).toContain('total = sum(')
    expect(content).toContain('[PTC result — exit=0]')
    expect(content).toContain('Total: 125000')
  })

  it('does NOT emit tool_calls entries for server_tool_use (no OpenAI function_call injection)', () => {
    const ctx = createTransformContext()
    const req = claudeToOpenAIChat(ptcAssistant, ctx)
    const assistant = req.messages.find((m) => m.role === 'assistant')
    expect(assistant?.tool_calls ?? []).toEqual([])
  })

  it('drops the PTC `caller` field when emitting the ordinary function tool_call', () => {
    const ctx = createTransformContext()
    const req = claudeToOpenAIChat(ptcAssistantWithToolUse, ctx)
    const assistant = req.messages.find((m) => m.role === 'assistant')
    expect(assistant?.tool_calls).toBeDefined()
    expect(assistant!.tool_calls![0]!.function.name).toBe('get_teams')
    expect(Object.keys(assistant!.tool_calls![0]!)).not.toContain('caller')
  })
})

describe('claudeToOpenAI2 — PTC downgrade (Responses API)', () => {
  it('folds PTC blocks into the assistant output_text item', () => {
    const ctx = createTransformContext()
    const req = claudeToOpenAI2(ptcAssistant, ctx)
    const assistantMsg = req.input.find(
      (it) => it.type === 'message' && it.role === 'assistant',
    )
    expect(assistantMsg).toBeDefined()
    const text = (assistantMsg!.content ?? [])
      .map((c) => {
        const tc = c as { type: string; text?: string }
        return tc.type === 'output_text' && typeof tc.text === 'string' ? tc.text : ''
      })
      .join('')
    expect(text).toContain('[PTC: Claude ran the following Python')
    expect(text).toContain('[PTC result — exit=0]')
    expect(text).toContain('Total: 125000')
  })
})

describe('claudeToGemini — PTC downgrade', () => {
  it('folds PTC blocks into text parts on the model content', () => {
    const ctx = createTransformContext()
    const req = claudeToGemini(ptcAssistant, ctx)
    const model = req.contents.find((c) => c.role === 'model')
    expect(model).toBeDefined()
    const text = (model!.parts ?? [])
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('')
    expect(text).toContain('[PTC: Claude ran the following Python')
    expect(text).toContain('total = sum(')
    expect(text).toContain('Total: 125000')
    const fnCalls = model!.parts.filter((p) => p.functionCall)
    expect(fnCalls).toEqual([])
  })

  it('drops PTC `caller` on ordinary tool_use blocks', () => {
    const ctx = createTransformContext()
    const req = claudeToGemini(ptcAssistantWithToolUse, ctx)
    const model = req.contents.find((c) => c.role === 'model')
    const fn = model!.parts.find((p) => p.functionCall)
    expect(fn?.functionCall?.name).toBe('get_teams')
    expect('caller' in (fn ?? {})).toBe(false)
  })
})
