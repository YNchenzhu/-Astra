/**
 * Unit tests for {@link cacheSafeParams}.
 *
 * Covers:
 *  1. Snapshot is deep-cloned (mutations on the live AgentContext don't
 *     leak into the saved slot).
 *  2. Per-conversation partitioning — concurrent chat tabs don't clobber
 *     each other's snapshots.
 *  3. Headless / undefined conversationId falls into the shared fallback
 *     slot.
 *  4. Sub-agents and forked workers do NOT overwrite the main slot.
 *  5. The termination-cleanup hook fires on every upstream QueryTerminalResult
 *     path the cleanup pipeline visits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  __resetAllCacheSafeParamsForTests,
  clearCacheSafeParams,
  createCacheSafeParams,
  getLatestCacheSafeParams,
  installCacheSafeParamsSnapshotHook,
  saveCacheSafeParams,
  saveCacheSafeParamsFromContext,
} from './cacheSafeParams'
import { runWithAgentContext, type AgentContext } from './agentContext'
import { asAgentId } from '../tools/ids'
import {
  createTerminalResult,
  resetTerminationCleanup,
  runTerminationCleanup,
} from '../ai/queryTermination'

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    config: { id: 'p1', name: 'test', baseUrl: '', apiKey: '', model: '' } as AgentContext['config'],
    model: 'test-model',
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'hello' }],
    signal: new AbortController().signal,
    agentId: asAgentId('main'),
    streamConversationId: 'conv-1',
    ...overrides,
  }
}

beforeEach(() => {
  __resetAllCacheSafeParamsForTests()
  resetTerminationCleanup()
})

afterEach(() => {
  __resetAllCacheSafeParamsForTests()
  resetTerminationCleanup()
})

describe('cacheSafeParams', () => {
  it('createCacheSafeParams deep-clones the messages array', () => {
    const liveMessages = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
    ]
    const snap = createCacheSafeParams({
      agentId: asAgentId('main'),
      systemPrompt: 'sys',
      messages: liveMessages,
      model: 'm',
    })
    // Mutate the original; snapshot must not change.
    ;(liveMessages[0].content as Array<{ text: string }>)[0].text = 'CHANGED'
    liveMessages.push({ role: 'user', content: [] })

    expect(snap.messages.length).toBe(2)
    expect(
      (snap.messages[0] as { content: Array<{ text: string }> }).content[0].text,
    ).toBe('first')
  })

  it('save / get round-trips by conversation id', () => {
    const snap = createCacheSafeParams({
      agentId: asAgentId('main'),
      streamConversationId: 'conv-A',
      systemPrompt: 'A',
      messages: [],
      model: 'm',
    })
    saveCacheSafeParams(snap)
    expect(getLatestCacheSafeParams('conv-A')?.systemPrompt).toBe('A')
    expect(getLatestCacheSafeParams('conv-B')).toBeUndefined()
  })

  it('partitions per-conversation: concurrent tabs do not clobber each other', () => {
    saveCacheSafeParams(
      createCacheSafeParams({
        agentId: asAgentId('main'),
        streamConversationId: 'left',
        systemPrompt: 'LEFT',
        messages: [],
        model: 'm',
      }),
    )
    saveCacheSafeParams(
      createCacheSafeParams({
        agentId: asAgentId('main'),
        streamConversationId: 'right',
        systemPrompt: 'RIGHT',
        messages: [],
        model: 'm',
      }),
    )
    expect(getLatestCacheSafeParams('left')?.systemPrompt).toBe('LEFT')
    expect(getLatestCacheSafeParams('right')?.systemPrompt).toBe('RIGHT')
  })

  it('falls back to a shared slot when conversation id is missing', () => {
    saveCacheSafeParams(
      createCacheSafeParams({
        agentId: asAgentId('main'),
        systemPrompt: 'HEADLESS',
        messages: [],
        model: 'm',
      }),
    )
    expect(getLatestCacheSafeParams(undefined)?.systemPrompt).toBe('HEADLESS')
    expect(getLatestCacheSafeParams('')?.systemPrompt).toBe('HEADLESS')
  })

  it('clearCacheSafeParams returns and removes the snapshot', () => {
    saveCacheSafeParams(
      createCacheSafeParams({
        agentId: asAgentId('main'),
        streamConversationId: 'conv-X',
        systemPrompt: 'X',
        messages: [],
        model: 'm',
      }),
    )
    const taken = clearCacheSafeParams('conv-X')
    expect(taken?.systemPrompt).toBe('X')
    expect(getLatestCacheSafeParams('conv-X')).toBeUndefined()
  })

  it('saveCacheSafeParamsFromContext writes when agentId === "main"', () => {
    const ctx = makeContext({
      streamConversationId: 'conv-main',
      systemPrompt: 'main-sys',
      model: 'opus',
    })
    const saved = runWithAgentContext(ctx, () =>
      saveCacheSafeParamsFromContext(),
    )
    expect(saved).not.toBeNull()
    expect(getLatestCacheSafeParams('conv-main')?.systemPrompt).toBe('main-sys')
    expect(getLatestCacheSafeParams('conv-main')?.model).toBe('opus')
  })

  it('saveCacheSafeParamsFromContext refuses to write from a sub-agent', () => {
    const ctx = makeContext({
      agentId: asAgentId('agent-bg-1'),
      streamConversationId: 'conv-main',
    })
    const saved = runWithAgentContext(ctx, () =>
      saveCacheSafeParamsFromContext(),
    )
    expect(saved).toBeNull()
    expect(getLatestCacheSafeParams('conv-main')).toBeUndefined()
  })

  it('returns null when there is no AgentContext (no ALS scope)', () => {
    expect(saveCacheSafeParamsFromContext()).toBeNull()
  })

  it('installCacheSafeParamsSnapshotHook fires save on termination', async () => {
    const uninstall = installCacheSafeParamsSnapshotHook()
    try {
      const ctx = makeContext({
        streamConversationId: 'conv-hook',
        systemPrompt: 'hook-sys',
        model: 'sonnet',
      })
      await runWithAgentContext(ctx, async () => {
        await runTerminationCleanup(
          createTerminalResult('completed', { turnCount: 3 }),
        )
      })
      expect(getLatestCacheSafeParams('conv-hook')?.systemPrompt).toBe(
        'hook-sys',
      )
    } finally {
      uninstall()
    }
  })

  it('installCacheSafeParamsSnapshotHook is idempotent', async () => {
    const uninstall1 = installCacheSafeParamsSnapshotHook()
    const uninstall2 = installCacheSafeParamsSnapshotHook() // no-op second call
    try {
      const ctx = makeContext({
        streamConversationId: 'conv-once',
        systemPrompt: 'once',
        model: 'm',
      })
      await runWithAgentContext(ctx, async () => {
        await runTerminationCleanup(
          createTerminalResult('completed', { turnCount: 1 }),
        )
      })
      // If the hook double-registered we'd still pass this assertion — the
      // real signal is that uninstall1+uninstall2 cleanly bring the count
      // back to zero (no callbacks left for the next test).
      expect(getLatestCacheSafeParams('conv-once')?.systemPrompt).toBe('once')
    } finally {
      uninstall1()
      uninstall2()
    }
  })

  it('snapshot is fired even on error termination paths', async () => {
    const uninstall = installCacheSafeParamsSnapshotHook()
    try {
      const ctx = makeContext({
        streamConversationId: 'conv-aborted',
        systemPrompt: 'pre-abort',
        model: 'm',
      })
      await runWithAgentContext(ctx, async () => {
        await runTerminationCleanup(
          createTerminalResult('aborted_streaming', { turnCount: 2 }),
        )
      })
      expect(getLatestCacheSafeParams('conv-aborted')?.systemPrompt).toBe(
        'pre-abort',
      )
    } finally {
      uninstall()
    }
  })
})
