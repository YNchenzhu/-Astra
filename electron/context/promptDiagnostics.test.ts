import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetPromptDiagnosticsForTests,
  failPromptDiagnostics,
  finishPromptDiagnostics,
  getPromptDiagnosticsRecords,
  markPromptDiagnosticsFirstResponse,
  startPromptDiagnostics,
} from './promptDiagnostics'

describe('promptDiagnostics', () => {
  beforeEach(() => __resetPromptDiagnosticsForTests())

  it('records payload hashes, timing, cache usage, and diagnosis without storing prompt text', () => {
    const id = startPromptDiagnostics({
      conversationId: 'conv-1',
      agentId: 'main',
      providerId: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      iteration: 1,
      systemPrompt: 'system prompt secret body',
      systemPromptLayers: {
        systemContext: 'stable system secret',
        userContext: '',
        userMessageContext: '',
      },
      apiMessages: [
        { role: 'user', content: '<system-reminder type="user-meta-context">meta</system-reminder>', _convertedFromSystem: true },
        { role: 'user', content: 'hello' },
      ],
      toolTokens: 123,
      effort: 'high',
      alwaysThinking: true,
      thinkingBudgetTokens: 8192,
      systemContextCacheControl: true,
      now: 1000,
    })

    markPromptDiagnosticsFirstResponse(id, 2500)
    finishPromptDiagnostics(id, {
      input_tokens: 300,
      output_tokens: 40,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 1000,
    }, 5000)

    const [record] = getPromptDiagnosticsRecords()
    expect(record.requestId).toBe(id)
    expect(record.status).toBe('success')
    expect(record.timing.ttfbMs).toBe(1500)
    expect(record.timing.totalMs).toBe(4000)
    expect(record.usage?.cacheReadInputTokens).toBe(1000)
    expect(record.payload.cacheControl.systemContext).toBe(true)
    expect(record.payload.hashes.systemPrompt).toHaveLength(12)
    expect(JSON.stringify(record)).not.toContain('system prompt secret body')
    expect(record.diagnosis).toContain('reasoning effort is high')
    expect(record.diagnosis).toContain('extended thinking is forced on')
  })

  it('isolates records per conversation so a busy chat cannot evict another chat', () => {
    for (let i = 0; i < 25; i++) {
      startPromptDiagnostics({
        conversationId: 'busy',
        providerId: 'anthropic',
        model: 'm',
        iteration: i,
        systemPrompt: '',
        apiMessages: [],
        toolTokens: 0,
        now: 1000 + i,
      })
    }
    const quietId = startPromptDiagnostics({
      conversationId: 'quiet',
      providerId: 'anthropic',
      model: 'm',
      iteration: 1,
      systemPrompt: '',
      apiMessages: [],
      toolTokens: 0,
      now: 2000,
    })

    const quietRecords = getPromptDiagnosticsRecords(10, 'quiet')
    expect(quietRecords).toHaveLength(1)
    expect(quietRecords[0].requestId).toBe(quietId)

    const busyRecords = getPromptDiagnosticsRecords(50, 'busy')
    expect(busyRecords).toHaveLength(20)
  })

  it('marks failed requests and keeps newest records first', () => {
    const a = startPromptDiagnostics({
      providerId: 'anthropic',
      model: 'm',
      iteration: 1,
      systemPrompt: '',
      apiMessages: [],
      toolTokens: 0,
      now: 1,
    })
    const b = startPromptDiagnostics({
      providerId: 'anthropic',
      model: 'm',
      iteration: 2,
      systemPrompt: '',
      apiMessages: [],
      toolTokens: 0,
      now: 2,
    })
    failPromptDiagnostics(a, new Error('boom'), 5)

    const records = getPromptDiagnosticsRecords()
    expect(records.map((r) => r.requestId)).toEqual([b, a])
    expect(records[1].status).toBe('error')
    expect(records[1].error).toBe('boom')
  })
})
