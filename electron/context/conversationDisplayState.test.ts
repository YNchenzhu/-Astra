/**
 * Additional adversarial tests for subtle issues.
 */
import { describe, it, expect } from 'vitest'
import { microCompact } from './compact'
import { ContextManager, DEFAULT_THRESHOLDS, contextManager } from './manager'
import { estimateMessageTokens } from './tokenCounter'
import {
  updateConversationContextDisplay,
  resetConversationContextDisplay,
  getConversationContextDisplayState,
  hasConversationContextDisplay,
} from './conversationDisplayState'

describe('microCompact — shallow copy deep analysis', () => {
  it('truncated messages share no references with original content blocks', () => {
    const originalBlock = { type: 'tool_result' as const, tool_use_id: 't1', content: 'x'.repeat(500) }
    const msgs = [
      { role: 'user', content: [originalBlock] },
    ]
    const result = microCompact(msgs, 0)
    // The truncated block should be a new object
    const resultBlock = (result[0].content as Array<Record<string, unknown>>)[0]
    expect(resultBlock).not.toBe(originalBlock)
    expect(resultBlock.content).toContain('truncated')
    expect(originalBlock.content).toBe('x'.repeat(500)) // original unchanged
  })

  it('non-truncated blocks in non-truncated groups ARE the same reference as in result', () => {
    // This is a design choice verification: blocks in recent iterations that are not truncated
    // are the same reference because map() returns the same block object
    const block1 = { type: 'tool_result' as const, tool_use_id: 't1', content: 'short' }
    const msgs = [
      { role: 'user', content: [block1] },
    ]
    const result = microCompact(msgs, 3) // keep all 3 recent iterations
    const resultBlock = (result[0].content as Array<Record<string, unknown>>)[0]
    // Same reference is fine since no truncation happened
    expect(resultBlock).toBe(block1)
    expect(resultBlock.content).toBe('short')
  })

  it('mixed: one truncated block + one non-truncated block in same message', () => {
    const blockShort = { type: 'tool_result' as const, tool_use_id: 't1', content: 'short' }
    const blockLong = { type: 'tool_result' as const, tool_use_id: 't2', content: 'x'.repeat(500) }
    const msgs = [
      { role: 'user', content: [blockShort, blockLong] },
    ]
    // keepRecentIterations=0 means this group is beyond threshold
    const result = microCompact(msgs, 0)
    const content = result[0].content as Array<Record<string, unknown>>
    // Short block should be unchanged (under 200 chars)
    expect(content[0].content).toBe('short')
    // Long block should be truncated
    expect(content[1].content).toContain('truncated')
  })
})

describe('microCompact — non-string tool_result content', () => {
  it('tool_result with array content (nested content blocks) is summarised (Bug 8 fix)', () => {
    // Before the Bug 8 fix, structured content-block arrays were skipped
    // entirely and grew unbounded in history. microCompact now collapses
    // them into a short descriptor string when the combined text payload
    // (or any image/document block) exceeds the small-result cap.
    const msgs = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: 'x'.repeat(500) },
              { type: 'image', source: { data: 'big' } },
            ],
          },
        ],
      },
    ]
    const result = microCompact(msgs, 0)
    const block = (result[0].content as Array<Record<string, unknown>>)[0]
    expect(typeof block.content).toBe('string')
    expect(block.content as string).toContain('truncated')
    expect(block.content as string).toContain('500 chars')
    expect(block.content as string).toContain('1 image')
  })

  it('tool_result with small array content is left intact', () => {
    // A structured result that's already small should not be rewritten.
    const msgs = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't2',
            content: [{ type: 'text', text: 'ok' }],
          },
        ],
      },
    ]
    const result = microCompact(msgs, 0)
    const block = (result[0].content as Array<Record<string, unknown>>)[0]
    expect(Array.isArray(block.content)).toBe(true)
  })
})

describe('ContextManager — threshold ordering validation', () => {
  it('inverted thresholds still evaluate correctly (uses >= checks)', () => {
    // If errorTokens < warningTokens, the >= cascade means the first match wins
    const cm = new ContextManager({
      warningTokens: 100_000,  // high
      errorTokens: 10_000,     // low (inverted!)
      microCompactTokens: 76_000,
      autoCompactTokens: 88_000,
      blockingTokens: 102_000,
    })
    // 20k tokens: total >= errorTokens(10k) but NOT >= warningTokens(100k)
    // The evaluate method checks blocking first, then auto, micro, error, warning
    // So it hits the error check at line: total >= errorTokens
    const msg = { role: 'user', content: 'x'.repeat(20_000 * 4) }
    const result = cm.evaluate([msg], '')
    // With inverted thresholds, it should match error level (10k)
    // But since the checks are: blocking -> auto_compact -> micro_compact -> error -> warning
    // 20k tokens: not >= 102k (blocking), not >= 88k (auto), not >= 76k (micro),
    // IS >= 10k (error) => level = 'error'
    expect(result.level).toBe('error')
  })

  it('NaN thresholds cause all checks to fail => level is ok', () => {
    const cm = new ContextManager({
      warningTokens: NaN,
      errorTokens: NaN,
      microCompactTokens: NaN,
      autoCompactTokens: NaN,
      blockingTokens: NaN,
    })
    const msg = { role: 'user', content: 'x'.repeat(1_000_000) }
    const result = cm.evaluate([msg], '')
    // NaN >= anything is false, so all checks fail
    expect(result.level).toBe('ok')
    expect(result.action).toBe('none')
  })
})

describe('autoCompact — conversation text building edge cases', () => {
  it('throws when tool_use input is circular (JSON.stringify in token estimate)', () => {
    const circularInput: Record<string, unknown> = { x: 1 }
    circularInput.self = circularInput
    const block = {
      type: 'tool_use' as const,
      id: 'u1',
      name: 'test_tool',
      input: circularInput,
    }
    expect(() => estimateMessageTokens({ role: 'user', content: [block] })).toThrow()
  })
})

describe('conversationDisplayState — manager cleanup', () => {
  it('evicts oldest conversations when exceeding MAX_MANAGERS (50)', () => {
    for (let i = 0; i < 100; i++) {
      updateConversationContextDisplay(`conv-${i}`, [{ role: 'user', content: 'test' }], '', 0)
    }

    for (let i = 0; i < 50; i++) {
      expect(hasConversationContextDisplay(`conv-${i}`)).toBe(false)
    }
    for (let i = 50; i < 100; i++) {
      expect(hasConversationContextDisplay(`conv-${i}`)).toBe(true)
      expect(getConversationContextDisplayState(`conv-${i}`)).toBeDefined()
    }

    resetConversationContextDisplay()
  })

  it('evaluateModel fills usagePercentOfWindow on display state', () => {
    resetConversationContextDisplay()
    updateConversationContextDisplay(
      'pct-win',
      [{ role: 'user', content: 'z'.repeat(80_000) }],
      '',
      0,
      undefined,
      'claude-sonnet-4-20250514',
    )
    const st = getConversationContextDisplayState('pct-win')
    expect(st.usagePercentOfWindow).toBeDefined()
    expect(st.usagePercentOfWindow!).toBeGreaterThan(1)
    resetConversationContextDisplay()
  })

  it('evaluateThresholds overrides global for this conversation header', () => {
    resetConversationContextDisplay()
    const prev = contextManager.getThresholds()
    contextManager.updateThresholds({ ...DEFAULT_THRESHOLDS, microCompactTokens: 900_000 })
    try {
      const override = {
        ...DEFAULT_THRESHOLDS,
        microCompactTokens: 1,
        autoCompactTokens: 500_000,
        blockingTokens: 600_000,
      }
      updateConversationContextDisplay(
        'oc-thresh',
        [{ role: 'user', content: 'hello'.repeat(200) }],
        '',
        0,
        override,
      )
      const st = getConversationContextDisplayState('oc-thresh')
      expect(st.level).toBe('micro_compact')
    } finally {
      contextManager.updateThresholds(prev)
      resetConversationContextDisplay()
    }
  })
})
