import { describe, expect, it, beforeEach } from 'vitest'
import {
  buildCacheKeyFactors,
  getConversationCacheBreakDetector,
  resetAllCacheBreakDetectorsForTests,
} from './promptCacheBreakDetection'
import { silenceExpectedConsoleWarn } from '../testHelpers/silenceExpectedConsole'

// Detector emits a console.warn each time a cache break is detected; that
// is the very behavior under test, asserted via the returned reason — the
// log line itself is just noise.
silenceExpectedConsoleWarn()

describe('prompt cache break detection', () => {
  beforeEach(() => {
    resetAllCacheBreakDetectorsForTests()
  })

  it('tracks cache break factors independently per conversation scope', () => {
    const mainFactors = buildCacheKeyFactors({
      systemPrompt: 'main prompt',
      toolSchemas: [{ name: 'read_file' }],
      model: 'qwen3.6-plus',
    })
    const memoryFactors = buildCacheKeyFactors({
      systemPrompt: 'memory prompt',
      toolSchemas: [{ name: 'write_file' }],
      model: 'qwen3.6-plus',
    })

    expect(getConversationCacheBreakDetector('conv-a', 'main').check(mainFactors)).toBeNull()
    expect(getConversationCacheBreakDetector('conv-a', 'agent:memory').check(memoryFactors)).toBeNull()

    const changedMain = buildCacheKeyFactors({
      systemPrompt: 'main prompt v2',
      toolSchemas: [{ name: 'read_file' }],
      model: 'qwen3.6-plus',
    })
    const event = getConversationCacheBreakDetector('conv-a', 'main').check(changedMain)

    expect(event?.changedFactors).toEqual(['systemPrompt'])
    expect(getConversationCacheBreakDetector('conv-a', 'agent:memory').getBreakCount()).toBe(0)
  })
})
