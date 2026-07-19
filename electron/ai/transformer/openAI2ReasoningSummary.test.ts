/**
 * Coverage for the OpenAI Responses → pseudo-Claude SSE translation of
 * reasoning-summary events (B: Reasoning Summary channel).
 *
 * The transformer in `claudeToOpenAI2.ts#openAI2StreamToClaude` accepts
 * three event names that providers use interchangeably for the same
 * payload (`response.reasoning_summary_text.delta`,
 * `response.reasoning_summary.delta`, `response.reasoning.delta`) and
 * maps them all to our internal `{type: 'reasoning_summary_delta', text}`
 * content_block_delta. The downstream Anthropic-compat consumer in
 * `anthropicCompatHttp.ts` recognises that delta type and routes to
 * `onReasoningSummary*` callbacks (NOT merged into `thinking`).
 */

import { describe, expect, it } from 'vitest'
import { openAI2StreamToClaude } from './claudeToOpenAI2'
import { createTransformContext } from './index'

describe('openAI2StreamToClaude — reasoning_summary translation', () => {
  it('translates response.reasoning_summary_text.delta (canonical OpenAI event name)', () => {
    const ctx = createTransformContext()
    const out = openAI2StreamToClaude(
      {
        type: 'response.reasoning_summary_text.delta',
        delta: 'I considered two approaches.',
      },
      ctx,
    )
    expect(out).toEqual({
      type: 'content_block_delta',
      delta: { type: 'reasoning_summary_delta', text: 'I considered two approaches.' },
    })
  })

  it('translates the response.reasoning.delta gateway alias', () => {
    const ctx = createTransformContext()
    const out = openAI2StreamToClaude(
      { type: 'response.reasoning.delta', delta: 'thinking shorthand' },
      ctx,
    )
    expect(out).toEqual({
      type: 'content_block_delta',
      delta: { type: 'reasoning_summary_delta', text: 'thinking shorthand' },
    })
  })

  it('accepts object-shaped delta payloads ({text}) from non-canonical gateways', () => {
    const ctx = createTransformContext()
    const out = openAI2StreamToClaude(
      {
        type: 'response.reasoning_summary_text.delta',
        delta: { text: 'wrapped payload' },
      },
      ctx,
    )
    expect(out).toEqual({
      type: 'content_block_delta',
      delta: { type: 'reasoning_summary_delta', text: 'wrapped payload' },
    })
  })

  it('accepts nested {summary_text: {text}} payloads', () => {
    const ctx = createTransformContext()
    const out = openAI2StreamToClaude(
      {
        type: 'response.reasoning_summary.delta',
        delta: { summary_text: { text: 'doubly wrapped' } },
      },
      ctx,
    )
    expect(out).toEqual({
      type: 'content_block_delta',
      delta: { type: 'reasoning_summary_delta', text: 'doubly wrapped' },
    })
  })

  it('returns null on the corresponding `.done` events (avoid duplicate emission)', () => {
    const ctx = createTransformContext()
    expect(
      openAI2StreamToClaude(
        { type: 'response.reasoning_summary_text.done', text: 'full' },
        ctx,
      ),
    ).toBeNull()
    expect(
      openAI2StreamToClaude(
        { type: 'response.reasoning.done', text: 'full' },
        ctx,
      ),
    ).toBeNull()
  })

  it('returns null when the delta payload has no usable text', () => {
    const ctx = createTransformContext()
    expect(
      openAI2StreamToClaude(
        { type: 'response.reasoning_summary_text.delta', delta: '' },
        ctx,
      ),
    ).toBeNull()
    expect(
      openAI2StreamToClaude(
        { type: 'response.reasoning_summary_text.delta', delta: {} },
        ctx,
      ),
    ).toBeNull()
  })

  it('preserves existing routing for response.output_text.delta (regression: new branch must not steal text)', () => {
    const ctx = createTransformContext()
    const out = openAI2StreamToClaude(
      { type: 'response.output_text.delta', delta: 'final answer' },
      ctx,
    )
    expect(out).toEqual({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'final answer' },
    })
  })
})
