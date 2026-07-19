/**
 * F1 (2026-06) — openai2 (Responses API) stateless reasoning passthrough.
 *
 * Covers:
 *   1. Request gating: `ctx.openai2ReasoningEnabled` adds `store:false` +
 *      `include:["reasoning.encrypted_content"]`; absent otherwise.
 *   2. History replay: a tool_use block carrying `openai2Reasoning` emits a
 *      `reasoning` input item immediately BEFORE its `function_call` — but
 *      only for assistant messages after the last genuine user turn.
 *   3. Stream capture: `response.output_item.done` with a reasoning item
 *      surfaces the internal `openai2_reasoning_item` pseudo-event; plain
 *      function_call done still maps to `content_block_stop`.
 */

import { describe, expect, it } from 'vitest'
import { claudeToOpenAI2, openAI2StreamToClaude } from './claudeToOpenAI2'
import { createTransformContext } from './index'
import type { ClaudeRequest } from './types'

function makeCtx(enabled: boolean) {
  const ctx = createTransformContext()
  if (enabled) ctx.openai2ReasoningEnabled = true
  return ctx
}

const REASONING = { id: 'rs_abc123', encrypted_content: 'gAAAA-opaque' }

function makeRequest(): ClaudeRequest {
  return {
    model: 'gpt-5.1',
    max_tokens: 8192,
    messages: [
      { role: 'user', content: 'do the task' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'read_file',
            input: { filePath: 'a.ts' },
            openai2Reasoning: REASONING,
          } as never,
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'file body' } as never,
        ],
      },
    ],
  } as unknown as ClaudeRequest
}

describe('claudeToOpenAI2 — F1 reasoning passthrough', () => {
  it('adds store:false + include when enabled', () => {
    const req = claudeToOpenAI2(makeRequest(), makeCtx(true))
    expect(req.store).toBe(false)
    expect(req.include).toEqual(['reasoning.encrypted_content'])
  })

  it('omits store/include when disabled', () => {
    const req = claudeToOpenAI2(makeRequest(), makeCtx(false))
    expect(req.store).toBeUndefined()
    expect(req.include).toBeUndefined()
  })

  it('replays the reasoning item immediately before its function_call', () => {
    const req = claudeToOpenAI2(makeRequest(), makeCtx(true))
    const items = req.input as Array<Record<string, unknown>>
    const reasoningIdx = items.findIndex((i) => i.type === 'reasoning')
    const callIdx = items.findIndex((i) => i.type === 'function_call')
    expect(reasoningIdx).toBeGreaterThanOrEqual(0)
    expect(callIdx).toBe(reasoningIdx + 1)
    expect(items[reasoningIdx]).toMatchObject({
      type: 'reasoning',
      id: REASONING.id,
      encrypted_content: REASONING.encrypted_content,
      summary: [],
    })
  })

  it('does NOT replay reasoning when disabled', () => {
    const req = claudeToOpenAI2(makeRequest(), makeCtx(false))
    const items = req.input as Array<Record<string, unknown>>
    expect(items.some((i) => i.type === 'reasoning')).toBe(false)
  })

  it('does NOT replay reasoning from before the last genuine user turn', () => {
    const base = makeRequest()
    // Append a NEW genuine user turn after the tool loop — the earlier
    // assistant message's reasoning is now out of scope.
    base.messages.push({ role: 'user', content: 'next question' } as never)
    const req = claudeToOpenAI2(base, makeCtx(true))
    const items = req.input as Array<Record<string, unknown>>
    expect(items.some((i) => i.type === 'reasoning')).toBe(false)
  })

  it('skips replay when the stored payload has no id', () => {
    const base = makeRequest()
    const assistant = base.messages[1] as { content: Array<Record<string, unknown>> }
    assistant.content[0].openai2Reasoning = { encrypted_content: 'no-id' }
    const req = claudeToOpenAI2(base, makeCtx(true))
    const items = req.input as Array<Record<string, unknown>>
    expect(items.some((i) => i.type === 'reasoning')).toBe(false)
  })
})

describe('openAI2StreamToClaude — F1 reasoning capture', () => {
  it('maps a reasoning output_item.done to the internal pseudo-event', () => {
    const ev = openAI2StreamToClaude(
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' },
      },
      createTransformContext(),
    )
    expect(ev).toEqual({
      type: 'openai2_reasoning_item',
      reasoning: { id: 'rs_1', encrypted_content: 'enc' },
    })
  })

  it('drops a reasoning item without encrypted_content (no include granted)', () => {
    const ev = openAI2StreamToClaude(
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_1', summary: [] },
      },
      createTransformContext(),
    )
    expect(ev).toBeNull()
  })

  it('still maps non-reasoning output_item.done to content_block_stop', () => {
    const ev = openAI2StreamToClaude(
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_1', name: 'read_file' },
      },
      createTransformContext(),
    )
    expect(ev).toEqual({ type: 'content_block_stop' })
  })
})
