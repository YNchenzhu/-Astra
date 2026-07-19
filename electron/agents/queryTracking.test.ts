import { describe, expect, it } from 'vitest'
import {
  attachPoleQueryTrackingToTailUserMessage,
  getPreviousRequestIdFromMessages,
} from './queryTracking'
import { POLE_QUERY_TRACKING_KEY } from '../context/tokenUsageAccounting'

describe('queryTracking §16.2', () => {
  it('getPreviousRequestIdFromMessages returns latest user request id', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: 'a' },
      {
        role: 'user',
        content: 'b',
        [POLE_QUERY_TRACKING_KEY]: { chainId: 'c1', requestId: 'req-b', source: 'repl_main_thread' },
      },
    ]
    expect(getPreviousRequestIdFromMessages(messages)).toBe('req-b')
  })

  it('attachPoleQueryTrackingToTailUserMessage updates the last user row', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'assistant', content: 'x' },
      { role: 'user', content: 'last' },
    ]
    attachPoleQueryTrackingToTailUserMessage(messages, {
      chainId: 'cc',
      requestId: 'rr',
      source: 'repl_main_thread',
    })
    const t = messages[1][POLE_QUERY_TRACKING_KEY] as { requestId: string }
    expect(t.requestId).toBe('rr')
  })
})
