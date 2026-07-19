import { describe, it, expect, beforeEach } from 'vitest'
import type { ProviderConfig, ProviderId } from '../ai/client'
import { ContextManager, DEFAULT_THRESHOLDS, contextManager } from './manager'
import { silenceExpectedConsoleWarnAndError } from '../testHelpers/silenceExpectedConsole'

// Silences:
//   - `[ContextManager] Auto-compact failed:` (`console.error`) — emitted
//     when `streamText` throws because `brokenAutoCompactConfig` points at
//     an unknown provider id (the test for "fall back to micro on failure").
//   - `[ContextManager] Blocking threshold, forcing micro-compact`
//     (`console.warn`) — emitted by the blocking-threshold branch.
silenceExpectedConsoleWarnAndError()

/** Valid-shaped config for tests that only need `action === 'none'` or micro/block compaction. */
const stubProviderConfig: ProviderConfig = { id: 'anthropic', name: 'test-stub', apiKey: '' }

/**
 * `streamText` hits the default branch → `onError` → auto-compact throws, without network.
 * (A typed `{}` used to leave `id` undefined and accidentally do the same.)
 */
const brokenAutoCompactConfig: ProviderConfig = {
  id: '__test_unknown_provider__' as ProviderId,
  name: 'broken',
  apiKey: '',
}

describe('ContextManager', () => {
  let mgr: ContextManager

  beforeEach(() => {
    mgr = new ContextManager()
  })

  it('initializes with default thresholds and ok state', () => {
    const state = mgr.getState()
    expect(state.estimatedTokens).toBe(0)
    expect(state.level).toBe('ok')
    expect(state.compactCount).toBe(0)
    expect(state.consecutiveCompactFailures).toBe(0)
  })

  it('allows custom thresholds via constructor', () => {
    const custom = new ContextManager({ warningTokens: 1000 })
    expect(custom.getThresholds().warningTokens).toBe(1000)
    // other thresholds remain default
    expect(custom.getThresholds().errorTokens).toBe(DEFAULT_THRESHOLDS.errorTokens)
  })

  it('evaluate returns ok for small messages', () => {
    const result = mgr.evaluate(
      [{ role: 'user', content: 'Hello' }],
      'system'
    )
    expect(result.level).toBe('ok')
    expect(result.action).toBe('none')
    expect(mgr.getState().estimatedTokens).toBeGreaterThan(0)
  })

  it('evaluate transitions to warning level', () => {
    const bigContent = 'x'.repeat(DEFAULT_THRESHOLDS.warningTokens * 4 + 100)
    const result = mgr.evaluate(
      [{ role: 'user', content: bigContent }],
      ''
    )
    expect(result.level).toBe('warning')
    expect(result.action).toBe('none')
  })

  it('evaluate transitions to error level with soft_clear action (Bug 10 fix)', () => {
    const bigContent = 'x'.repeat(DEFAULT_THRESHOLDS.errorTokens * 4 + 100)
    const result = mgr.evaluate(
      [{ role: 'user', content: bigContent }],
      ''
    )
    expect(result.level).toBe('error')
    expect(result.action).toBe('soft_clear')
  })

  it('evaluate triggers micro_compact', () => {
    const bigContent = 'x'.repeat(DEFAULT_THRESHOLDS.microCompactTokens * 4 + 100)
    const result = mgr.evaluate(
      [{ role: 'user', content: bigContent }],
      ''
    )
    expect(result.level).toBe('micro_compact')
    expect(result.action).toBe('micro_compact')
  })

  it('evaluate triggers auto_compact when within limit', () => {
    const bigContent = 'x'.repeat(DEFAULT_THRESHOLDS.autoCompactTokens * 4 + 100)
    const result = mgr.evaluate(
      [{ role: 'user', content: bigContent }],
      ''
    )
    expect(result.level).toBe('auto_compact')
    expect(result.action).toBe('auto_compact')
  })

  it('evaluate triggers blocking', () => {
    const bigContent = 'x'.repeat(DEFAULT_THRESHOLDS.blockingTokens * 4 + 100)
    const result = mgr.evaluate(
      [{ role: 'user', content: bigContent }],
      ''
    )
    expect(result.level).toBe('blocking')
    expect(result.action).toBe('block')
  })

  it('evaluate accounts for toolTokens', () => {
    // Small messages but high toolTokens push level up
    const toolTokens = DEFAULT_THRESHOLDS.warningTokens + 100
    const result = mgr.evaluate(
      [{ role: 'user', content: 'Hi' }],
      '',
      toolTokens
    )
    expect(result.level).toBe('warning')
  })

  it('getState returns a copy', () => {
    const s1 = mgr.getState()
    s1.estimatedTokens = 9999
    const s2 = mgr.getState()
    expect(s2.estimatedTokens).toBe(0)
  })

  it('getThresholds returns a copy', () => {
    const t1 = mgr.getThresholds()
    t1.warningTokens = 1
    const t2 = mgr.getThresholds()
    expect(t2.warningTokens).toBe(DEFAULT_THRESHOLDS.warningTokens)
  })

  it('updateThresholds merges partial', () => {
    mgr.updateThresholds({ warningTokens: 42 })
    expect(mgr.getThresholds().warningTokens).toBe(42)
    expect(mgr.getThresholds().errorTokens).toBe(DEFAULT_THRESHOLDS.errorTokens)
  })

  it('updateThresholds rejects anchorBudgetChars below 500', () => {
    mgr.updateThresholds({ anchorBudgetChars: 100 })
    expect(mgr.getThresholds().anchorBudgetChars).toBe(DEFAULT_THRESHOLDS.anchorBudgetChars)
  })

  it('updateThresholds allows valid anchorBudgetChars', () => {
    mgr.updateThresholds({ anchorBudgetChars: 1000 })
    expect(mgr.getThresholds().anchorBudgetChars).toBe(1000)
  })

  it('reset clears state', () => {
    mgr.evaluate([{ role: 'user', content: 'x'.repeat(DEFAULT_THRESHOLDS.warningTokens * 4) }], '')
    expect(mgr.getState().level).not.toBe('ok')
    mgr.reset()
    expect(mgr.getState().estimatedTokens).toBe(0)
    expect(mgr.getState().level).toBe('ok')
    expect(mgr.getState().compactCount).toBe(0)
  })

  it('handleContext returns messages unchanged for action none', async () => {
    const msgs = [{ role: 'user', content: 'Hi' }]
    const result = await mgr.handleContext(msgs, '', {
      config: stubProviderConfig,
      model: 'test',
      systemPrompt: '',
      messages: msgs,
      signal: new AbortController().signal,
    })
    expect(result.wasCompacted).toBe(false)
    expect(result.messages).toBe(msgs)
  })

  it('handleContext performs micro_compact', async () => {
    // Create messages with tool results
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(300), tool_use_id: 't1' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'y'.repeat(300), tool_use_id: 't2' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'z'.repeat(300), tool_use_id: 't3' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'w'.repeat(300), tool_use_id: 't4' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'a'.repeat(300), tool_use_id: 't5' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'b'.repeat(300), tool_use_id: 't6' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'c'.repeat(300), tool_use_id: 't7' }] },
    ]
    // Force micro_compact by using low threshold
    const localMgr = new ContextManager({ microCompactTokens: 100 })
    const result = await localMgr.handleContext(msgs, '', {
      config: stubProviderConfig,
      model: 'test',
      systemPrompt: '',
      messages: msgs,
      signal: new AbortController().signal,
    })
    expect(result.wasCompacted).toBe(true)
    // Oldest tool results should be truncated. NB: result.messages[0] is now
    // the audit-fix A-1 side-channel marker, so locate the first message
    // whose content is an array containing a tool_result.
    const firstWithToolResults = result.messages.find((m: Record<string, unknown>) =>
      Array.isArray(m.content) &&
      (m.content as Array<Record<string, unknown>>).some((b) => b.type === 'tool_result'),
    )
    if (!firstWithToolResults) throw new Error('expected a tool_result-bearing message in compacted output')
    const blocks = firstWithToolResults.content as Array<Record<string, unknown>>
    const tr = blocks.find((b) => b.type === 'tool_result')
    if (!tr) throw new Error('expected tool_result block in compacted message')
    expect(typeof tr.content).toBe('string')
    expect(tr.content as string).toContain('truncated')
  })

  it('handleContext auto_compact falls back to micro on failure', async () => {
    // Heuristic ~4 chars/token → 40+ chars crosses micro/auto thresholds of 10
    const msgs = [{ role: 'user', content: 'x'.repeat(48) }]
    // Use threshold that triggers auto_compact but provide broken config
    const localMgr = new ContextManager({ autoCompactTokens: 10, microCompactTokens: 10 })
    // autoCompact calls streamText with broken provider → onError → micro fallback
    const result = await localMgr.handleContext(msgs, '', {
      config: brokenAutoCompactConfig,
      model: 'test',
      systemPrompt: '',
      messages: msgs,
      signal: new AbortController().signal,
    })
    expect(result.wasCompacted).toBe(true)
    expect(localMgr.getState().consecutiveCompactFailures).toBe(1)
  })

  it('shouldAttemptAutoCompact blocks after 3 consecutive failures', async () => {
    const localMgr = new ContextManager({ autoCompactTokens: 10, microCompactTokens: 10 })
    const enough = [{ role: 'user', content: 'x'.repeat(48) }] as const
    // Simulate 3 failures
    for (let i = 0; i < 3; i++) {
      await localMgr.handleContext([...enough], '', {
        config: brokenAutoCompactConfig,
        model: 'test',
        systemPrompt: '',
        messages: [],
        signal: new AbortController().signal,
      })
    }
    expect(localMgr.getState().consecutiveCompactFailures).toBe(3)
    // Next auto_compact should be skipped, level should still be micro_compact or error
    const result = localMgr.evaluate([{ role: 'user', content: 'x'.repeat(50) }], '')
    // With 3 failures, auto_compact is blocked, so it falls through to micro_compact
    expect(result.action).toBe('micro_compact')
  })

  it('blocking forces micro_compact with keepRecentIterations=1', async () => {
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', content: 'a'.repeat(300), tool_use_id: 't1' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'b'.repeat(300), tool_use_id: 't2' }] },
      { role: 'user', content: 'final message' },
    ]
    const localMgr = new ContextManager({ blockingTokens: 10, autoCompactTokens: 10, microCompactTokens: 10 })
    const result = await localMgr.handleContext(msgs, '', {
      config: stubProviderConfig,
      model: 'test',
      systemPrompt: '',
      messages: msgs,
      signal: new AbortController().signal,
    })
    expect(result.wasCompacted).toBe(true)
  })

  it('singleton contextManager is properly initialized', () => {
    expect(contextManager.getState().level).toBe('ok')
    expect(contextManager.getThresholds()).toEqual(DEFAULT_THRESHOLDS)
  })
})
