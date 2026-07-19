import { describe, it, expect, vi } from 'vitest'
import { logAnalyzeContextDevLine } from './analyzeContextDev'

describe('analyzeContextDev', () => {
  it('no-ops when POLE_ANALYZE_CONTEXT_DEV is unset', () => {
    const prev = process.env.POLE_ANALYZE_CONTEXT_DEV
    delete process.env.POLE_ANALYZE_CONTEXT_DEV
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logAnalyzeContextDevLine({
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'hi' }],
      toolDefsTokens: 1,
    })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    if (prev === undefined) delete process.env.POLE_ANALYZE_CONTEXT_DEV
    else process.env.POLE_ANALYZE_CONTEXT_DEV = prev
  })
})
