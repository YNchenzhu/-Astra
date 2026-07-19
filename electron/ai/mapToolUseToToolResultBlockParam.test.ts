import { describe, expect, it } from 'vitest'
import {
  mapToolUseToToolResultBlockParam,
  TOOL_FAILURE_DIRECTIVE,
} from './mapToolUseToToolResultBlockParam'

describe('mapToolUseToToolResultBlockParam (report §4.1)', () => {
  it('builds success block', () => {
    expect(
      mapToolUseToToolResultBlockParam({
        toolUseId: 't1',
        success: true,
        output: 'ok',
      }),
    ).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'ok',
    })
  })

  it('builds failure block with is_error flag', () => {
    expect(
      mapToolUseToToolResultBlockParam({
        toolUseId: 't1',
        success: false,
        error: 'boom',
      }),
    ).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: `Error: boom\n\n${TOOL_FAILURE_DIRECTIVE}`,
      is_error: true,
    })
  })

  it('keeps "Error:" as the first token and the diagnosis before the directive', () => {
    const block = mapToolUseToToolResultBlockParam({
      toolUseId: 't1',
      success: false,
      error: 'old_string not found',
    })
    // Failure detection across the pipeline keys on this prefix.
    expect(block.content.trimStart().startsWith('Error:')).toBe(true)
    // The real diagnosis must precede the constant directive tail so
    // distinct failures still produce distinct summaries / ledger previews.
    expect(block.content.indexOf('old_string not found')).toBeLessThan(
      block.content.indexOf(TOOL_FAILURE_DIRECTIVE),
    )
  })

  it('falls back to "Unknown error" when no error string is provided', () => {
    const block = mapToolUseToToolResultBlockParam({
      toolUseId: 't1',
      success: false,
    })
    expect(block.content).toBe(`Error: Unknown error\n\n${TOOL_FAILURE_DIRECTIVE}`)
    expect(block.is_error).toBe(true)
  })
})
