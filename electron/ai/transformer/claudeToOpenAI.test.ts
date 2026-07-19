import { describe, expect, it } from 'vitest'
import { claudeToOpenAIChat } from './claudeToOpenAI'
import { createTransformContext } from './index'
import type { ClaudeRequest, OpenAIMessage } from './types'

describe('claudeToOpenAIChat', () => {
  it('emits tool result messages immediately after assistant tool calls', () => {
    const req: ClaudeRequest = {
      model: 'gpt-compatible',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_a',
              name: 'Read',
              input: { path: 'a.ts' },
            },
            {
              type: 'tool_use',
              id: 'call_b',
              name: 'Read',
              input: { path: 'b.ts' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_a', content: 'A' },
            { type: 'tool_result', tool_use_id: 'call_b', content: 'B' },
            { type: 'text', text: '<system-reminder>pairing repair marker</system-reminder>' },
          ],
        },
      ],
    }

    const out = claudeToOpenAIChat(req, createTransformContext())
    const messages = out.messages as OpenAIMessage[]

    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
    expect(messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_a' })
    expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_b' })
    expect(messages[3]).toMatchObject({
      role: 'user',
      content: '<system-reminder>pairing repair marker</system-reminder>',
    })
  })

  it('drops orphan tool results whose assistant tool call was compacted away', () => {
    const req: ClaudeRequest = {
      model: 'gpt-compatible',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'missing_call', content: 'orphan' },
            { type: 'text', text: 'continue the task' },
          ],
        },
      ],
    }

    const out = claudeToOpenAIChat(req, createTransformContext())
    const messages = out.messages as OpenAIMessage[]

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user', content: 'continue the task' })
  })

  it('inserts synthetic tool messages for missing assistant tool results', () => {
    const req: ClaudeRequest = {
      model: 'gpt-compatible',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_missing',
              name: 'Read',
              input: { path: 'missing.ts' },
            },
          ],
        },
        { role: 'user', content: 'what happened next?' },
      ],
    }

    const out = claudeToOpenAIChat(req, createTransformContext())
    const messages = out.messages as OpenAIMessage[]

    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'user'])
    expect(messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_missing' })
    expect(String(messages[1].content)).toContain('synthetic tool message')
  })
})
