import { describe, expect, it, beforeEach } from 'vitest'
import {
  markSessionMemoryExtractConsumed,
  recordMainThreadSessionMemorySignals,
  resetSessionMemoryTriggerForTests,
  shouldTriggerSessionMemoryExtract,
  SESSION_MEMORY_INIT_MESSAGE_TOKENS,
  SESSION_MEMORY_MIN_TOKENS_BETWEEN_UPDATES,
  SESSION_MEMORY_TOOL_CALLS_BETWEEN_UPDATES,
} from './sessionMemoryTrigger'

beforeEach(() => {
  resetSessionMemoryTriggerForTests()
})

describe('sessionMemoryTrigger (OpenClaude §3.2)', () => {
  it('triggers when init token threshold + ≥3 tool calls', () => {
    const id = 'c1'
    for (let i = 0; i < SESSION_MEMORY_TOOL_CALLS_BETWEEN_UPDATES; i++) {
      recordMainThreadSessionMemorySignals(id, {
        inputTokensThisTurn: Math.ceil(SESSION_MEMORY_INIT_MESSAGE_TOKENS / 3),
        toolCallsThisTurn: 1,
      })
    }
    expect(shouldTriggerSessionMemoryExtract(id)).toBe(true)
  })

  it('triggers on natural breakpoint: init tokens + last turn 0 tools', () => {
    const id = 'c2'
    recordMainThreadSessionMemorySignals(id, {
      inputTokensThisTurn: SESSION_MEMORY_INIT_MESSAGE_TOKENS,
      toolCallsThisTurn: 0,
    })
    expect(shouldTriggerSessionMemoryExtract(id)).toBe(true)
  })

  it('does not trigger below init token threshold even with 0 tools', () => {
    const id = 'c2b'
    recordMainThreadSessionMemorySignals(id, {
      inputTokensThisTurn: SESSION_MEMORY_INIT_MESSAGE_TOKENS - 1,
      toolCallsThisTurn: 0,
    })
    expect(shouldTriggerSessionMemoryExtract(id)).toBe(false)
  })

  it('after consume, uses 5k update threshold + 0-tool breakpoint', () => {
    const id = 'c4'
    recordMainThreadSessionMemorySignals(id, {
      inputTokensThisTurn: SESSION_MEMORY_INIT_MESSAGE_TOKENS,
      toolCallsThisTurn: 0,
    })
    expect(shouldTriggerSessionMemoryExtract(id)).toBe(true)
    markSessionMemoryExtractConsumed(id)
    expect(shouldTriggerSessionMemoryExtract(id)).toBe(false)
    recordMainThreadSessionMemorySignals(id, {
      inputTokensThisTurn: SESSION_MEMORY_MIN_TOKENS_BETWEEN_UPDATES,
      toolCallsThisTurn: 0,
    })
    expect(shouldTriggerSessionMemoryExtract(id)).toBe(true)
  })

  it('markSessionMemoryExtractConsumed resets rolling counters', () => {
    const id = 'c3'
    for (let i = 0; i < SESSION_MEMORY_TOOL_CALLS_BETWEEN_UPDATES; i++) {
      recordMainThreadSessionMemorySignals(id, {
        inputTokensThisTurn: Math.ceil(SESSION_MEMORY_INIT_MESSAGE_TOKENS / 3),
        toolCallsThisTurn: 1,
      })
    }
    expect(shouldTriggerSessionMemoryExtract(id)).toBe(true)
    markSessionMemoryExtractConsumed(id)
    expect(shouldTriggerSessionMemoryExtract(id)).toBe(false)
  })
})
