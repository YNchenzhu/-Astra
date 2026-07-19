import { describe, expect, it } from 'vitest'
import {
  createSiblingShellFailureReason,
  formatParallelToolSiblingCancelError,
  toolResultContentForAbortedSignal,
} from './siblingShellAbortReason'

describe('siblingShellAbortReason (report §4.4)', () => {
  it('formats OC-style cancel sentence', () => {
    expect(formatParallelToolSiblingCancelError('toolu_01')).toBe(
      'Cancelled: parallel tool call toolu_01 errored',
    )
  })

  it('maps structured abort reason to tool_result body', () => {
    const ac = new AbortController()
    ac.abort(createSiblingShellFailureReason('toolu_bad'))
    expect(toolResultContentForAbortedSignal(ac.signal)).toBe(
      'Error: Cancelled: parallel tool call toolu_bad errored',
    )
  })

  it('uses generic cancel when reason is not sibling payload', () => {
    const ac = new AbortController()
    ac.abort()
    expect(toolResultContentForAbortedSignal(ac.signal)).toBe('Error: Tool execution cancelled.')
  })
})
