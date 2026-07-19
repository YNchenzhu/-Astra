import { describe, expect, it, vi } from 'vitest'
import { createStreamReasoningCallbacks } from './streamReasoningCallbacks'

describe('createStreamReasoningCallbacks', () => {
  it('maps every reasoning callback to its renderer stream event', () => {
    const emit = vi.fn()
    const callbacks = createStreamReasoningCallbacks(emit)

    callbacks.onThinkingDelta('plan')
    callbacks.onThinkingBlock({ thinking: 'plan', signature: 'sig' })
    callbacks.onRedactedThinkingBlock({ data: 'opaque' })
    callbacks.onReasoningSummaryDelta('summary')
    callbacks.onReasoningSummaryBlock({ text: 'summary' })

    expect(emit.mock.calls.map((call) => call[0])).toEqual([
      { type: 'thinking_delta', text: 'plan' },
      {
        type: 'thinking_block_complete',
        thinkingBlock: { thinking: 'plan', signature: 'sig' },
      },
      {
        type: 'redacted_thinking_block',
        redactedThinkingBlock: { data: 'opaque' },
      },
      { type: 'reasoning_summary_delta', text: 'summary' },
      {
        type: 'reasoning_summary_block_complete',
        reasoningSummaryBlock: { text: 'summary' },
      },
    ])
  })
})
