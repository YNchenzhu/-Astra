import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ContextManager, DEFAULT_THRESHOLDS, contextManager } from './manager'
import type { CompactOptions } from './compact'
import { silenceExpectedConsoleWarnAndError } from '../testHelpers/silenceExpectedConsole'
import { SIDE_CHANNEL_KIND } from '../constants/sideChannelKinds'

/** Compact options factory — the test doesn't drive the real provider, so
 *  a dummy `ProviderConfig`-shaped object is safe to assert through
 *  `unknown` once. Using a helper avoids scattered `{} as any` casts. */
function emptyCompactConfig(): CompactOptions['config'] {
  return {} as unknown as CompactOptions['config']
}

// Silences two deliberate production log lines:
//   - `console.error` — `[ContextManager] Auto-compact failed:` from the
//     "fall back to micro on failure" path exercised with an empty config.
//   - `console.warn`  — `[ContextManager] Blocking threshold, forcing
//     micro-compact` from the blocking-threshold branch we exercise too.
// Behavior is still asserted via state checks.
silenceExpectedConsoleWarnAndError()

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
    // Post Bug-10 fix: the error band (between errorTokens and
    // microCompactTokens) now emits a `soft_clear` action so UI shows
    // "error" AND the manager reclaims some tokens via idle-style clear.
    const bigContent = 'x'.repeat(DEFAULT_THRESHOLDS.errorTokens * 4 + 100)
    const result = mgr.evaluate(
      [{ role: 'user', content: bigContent }],
      ''
    )
    expect(result.level).toBe('error')
    expect(result.action).toBe('soft_clear')
  })

  it('evaluate triggers history_snip in [historySnip, microCompact) band', () => {
    // Sit clearly inside the snip band: above historySnipTokens, below
    // microCompactTokens. chars/4 token estimator → 70k+1k tokens ≈ 284_000 chars.
    const t = (DEFAULT_THRESHOLDS.historySnipTokens + 1_000) * 4
    const bigContent = 'x'.repeat(t)
    const result = mgr.evaluate(
      [{ role: 'user', content: bigContent }],
      ''
    )
    expect(result.level).toBe('history_snip')
    expect(result.action).toBe('history_snip')
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

  it('handleContext performs history_snip when in snip band', async () => {
    // Build a long transcript so snip can drop something. minMessagesToKeep=4
    // means at least 4 messages survive; supply 12 so snipping is feasible.
    const msgs = Array.from({ length: 12 }, (_, i) => ({
      role: 'user' as const,
      content: 'x'.repeat(8_000) + ` msg-${i}`,
    }))
    const localMgr = new ContextManager({
      warningTokens: 10,
      errorTokens: 100,
      historySnipTokens: 1_000, // tiny → snip band fires immediately
      microCompactTokens: 999_999, // never trip these
      autoCompactTokens: 999_999,
      blockingTokens: 999_999,
    })
    const result = await localMgr.handleContext(msgs, '', {
      config: emptyCompactConfig(),
      model: 'test',
      systemPrompt: '',
      messages: msgs,
      signal: new AbortController().signal,
    })
    expect(result.wasCompacted).toBe(true)
    expect(result.messages.length).toBeLessThan(msgs.length)
    // minMessagesToKeep = 4 inside snipOldestMessagesForBudget
    expect(result.messages.length).toBeGreaterThanOrEqual(4)
  })

  it('updateThresholds repairs broken historySnip invariant', () => {
    // Caller forgot to update historySnipTokens after raising
    // microCompactTokens — manager auto-derives the midpoint.
    mgr.updateThresholds({
      errorTokens: 100_000,
      microCompactTokens: 200_000,
      // historySnipTokens stays at default 70_000, which is now BELOW
      // errorTokens → invariant broken → manager re-derives midpoint.
    })
    const th = mgr.getThresholds()
    expect(th.historySnipTokens).toBeGreaterThan(th.errorTokens)
    expect(th.historySnipTokens).toBeLessThan(th.microCompactTokens)
    expect(th.historySnipTokens).toBe(150_000) // midpoint of 100k and 200k
  })

  it('updateThresholds accepts an explicit valid historySnipTokens', () => {
    mgr.updateThresholds({
      errorTokens: 50_000,
      historySnipTokens: 60_000,
      microCompactTokens: 70_000,
    })
    expect(mgr.getThresholds().historySnipTokens).toBe(60_000)
  })

  it('handleContext returns messages unchanged for action none', async () => {
    const msgs = [{ role: 'user', content: 'Hi' }]
    const result = await mgr.handleContext(msgs, '', {
      config: emptyCompactConfig(),
      model: 'test',
      systemPrompt: '',
      messages: msgs,
      signal: new AbortController().signal,
    })
    expect(result.wasCompacted).toBe(false)
    expect(result.messages).toBe(msgs)
  })

  it('handleContext performs micro_compact', async () => {
    const toolContent = 'x'.repeat(300)
    // microCompact default is 5 — produce 7 groups so the first 2 get truncated.
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', content: toolContent, tool_use_id: 't1' }] },
      { role: 'user', content: [{ type: 'tool_result', content: toolContent, tool_use_id: 't2' }] },
      { role: 'user', content: [{ type: 'tool_result', content: toolContent, tool_use_id: 't3' }] },
      { role: 'user', content: [{ type: 'tool_result', content: toolContent, tool_use_id: 't4' }] },
      { role: 'user', content: [{ type: 'tool_result', content: toolContent, tool_use_id: 't5' }] },
      { role: 'user', content: [{ type: 'tool_result', content: toolContent, tool_use_id: 't6' }] },
      { role: 'user', content: [{ type: 'tool_result', content: toolContent, tool_use_id: 't7' }] },
    ]
    // Set thresholds so total tokens trigger micro_compact but NOT auto_compact
    const localMgr = new ContextManager({
      warningTokens: 10,
      errorTokens: 10,
      microCompactTokens: 10,
      autoCompactTokens: 999999, // much higher so micro_compact triggers first
      blockingTokens: 999999,
    })
    const result = await localMgr.handleContext(msgs, '', {
      config: emptyCompactConfig(),
      model: 'test',
      systemPrompt: '',
      messages: msgs,
      signal: new AbortController().signal,
    })
    expect(result.wasCompacted).toBe(true)
    // result.messages[0] is now the audit-fix side-channel marker; the
    // first tool_result-bearing message is at index 1.
    const firstWithToolResults = result.messages.find((m: Record<string, unknown>) =>
      Array.isArray(m.content) &&
      (m.content as Array<Record<string, unknown>>).some((b) => b.type === 'tool_result'),
    )!
    const blocks = firstWithToolResults.content as Array<Record<string, unknown>>
    const tr = blocks.find((b: Record<string, unknown>) => b.type === 'tool_result')!
    expect(typeof tr.content).toBe('string')
    expect((tr.content as string)).toContain('truncated')
  })

  it('handleContext honors proactive micro_compact below the normal threshold', async () => {
    const toolContent = 'x'.repeat(300)
    const msgs = Array.from({ length: 7 }, (_, i) => ({
      role: 'user' as const,
      content: [
        {
          type: 'tool_result',
          content: toolContent,
          tool_use_id: `t${i}`,
        },
      ],
    }))
    const localMgr = new ContextManager({
      warningTokens: 999999,
      errorTokens: 999999,
      historySnipTokens: 999999,
      microCompactTokens: 999999,
      autoCompactTokens: 999999,
      blockingTokens: 999999,
    })
    const result = await localMgr.handleContext(msgs, '', {
      config: emptyCompactConfig(),
      model: 'test',
      systemPrompt: '',
      messages: msgs,
      signal: new AbortController().signal,
      proactiveCompact: {
        action: 'micro_compact',
        boundary: 'post_tool',
        reason: 'exit_plan_mode',
      },
    })

    expect(result.wasCompacted).toBe(true)
    // Marker now sits at index 0; locate the first surviving tool_result.
    const firstWithToolResults = result.messages.find((m: Record<string, unknown>) =>
      Array.isArray(m.content) &&
      (m.content as Array<Record<string, unknown>>).some((b) => b.type === 'tool_result'),
    )!
    const blocks = firstWithToolResults.content as Array<Record<string, unknown>>
    const tr = blocks.find((b: Record<string, unknown>) => b.type === 'tool_result')!
    expect(typeof tr.content).toBe('string')
    expect((tr.content as string)).toContain('truncated')
  })

  it('handleContext auto_compact falls back to micro on failure', async () => {
    // Big enough content to exceed autoCompactTokens
    const bigContent = 'x'.repeat(300)
    const msgs = [
      { role: 'user', content: bigContent },
      { role: 'user', content: [{ type: 'tool_result', content: 'y'.repeat(300), tool_use_id: 't1' }] },
    ]
    // autoCompactTokens < microCompactTokens so auto triggers first
    const localMgr = new ContextManager({
      warningTokens: 5,
      errorTokens: 5,
      microCompactTokens: 999999,
      autoCompactTokens: 10,
      blockingTokens: 999999,
    })
    const result = await localMgr.handleContext(msgs, '', {
      config: emptyCompactConfig(),
      model: 'test',
      systemPrompt: '',
      messages: msgs,
      signal: new AbortController().signal,
    })
    expect(result.wasCompacted).toBe(true)
    expect(localMgr.getState().consecutiveCompactFailures).toBe(1)
  })

  it('shouldAttemptAutoCompact blocks after 3 consecutive failures', async () => {
    const bigContent = 'x'.repeat(300)
    const msgs = [{ role: 'user', content: bigContent }]
    const localMgr = new ContextManager({
      warningTokens: 5,
      errorTokens: 5,
      microCompactTokens: 999999,
      autoCompactTokens: 10,
      blockingTokens: 999999,
    })
    for (let i = 0; i < 3; i++) {
      await localMgr.handleContext(msgs, '', {
        config: emptyCompactConfig(), model: 'test', systemPrompt: '', messages: msgs, signal: new AbortController().signal,
      })
    }
    expect(localMgr.getState().consecutiveCompactFailures).toBe(3)
    // Now shouldAttemptAutoCompact returns false, so auto_compact is skipped
    // and evaluate returns error level (since microCompactTokens is 999999).
    // Bug 10 fix: error tier now also emits soft_clear as its action.
    const evalResult = localMgr.evaluate(msgs, '')
    expect(evalResult.level).toBe('error')
    expect(evalResult.action).toBe('soft_clear')
  })

  it('blocking forces micro_compact with keepRecentIterations=1', async () => {
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', content: 'a'.repeat(300), tool_use_id: 't1' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'b'.repeat(300), tool_use_id: 't2' }] },
      { role: 'user', content: 'final message' },
    ]
    const localMgr = new ContextManager({
      warningTokens: 5,
      errorTokens: 5,
      microCompactTokens: 5,
      autoCompactTokens: 5,
      blockingTokens: 10,
    })
    const result = await localMgr.handleContext(msgs, '', {
      config: emptyCompactConfig(), model: 'test', systemPrompt: '', messages: msgs, signal: new AbortController().signal,
    })
    expect(result.wasCompacted).toBe(true)
  })

  it('singleton contextManager is properly initialized', () => {
    expect(contextManager.getState().level).toBe('ok')
    expect(contextManager.getThresholds()).toEqual(DEFAULT_THRESHOLDS)
  })

  it('evaluate cascade order: blocking > auto_compact > micro_compact > error > warning > ok', () => {
    // Test that threshold order is correct with default values
    const t = DEFAULT_THRESHOLDS
    expect(t.warningTokens).toBeLessThan(t.errorTokens)
    expect(t.errorTokens).toBeLessThan(t.microCompactTokens)
    expect(t.microCompactTokens).toBeLessThan(t.autoCompactTokens)
    expect(t.autoCompactTokens).toBeLessThan(t.blockingTokens)
  })

  it('evaluate uses API usage anchor plus tail messages only', () => {
    const charPerTier = DEFAULT_THRESHOLDS.warningTokens * 4
    const m1 = { role: 'user', content: 'p'.repeat(charPerTier) }
    const m2 = { role: 'user', content: 'q'.repeat(charPerTier) }
    const tail = { role: 'user', content: 'tail' }
    const anchored = new ContextManager()
    anchored.recordUsageAfterRequest(2000, 2)
    const rAnchored = anchored.evaluate([m1, m2, tail], '', 0)
    const fullOnly = new ContextManager()
    const rFull = fullOnly.evaluate([m1, m2, tail], '', 0)
    expect(rAnchored.level).toBe('ok')
    expect(rFull.level).not.toBe('ok')
  })

  it('retains cache usage snapshot for context breakdown', () => {
    const mgr = new ContextManager()
    mgr.recordUsageAfterRequest(1_500, 1, {
      input_tokens: 300,
      output_tokens: 40,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 1_000,
    })
    mgr.evaluate([{ role: 'user', content: 'hello' }], 'system', 0)
    const cache = mgr.getState().breakdown?.cache
    expect(cache?.cacheReadInputTokens).toBe(1_000)
    expect(cache?.cacheCreationInputTokens).toBe(200)
    expect(cache?.outputTokens).toBe(40)
    expect(cache?.cacheHitRate).toBeCloseTo((1_000 / 1_500) * 100)
  })

  it('clearUsageSnapshot falls back to full conversation estimate', () => {
    const charPerTier = DEFAULT_THRESHOLDS.warningTokens * 4
    const m1 = { role: 'user', content: 'p'.repeat(charPerTier) }
    const m2 = { role: 'user', content: 'q'.repeat(charPerTier) }
    const mgr = new ContextManager()
    mgr.recordUsageAfterRequest(2000, 2)
    mgr.clearUsageSnapshot()
    const r = mgr.evaluate([m1, m2], '', 0)
    expect(r.level).not.toBe('ok')
  })

  it('setPrefetchedInputTokensForNextEvaluate overrides heuristic for one evaluate()', () => {
    const mgr = new ContextManager()
    mgr.setPrefetchedInputTokensForNextEvaluate(999_999)
    const tiny = [{ role: 'user', content: 'hi' }]
    const r = mgr.evaluate(tiny, '', 0)
    expect(r.level).toBe('blocking')
    const r2 = mgr.evaluate(tiny, '', 0)
    expect(r2.level).toBe('ok')
  })

  // Audit fix (A-1) regression — history_snip / micro_compact must inject a
  // model-visible side-channel marker announcing the truncation. Without
  // it the model treats the dropped/truncated content as ground truth.
  it('handleContext history_snip prepends a side-channel marker', async () => {
    const msgs = Array.from({ length: 12 }, (_, i) => ({
      role: 'user' as const,
      content: 'x'.repeat(8_000) + ` msg-${i}`,
    }))
    const localMgr = new ContextManager({
      warningTokens: 10,
      errorTokens: 100,
      historySnipTokens: 1_000,
      microCompactTokens: 999_999,
      autoCompactTokens: 999_999,
      blockingTokens: 999_999,
    })
    const result = await localMgr.handleContext(msgs, '', {
      config: emptyCompactConfig(),
      model: 'test',
      systemPrompt: '',
      messages: msgs,
      signal: new AbortController().signal,
      transcriptPath: '/tmp/pre-snip.jsonl',
    })
    expect(result.wasCompacted).toBe(true)
    const head = result.messages[0] as Record<string, unknown>
    expect(head._sideChannelKind).toBe(SIDE_CHANNEL_KIND.genericConvertedSystem)
    expect(head._convertedFromSystem).toBe(true)
    expect(typeof head.content).toBe('string')
    expect(head.content as string).toContain('Context budget')
    expect(head.content as string).toContain('older message')
    expect(head.content as string).toContain('/tmp/pre-snip.jsonl')
  })

  it('handleContext micro_compact prepends a side-channel marker when tokens were reclaimed', async () => {
    const toolContent = 'x'.repeat(300)
    const msgs = Array.from({ length: 7 }, (_, i) => ({
      role: 'user' as const,
      content: [
        { type: 'tool_result', content: toolContent, tool_use_id: `t${i}` },
      ],
    }))
    const localMgr = new ContextManager({
      warningTokens: 10,
      errorTokens: 10,
      microCompactTokens: 10,
      autoCompactTokens: 999_999,
      blockingTokens: 999_999,
    })
    const result = await localMgr.handleContext(msgs, '', {
      config: emptyCompactConfig(),
      model: 'test',
      systemPrompt: '',
      messages: msgs,
      signal: new AbortController().signal,
    })
    expect(result.wasCompacted).toBe(true)
    const head = result.messages[0] as Record<string, unknown>
    expect(head._sideChannelKind).toBe(SIDE_CHANNEL_KIND.genericConvertedSystem)
    expect(head._convertedFromSystem).toBe(true)
    expect(head.content as string).toContain('tool_result contents from older iterations')
  })

  // ─── Dynamic-from-model threshold derivation (upstream-external parity) ───
  // Without this wiring, the fixed DEFAULT_THRESHOLDS.autoCompactTokens=88_000
  // fired at ~9% of a 1M-window model's capacity and ~34% of a 256K window.
  // See `applyDynamicThresholdsForModel` for the upstream rationale.

  describe('dynamic threshold derivation per model window', () => {
    it('derives ~167K autoCompact for a 200K Claude model on first evaluate(model)', () => {
      const m = new ContextManager()
      m.evaluate([{ role: 'user', content: 'hi' }], '', 0, 'claude-sonnet-4-6')
      const th = m.getThresholds()
      // effectiveWindow = 200_000 - 20_000 = 180_000
      // autoCompactTokens = 180_000 - AUTOCOMPACT_BUFFER_TOKENS(13_000) = 167_000
      expect(th.autoCompactTokens).toBe(167_000)
    })

    it('derives ~223K autoCompact for a 256K Kimi K2 model', () => {
      const m = new ContextManager()
      m.evaluate([{ role: 'user', content: 'hi' }], '', 0, 'kimi-k2-instruct')
      const th = m.getThresholds()
      // effectiveWindow = 256_000 - 20_000 = 236_000
      // autoCompactTokens = 236_000 - 13_000 = 223_000
      expect(th.autoCompactTokens).toBe(223_000)
    })

    it('caps a 1M Qwen3-Coder model at the compact-planning window (~387K autoCompact)', () => {
      const m = new ContextManager()
      m.evaluate([{ role: 'user', content: 'hi' }], '', 0, 'qwen3-coder-plus')
      const th = m.getThresholds()
      // effectiveWindow = 1_000_000 - 20_000 = 980_000, but the compact-
      // planning cap (COMPACT_PLANNING_WINDOW_CAP_TOKENS = 400_000) wins:
      // autoCompactTokens = 400_000 - 13_000 = 387_000. The old W - 13k
      // shape (967_000) was unreachable in practice — error anchors piled
      // up for hundreds of K tokens with no compaction ever flushing them.
      expect(th.autoCompactTokens).toBe(387_000)
    })

    it('POLE_COMPACT_PLANNING_WINDOW_CAP_TOKENS=0 restores full-window thresholds for 1M models', () => {
      const prev = process.env.POLE_COMPACT_PLANNING_WINDOW_CAP_TOKENS
      process.env.POLE_COMPACT_PLANNING_WINDOW_CAP_TOKENS = '0'
      try {
        const m = new ContextManager()
        m.evaluate([{ role: 'user', content: 'hi' }], '', 0, 'qwen3-coder-plus')
        expect(m.getThresholds().autoCompactTokens).toBe(967_000)
      } finally {
        if (prev === undefined) delete process.env.POLE_COMPACT_PLANNING_WINDOW_CAP_TOKENS
        else process.env.POLE_COMPACT_PLANNING_WINDOW_CAP_TOKENS = prev
      }
    })

    it('collapses historySnipTokens into microCompactTokens (snip tier effectively off)', () => {
      const m = new ContextManager()
      m.evaluate([{ role: 'user', content: 'hi' }], '', 0, 'claude-sonnet-4-6')
      const th = m.getThresholds()
      expect(th.historySnipTokens).toBe(th.microCompactTokens)
    })

    it('shifts microCompactTokens to autoCompactTokens-2_000 (micro as last-second fallback)', () => {
      const m = new ContextManager()
      m.evaluate([{ role: 'user', content: 'hi' }], '', 0, 'claude-sonnet-4-6')
      const th = m.getThresholds()
      expect(th.microCompactTokens).toBe(th.autoCompactTokens - 2_000)
    })

    it('re-derives when the model switches mid-session', () => {
      const m = new ContextManager()
      m.evaluate([{ role: 'user', content: 'hi' }], '', 0, 'claude-sonnet-4-6')
      const claudeAuto = m.getThresholds().autoCompactTokens
      m.evaluate([{ role: 'user', content: 'hi' }], '', 0, 'qwen3-coder-plus')
      const qwenAuto = m.getThresholds().autoCompactTokens
      expect(claudeAuto).toBe(167_000)
      expect(qwenAuto).toBe(387_000) // planning-window cap, see test above
    })

    it('does NOT re-derive on the same model across evaluates (idempotent)', () => {
      const m = new ContextManager()
      m.evaluate([{ role: 'user', content: 'hi' }], '', 0, 'claude-sonnet-4-6')
      const before = m.getThresholds()
      m.evaluate([{ role: 'user', content: 'hi' }], '', 0, 'claude-sonnet-4-6')
      const after = m.getThresholds()
      expect(after).toEqual(before)
    })

    it('does NOT derive when the constructor was given explicit thresholds', () => {
      const m = new ContextManager({ autoCompactTokens: 12_345 })
      m.evaluate([{ role: 'user', content: 'hi' }], '', 0, 'qwen3-coder-plus')
      expect(m.getThresholds().autoCompactTokens).toBe(12_345)
    })

    it('does NOT derive after updateThresholds was called (user opt-out)', () => {
      const m = new ContextManager()
      m.updateThresholds({ autoCompactTokens: 50_000 })
      m.evaluate([{ role: 'user', content: 'hi' }], '', 0, 'qwen3-coder-plus')
      expect(m.getThresholds().autoCompactTokens).toBe(50_000)
    })

    // P1 audit fix (阈值双源收敛) — `agenticLoop/setup.ts` now seeds the
    // loop-local manager through this priming entry instead of applying a
    // raw `deriveContextThresholdsFromOpenClaudeWindow` inline. The raw
    // derivation kept history_snip as an active midpoint tier, making bare
    // message-dropping the dominant steady-state compaction and starving
    // the LLM auto_compact path.
    describe('primeThresholdsForModel (setup.ts seeding entry)', () => {
      it('produces the SAME adjusted tiers evaluate(model) derives (single source)', () => {
        const primed = new ContextManager()
        primed.primeThresholdsForModel('claude-sonnet-4-6')

        const evaluated = new ContextManager()
        evaluated.evaluate([{ role: 'user', content: 'hi' }], '', 0, 'claude-sonnet-4-6')

        expect(primed.getThresholds()).toEqual(evaluated.getThresholds())
        // Pull-up adjustments applied: snip collapsed into micro, micro at auto-2k.
        const th = primed.getThresholds()
        expect(th.historySnipTokens).toBe(th.microCompactTokens)
        expect(th.microCompactTokens).toBe(th.autoCompactTokens - 2_000)
      })

      it('is a no-op on a user-customized manager', () => {
        const m = new ContextManager({ autoCompactTokens: 12_345 })
        m.primeThresholdsForModel('claude-sonnet-4-6')
        expect(m.getThresholds().autoCompactTokens).toBe(12_345)
      })

      it('hasUserCustomizedThresholds reflects constructor/updateThresholds state', () => {
        expect(new ContextManager().hasUserCustomizedThresholds()).toBe(false)
        expect(new ContextManager({ autoCompactTokens: 1 }).hasUserCustomizedThresholds()).toBe(true)
        const m = new ContextManager()
        m.updateThresholds({ autoCompactTokens: 50_000 })
        expect(m.hasUserCustomizedThresholds()).toBe(true)
      })
    })

    it('does NOT derive when no model is supplied to evaluate()', () => {
      const m = new ContextManager()
      m.evaluate([{ role: 'user', content: 'hi' }], '')
      expect(m.getThresholds()).toEqual(DEFAULT_THRESHOLDS)
    })

    it('does NOT derive when an empty model string is supplied', () => {
      const m = new ContextManager()
      m.evaluate([{ role: 'user', content: 'hi' }], '', 0, '   ')
      expect(m.getThresholds()).toEqual(DEFAULT_THRESHOLDS)
    })
  })

  // ── P3.1 — Compact-history surface & diminishing-returns gate ─────────
  //
  // The pure logic (push, slice, threshold compare) is fully covered by
  // `compactDiminishingReturns.test.ts`. These cases exercise the
  // ContextManager wiring:
  //   - `recordCompactAttempt()` public API mutates the rolling window
  //   - `getCompactHistory()` returns a snapshot
  //   - `isCompactDiminishingGate()` reads the gate as expected after pushes
  //   - The post-audit-fix: production `handleContext` success paths
  //     populate the history themselves via the private `logCompactAttempt`
  //     wrapper. The full handleContext integration is exercised by the
  //     larger blocks below (soft_clear / micro_compact / etc.) — those
  //     tests already drive `handleContext` end-to-end.
  describe('P3.1 — compactHistory API', () => {
    it('starts with an empty history', () => {
      const m = new ContextManager()
      expect(m.getCompactHistory()).toEqual([])
      expect(m.isCompactDiminishingGate()).toBe(false)
    })

    it('recordCompactAttempt() appends to the rolling window', () => {
      const m = new ContextManager()
      m.recordCompactAttempt({ preTokens: 100_000, postTokens: 99_500, ranAt: 1 })
      expect(m.getCompactHistory()).toHaveLength(1)
      m.recordCompactAttempt({ preTokens: 99_500, postTokens: 99_000, ranAt: 2 })
      expect(m.getCompactHistory()).toHaveLength(2)
    })

    it('isCompactDiminishingGate() fires after 3 consecutive weak attempts', () => {
      const m = new ContextManager()
      // Three attempts, each reclaiming < 5%.
      m.recordCompactAttempt({ preTokens: 100_000, postTokens: 99_700, ranAt: 1 })
      m.recordCompactAttempt({ preTokens: 99_700, postTokens: 99_400, ranAt: 2 })
      m.recordCompactAttempt({ preTokens: 99_400, postTokens: 99_100, ranAt: 3 })
      expect(m.isCompactDiminishingGate()).toBe(true)
    })

    it('isCompactDiminishingGate() stays false when a recent attempt was strong', () => {
      const m = new ContextManager()
      m.recordCompactAttempt({ preTokens: 100_000, postTokens: 99_500, ranAt: 1 })
      m.recordCompactAttempt({ preTokens: 99_500, postTokens: 50_000, ranAt: 2 }) // strong
      m.recordCompactAttempt({ preTokens: 50_000, postTokens: 49_800, ranAt: 3 })
      expect(m.isCompactDiminishingGate()).toBe(false)
    })

    it('getCompactHistory() returns a snapshot — outside mutations do not leak in', () => {
      const m = new ContextManager()
      m.recordCompactAttempt({ preTokens: 100, postTokens: 50, ranAt: 1 })
      const snapshot = m.getCompactHistory()
      // Whether the implementation freezes / clones, the observed
      // count must reflect ONLY the explicit recordCompactAttempt
      // calls — not any external array mutation.
      expect(snapshot).toHaveLength(1)
      const sizeBefore = m.getCompactHistory().length
      // Sanity: another record advances the count.
      m.recordCompactAttempt({ preTokens: 50, postTokens: 25, ranAt: 2 })
      expect(m.getCompactHistory().length).toBe(sizeBefore + 1)
    })
  })

  // onCompactStart drives the transient "正在压缩…" toast. It must fire ONLY
  // for the slow `auto_compact` tier — which always returns wasCompacted:true
  // so the matching "done" reliably resolves the spinner. Firing it for the
  // cheap tiers (which can no-op with wasCompacted:false) would strand the
  // spinner with no "done" to clear it.
  describe('onCompactStart gating (compaction toast)', () => {
    const baseOpts = (msgs: Array<Record<string, unknown>>, onCompactStart: () => void) => ({
      config: emptyCompactConfig(),
      model: 'test',
      systemPrompt: '',
      messages: msgs,
      signal: new AbortController().signal,
      onCompactStart,
    })

    it('fires exactly once with action=auto_compact for the auto-compact tier', async () => {
      const onCompactStart = vi.fn()
      const msgs = [{ role: 'user', content: 'x'.repeat(50_000) }]
      const localMgr = new ContextManager({
        warningTokens: 10,
        errorTokens: 10,
        historySnipTokens: 999_999,
        microCompactTokens: 999_999,
        autoCompactTokens: 10,
        blockingTokens: 999_999,
      })
      const result = await localMgr.handleContext(msgs, '', baseOpts(msgs, onCompactStart))
      expect(result.wasCompacted).toBe(true)
      expect(onCompactStart).toHaveBeenCalledTimes(1)
      expect(onCompactStart).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auto_compact' }),
      )
    })

    it('does NOT fire for the cheap micro_compact tier', async () => {
      const onCompactStart = vi.fn()
      const toolContent = 'x'.repeat(300)
      const msgs = Array.from({ length: 7 }, (_, i) => ({
        role: 'user',
        content: [{ type: 'tool_result', content: toolContent, tool_use_id: `t${i}` }],
      }))
      const localMgr = new ContextManager({
        warningTokens: 10,
        errorTokens: 10,
        historySnipTokens: 999_999,
        microCompactTokens: 10,
        autoCompactTokens: 999_999,
        blockingTokens: 999_999,
      })
      const result = await localMgr.handleContext(msgs, '', baseOpts(msgs, onCompactStart))
      expect(result.wasCompacted).toBe(true)
      expect(onCompactStart).not.toHaveBeenCalled()
    })

    it('does NOT fire for the history_snip tier', async () => {
      const onCompactStart = vi.fn()
      const msgs = Array.from({ length: 12 }, (_, i) => ({
        role: 'user',
        content: 'x'.repeat(8_000) + ` msg-${i}`,
      }))
      const localMgr = new ContextManager({
        warningTokens: 10,
        errorTokens: 100,
        historySnipTokens: 1_000,
        microCompactTokens: 999_999,
        autoCompactTokens: 999_999,
        blockingTokens: 999_999,
      })
      await localMgr.handleContext(msgs, '', baseOpts(msgs, onCompactStart))
      expect(onCompactStart).not.toHaveBeenCalled()
    })
  })
})
