/**
 * Tests for the per-loop hook-stop relay on AgentContext.
 *
 * Wiring under test:
 *   `runAgenticToolUseBody` (PreToolUse loop-stop request)
 *     → `setAgentContextPendingHookStop`
 *     → ALS storage on AgentContext
 *     → `consumeAgentContextPendingHookStop` (called from `runAgenticLoop`
 *       after `executeToolBatch` returns)
 *     → translated into `hook_stopped` termination.
 *
 * Pinning rules:
 *   - Outside an AgentContext run: setter / getter are no-ops (don't
 *     throw — graceful in unit-test contexts that didn't enter ALS).
 *   - First setter call wins (idempotent during a single batch).
 *   - Consumer drains the slot on read (one-shot semantic).
 */
import { describe, it, expect } from 'vitest'
import {
  consumeAgentContextPendingHookStop,
  runWithAgentContextAsync,
  setAgentContextPendingHookStop,
  type AgentContext,
} from './agentContext'
import { asAgentId } from '../tools/ids'

function makeCtx(): AgentContext {
  return {
    config: { id: 'mock', name: 'Mock', baseUrl: '', apiKey: '' } as unknown as AgentContext['config'],
    model: 'claude-test',
    systemPrompt: '',
    messages: [],
    signal: new AbortController().signal,
    agentId: asAgentId('main'),
  }
}

describe('AgentContext pendingHookStopRequest', () => {
  it('setter / consumer are no-ops outside an ALS run (graceful)', () => {
    setAgentContextPendingHookStop({ reason: 'no ctx', hookName: 'phantom' })
    expect(consumeAgentContextPendingHookStop()).toBeNull()
  })

  it('round-trips a hook stop request inside an ALS run', async () => {
    await runWithAgentContextAsync(makeCtx(), async () => {
      setAgentContextPendingHookStop({ reason: 'lint failed', hookName: 'eslint-pre' })
      const r = consumeAgentContextPendingHookStop()
      expect(r).toEqual({ reason: 'lint failed', hookName: 'eslint-pre' })
    })
  })

  it('consume drains the slot — second consume returns null', async () => {
    await runWithAgentContextAsync(makeCtx(), async () => {
      setAgentContextPendingHookStop({ reason: 'first', hookName: 'h' })
      expect(consumeAgentContextPendingHookStop()).not.toBeNull()
      expect(consumeAgentContextPendingHookStop()).toBeNull()
    })
  })

  it('first setter wins — subsequent setters in the same batch do not overwrite', async () => {
    await runWithAgentContextAsync(makeCtx(), async () => {
      setAgentContextPendingHookStop({ reason: 'original', hookName: 'first-hook' })
      setAgentContextPendingHookStop({ reason: 'overwrite attempt', hookName: 'second-hook' })
      const r = consumeAgentContextPendingHookStop()
      expect(r).toEqual({ reason: 'original', hookName: 'first-hook' })
    })
  })

  it('omits hookName when not provided (clean payload for telemetry)', async () => {
    await runWithAgentContextAsync(makeCtx(), async () => {
      setAgentContextPendingHookStop({ reason: 'no name' })
      const r = consumeAgentContextPendingHookStop()
      expect(r).toEqual({ reason: 'no name' })
      expect(r).not.toHaveProperty('hookName')
    })
  })

  it('separate ALS contexts do not share the pending slot', async () => {
    let inner: ReturnType<typeof consumeAgentContextPendingHookStop> = null
    await runWithAgentContextAsync(makeCtx(), async () => {
      setAgentContextPendingHookStop({ reason: 'ctxA' })
      // Nested run with a fresh context — must not see ctxA's pending stop.
      await runWithAgentContextAsync(makeCtx(), async () => {
        inner = consumeAgentContextPendingHookStop()
      })
      // Outer ctx still has ctxA's pending stop.
      expect(consumeAgentContextPendingHookStop()).toEqual({ reason: 'ctxA' })
    })
    expect(inner).toBeNull()
  })
})
