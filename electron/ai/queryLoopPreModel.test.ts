import { afterEach, describe, expect, it } from 'vitest'
import { ContextManager } from '../context/manager'
import { appendContextCollapseSummary, clearContextCollapseStoreForTests } from '../context/contextCollapseStore'
import { runQueryLoopPreModelSteps } from './queryLoopPreModel'

describe('runQueryLoopPreModelSteps (§6.1 pre-model chain)', () => {
  afterEach(() => {
    clearContextCollapseStoreForTests()
  })
  it('always applies tool_result_budget then evaluates context (none for small transcript)', async () => {
    const mgr = new ContextManager({
      microCompactTokens: 500_000,
      autoCompactTokens: 600_000,
    })
    const messages = [{ role: 'user', content: 'hi' }]
    const out = await runQueryLoopPreModelSteps({
      apiMessages: messages,
      systemPrompt: 'sys',
      toolDefsTokens: 0,
      loopContextManager: mgr,
      compactOptions: {
        config: { id: 'anthropic', name: 'x', apiKey: '' },
        model: 'm',
        systemPrompt: 'sys',
        messages,
        signal: new AbortController().signal,
      },
      thresholds: mgr.getThresholds(),
    })
    expect(out.phases[0]).toBe('tool_result_budget')
    expect(out.phases.includes('idle_tool_clear')).toBe(false)
    expect(out.phases.includes('context_manager_none')).toBe(true)
    expect(out.snippedCount).toBe(0)
    expect(out.wasContextManaged).toBe(false)
  })

  it('runs micro_compact before model when over micro threshold (no LLM auto)', async () => {
    const mgr = new ContextManager({
      warningTokens: 40,
      errorTokens: 60,
      microCompactTokens: 80,
      autoCompactTokens: 50_000,
      blockingTokens: 60_000,
    })
    const messages = [{ role: 'user', content: 'x'.repeat(500) }]
    const out = await runQueryLoopPreModelSteps({
      apiMessages: messages,
      systemPrompt: '',
      toolDefsTokens: 0,
      loopContextManager: mgr,
      compactOptions: {
        config: { id: 'anthropic', name: 'x', apiKey: '' },
        model: 'm',
        systemPrompt: '',
        messages,
        signal: new AbortController().signal,
      },
      thresholds: mgr.getThresholds(),
    })
    expect(out.phases).toContain('tool_result_budget')
    expect(out.phases).toContain('micro_compact')
    expect(out.wasContextManaged).toBe(true)
  })

  it('records idle_tool_clear before tool_result_budget when flagged', async () => {
    const mgr = new ContextManager({
      microCompactTokens: 500_000,
      autoCompactTokens: 600_000,
    })
    const messages = [{ role: 'user', content: 'hi' }]
    const out = await runQueryLoopPreModelSteps({
      apiMessages: messages,
      systemPrompt: '',
      toolDefsTokens: 0,
      loopContextManager: mgr,
      compactOptions: {
        config: { id: 'anthropic', name: 'x', apiKey: '' },
        model: 'm',
        systemPrompt: '',
        messages,
        signal: new AbortController().signal,
      },
      thresholds: mgr.getThresholds(),
      idleToolClearApplied: true,
    })
    expect(out.phases[0]).toBe('idle_tool_clear')
    expect(out.phases[1]).toBe('tool_result_budget')
  })

  it('drains context collapse queue at §6.3 threshold when summaries exist (override for small transcript)', async () => {
    appendContextCollapseSummary('ws::cid', 'folded segment A')
    const mgr = new ContextManager({
      microCompactTokens: 500_000,
      autoCompactTokens: 600_000,
    })
    const messages = [{ role: 'user', content: 'hello' }]
    const out = await runQueryLoopPreModelSteps({
      apiMessages: messages,
      systemPrompt: 'sys',
      toolDefsTokens: 0,
      loopContextManager: mgr,
      compactOptions: {
        config: { id: 'anthropic', name: 'x', apiKey: '' },
        model: 'claude-sonnet-4',
        systemPrompt: 'sys',
        messages,
        signal: new AbortController().signal,
        collapseConversationKey: 'ws::cid',
      },
      thresholds: mgr.getThresholds(),
      contextCollapseTokenThresholdOverride: 1,
    })
    expect(out.phases).toContain('context_collapse_drain')
    // The deferred-tool pool announcement (`pole-dtd` marker, see
    // `toolPoolTranscriptDeltas.ts`) may add one extra side-channel user
    // message when the registry carries undiscovered deferred tools — true
    // since the Office families went `shouldDefer` (2026-06 tool-surface
    // slimming). Count it explicitly instead of pinning a fixed length so
    // this test stays about the collapse drain, not the pool delta.
    const poolDeltaCount = out.messages.filter((m) =>
      String((m as { content?: unknown }).content ?? '').includes('pole-dtd'),
    ).length
    expect(out.messages.length).toBe(messages.length + 1 + poolDeltaCount)
    const first = out.messages[0] as { role?: string; content?: string }
    expect(first.role).toBe('user')
    expect(String(first.content)).toContain('Context collapse summaries')
  })
})
