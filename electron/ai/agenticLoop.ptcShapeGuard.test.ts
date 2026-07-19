/**
 * Pure unit test for the PTC "tool_result-only" shape guard logic.
 *
 * The guard lives inside `runAgenticLoop` where it mutates local state, so
 * we replicate the decision here against identical inputs to lock the
 * semantic contract: whenever the batch contains a `tool_use` with a
 * `caller.type === 'code_execution_20260120'`, the user reply must contain
 * ONLY `tool_result` blocks — any follow-up discovery / advisory text rides
 * in a SEPARATE subsequent user message.
 *
 * Rationale — Anthropic docs "Programmatic tool calling — Message formatting
 * restrictions" explicitly reject mixed content:
 *   > "If there are pending programmatic tool calls waiting for results,
 *      your response message must contain only `tool_result` blocks. You
 *      cannot include any text content, even after the tool results."
 */

import { describe, it, expect } from 'vitest'

type ToolUseBlockLike = {
  id: string
  name: string
  input: Record<string, unknown>
  caller?: { type: 'direct' | 'code_execution_20260120'; tool_id?: string }
}

type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string }

/**
 * Port of the guard logic in `agenticLoop.ts`. Extracted for isolated
 * testing. The real caller in `agenticLoop.ts` follows the exact same
 * branching.
 */
function buildToolResultReplyMessages(params: {
  toolUseBlocks: ToolUseBlockLike[]
  toolResults: ToolResultBlock[]
  followUpDiscovery: string | undefined
}): Array<{ role: 'user'; content: Array<Record<string, unknown>> }> {
  const batchHasPtcToolUse = params.toolUseBlocks.some(
    (t) => t.caller && t.caller.type === 'code_execution_20260120',
  )
  const toolResultUserContent: Array<Record<string, unknown>> = [
    ...params.toolResults,
  ]
  if (params.followUpDiscovery && !batchHasPtcToolUse) {
    toolResultUserContent.push({ type: 'text', text: params.followUpDiscovery })
  }
  const messages: Array<{ role: 'user'; content: Array<Record<string, unknown>> }> = [
    { role: 'user', content: toolResultUserContent },
  ]
  if (params.followUpDiscovery && batchHasPtcToolUse) {
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: params.followUpDiscovery }],
    })
  }
  return messages
}

describe('PTC tool_result shape guard', () => {
  it('non-PTC batch: folds follow-up discovery into the tool_result user message', () => {
    const out = buildToolResultReplyMessages({
      toolUseBlocks: [
        { id: 'toolu_1', name: 'read_file', input: {} }, // no caller = direct
      ],
      toolResults: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello' },
      ],
      followUpDiscovery: 'You may also want to use `grep`.',
    })
    expect(out).toHaveLength(1)
    const content = out[0].content
    expect(content).toHaveLength(2)
    expect(content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' })
    expect(content[1]).toMatchObject({ type: 'text' })
  })

  it('PTC batch: keeps tool_result user message pure AND defers discovery to a follow-up user message', () => {
    const out = buildToolResultReplyMessages({
      toolUseBlocks: [
        {
          id: 'toolu_q',
          name: 'query_db',
          input: {},
          caller: { type: 'code_execution_20260120', tool_id: 'srvtoolu_abc' },
        },
      ],
      toolResults: [
        { type: 'tool_result', tool_use_id: 'toolu_q', content: '[]' },
      ],
      followUpDiscovery: 'Consider using TeamSearch next.',
    })
    // First message: PURE tool_result (CRITICAL — wire would 400 otherwise)
    expect(out).toHaveLength(2)
    expect(out[0].content).toHaveLength(1)
    expect(out[0].content[0]).toMatchObject({ type: 'tool_result' })
    // Second message: discovery text in its own user turn
    expect(out[1].content).toEqual([
      { type: 'text', text: 'Consider using TeamSearch next.' },
    ])
  })

  it('PTC batch without follow-up discovery: no extra user message', () => {
    const out = buildToolResultReplyMessages({
      toolUseBlocks: [
        {
          id: 'toolu_q',
          name: 'query_db',
          input: {},
          caller: { type: 'code_execution_20260120', tool_id: 'srvtoolu_abc' },
        },
      ],
      toolResults: [
        { type: 'tool_result', tool_use_id: 'toolu_q', content: '[]' },
      ],
      followUpDiscovery: undefined,
    })
    expect(out).toHaveLength(1)
    expect(out[0].content).toHaveLength(1)
  })

  it('mixed batch (one PTC + one direct) still triggers the guard — worst case wins', () => {
    const out = buildToolResultReplyMessages({
      toolUseBlocks: [
        {
          id: 'toolu_p',
          name: 'query_db',
          input: {},
          caller: { type: 'code_execution_20260120', tool_id: 'srvtoolu_abc' },
        },
        { id: 'toolu_d', name: 'read_file', input: {} },
      ],
      toolResults: [
        { type: 'tool_result', tool_use_id: 'toolu_p', content: '[]' },
        { type: 'tool_result', tool_use_id: 'toolu_d', content: 'ok' },
      ],
      followUpDiscovery: 'hint',
    })
    expect(out).toHaveLength(2)
    expect(out[0].content).toHaveLength(2) // both tool_results
    expect(out[0].content.every((c) => (c as { type: string }).type === 'tool_result')).toBe(true)
    expect(out[1].content[0]).toMatchObject({ type: 'text', text: 'hint' })
  })

  it('explicit caller: direct is NOT treated as PTC', () => {
    const out = buildToolResultReplyMessages({
      toolUseBlocks: [
        { id: 'toolu_1', name: 'read_file', input: {}, caller: { type: 'direct' } },
      ],
      toolResults: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
      ],
      followUpDiscovery: 'next steps…',
    })
    expect(out).toHaveLength(1)
    expect(out[0].content).toHaveLength(2) // tool_result + inline text
  })
})
