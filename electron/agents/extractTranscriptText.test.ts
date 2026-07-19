import { describe, it, expect } from 'vitest'
import { extractLastAssistantText } from './extractTranscriptText'

describe('extractLastAssistantText', () => {
  it('returns undefined for an empty array', () => {
    expect(extractLastAssistantText([])).toBeUndefined()
  })

  it('returns undefined for an undefined input', () => {
    expect(extractLastAssistantText(undefined)).toBeUndefined()
  })

  it('returns undefined when no assistant message exists', () => {
    expect(
      extractLastAssistantText([
        { role: 'user', content: 'hi' },
        { role: 'user', content: [{ type: 'text', text: 'still user' }] },
      ]),
    ).toBeUndefined()
  })

  it('extracts string-shaped assistant content', () => {
    expect(
      extractLastAssistantText([
        { role: 'user', content: 'find the bug' },
        { role: 'assistant', content: 'The bug is in foo.ts' },
      ]),
    ).toBe('The bug is in foo.ts')
  })

  it('extracts array-of-text-blocks assistant content', () => {
    expect(
      extractLastAssistantText([
        { role: 'user', content: 'plan it' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '## Plan' },
            { type: 'text', text: '1. Read files.' },
          ],
        },
      ]),
    ).toBe('## Plan\n1. Read files.')
  })

  it('returns the MOST RECENT assistant text when several exist', () => {
    expect(
      extractLastAssistantText([
        { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
        { role: 'user', content: 'continue' },
        { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
      ]),
    ).toBe('second')
  })

  // upstream parity: this is the headline scenario. The loop exited at
  // maxTurns mid-tool-call, so the final assistant message is a pure
  // tool_use. We must walk further back to the previous assistant
  // turn that actually has text content.
  it('walks past a pure tool_use final assistant to a prior text-bearing assistant', () => {
    const messages = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will check foo.ts.' },
          { type: 'tool_use', id: 't1', name: 'read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: '...' }],
      },
      {
        role: 'assistant',
        content: [
          // No text block at all — pure tool_use, would-have-been the
          // next round of tools that never produced a tool-free reply.
          { type: 'tool_use', id: 't2', name: 'grep', input: {} },
        ],
      },
    ]
    expect(extractLastAssistantText(messages)).toBe('I will check foo.ts.')
  })

  it('skips empty-string assistant content and continues searching', () => {
    expect(
      extractLastAssistantText([
        { role: 'assistant', content: 'real text' },
        { role: 'user', content: 'noop' },
        { role: 'assistant', content: '   ' },
      ]),
    ).toBe('real text')
  })

  it('skips assistant messages whose text blocks are empty strings', () => {
    expect(
      extractLastAssistantText([
        { role: 'assistant', content: [{ type: 'text', text: 'kept' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'tool_use', id: 't1', name: 'x', input: {} },
          ],
        },
      ]),
    ).toBe('kept')
  })

  it('ignores non-text block types when joining', () => {
    expect(
      extractLastAssistantText([
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'private chain of thought' },
            { type: 'text', text: 'public answer' },
          ],
        },
      ]),
    ).toBe('public answer')
  })

  it('tolerates malformed entries without throwing', () => {
    expect(
      extractLastAssistantText([
        // @ts-expect-error intentionally malformed for robustness
        null,
        { role: 'assistant', content: undefined },
        { role: 'assistant' },
        { role: 'assistant', content: [{ type: 'text', text: 'survivor' }] },
      ]),
    ).toBe('survivor')
  })

  it('trims surrounding whitespace from the joined result without squashing internal newlines', () => {
    // Inputs join with '\n' separator; each block's intrinsic
    // newlines are preserved verbatim (this mirrors upstream's
    // `finalizeAgentTool`, which doesn't normalize whitespace —
    // markdown headings / lists / code-fences would corrupt
    // otherwise). Only leading/trailing whitespace on the
    // *joined* result is trimmed.
    expect(
      extractLastAssistantText([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '\n\n  Plan  \n' },
            { type: 'text', text: '  details\n\n' },
          ],
        },
      ]),
    ).toBe('Plan  \n\n  details')
  })
})
