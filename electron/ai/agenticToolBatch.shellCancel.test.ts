import { describe, it, expect } from 'vitest'
import { toolResultBlockIndicatesFailure } from './agenticToolBatch'

describe('toolResultBlockIndicatesFailure (report §4.4 sibling cancel)', () => {
  it('detects runAgenticToolUse error-shaped content', () => {
    expect(
      toolResultBlockIndicatesFailure({
        type: 'tool_result',
        tool_use_id: 'x',
        content: 'Error: boom',
      }),
    ).toBe(true)
  })

  it('detects sibling parallel cancel (OC §4.4)', () => {
    expect(
      toolResultBlockIndicatesFailure({
        type: 'tool_result',
        tool_use_id: 'y',
        content: 'Error: Cancelled: parallel tool call x errored',
      }),
    ).toBe(true)
  })

  it('ignores success bodies', () => {
    expect(
      toolResultBlockIndicatesFailure({
        type: 'tool_result',
        content: 'All good',
      }),
    ).toBe(false)
  })
})
