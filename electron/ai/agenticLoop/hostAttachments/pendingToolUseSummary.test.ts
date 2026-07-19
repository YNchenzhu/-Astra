/**
 * Unit tests for the `pending_tool_use_summary` collector.
 *
 * Iteration-top consumer of the haiku-generated previous-turn summary.
 * Critical: takes the promise OUT of state BEFORE awaiting so a
 * timeout / rejection cannot result in double-consumption.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pendingToolUseSummaryCollector } from './pendingToolUseSummary'
import {
  expectPushMessageAction,
  makeAttachmentFixture,
} from './testFixtures'
import { SIDE_CHANNEL_KIND } from '../../../constants/sideChannelKinds'

const formatMock = vi.fn()
vi.mock('../../toolUseSummary', () => ({
  formatToolUseSummaryForInjection: (s: unknown, p: unknown) => formatMock(s, p),
}))

beforeEach(() => {
  vi.clearAllMocks()
  formatMock.mockImplementation((s: { summary?: string }) => s?.summary ?? '')
})

describe('pendingToolUseSummaryCollector — callSite', () => {
  it('runs at iteration_top only', () => {
    expect(pendingToolUseSummaryCollector.callSites).toEqual(['iteration_top'])
  })
})

describe('pendingToolUseSummaryCollector — gating', () => {
  it('returns null when state.pendingToolUseSummary is missing', async () => {
    const ctx = makeAttachmentFixture({})
    expect(await pendingToolUseSummaryCollector.run(ctx)).toBeNull()
  })

  it('returns null when promise resolves to null', async () => {
    const ctx = makeAttachmentFixture({
      stateOverrides: { pendingToolUseSummary: Promise.resolve(null) },
    })
    expect(await pendingToolUseSummaryCollector.run(ctx)).toBeNull()
    // Cleared either way.
    expect(ctx.state.pendingToolUseSummary).toBeNull()
  })

  it('returns null when formatted summary is empty / whitespace', async () => {
    formatMock.mockReturnValue('   ')
    const ctx = makeAttachmentFixture({
      stateOverrides: {
        pendingToolUseSummary: Promise.resolve({ summary: 'x', toolNames: [] }),
      },
    })
    expect(await pendingToolUseSummaryCollector.run(ctx)).toBeNull()
  })
})

describe('pendingToolUseSummaryCollector — emission', () => {
  // Audit fix R4-L7 (2026-05): emit as a standalone side-channel
  // user message instead of `concat_to_last_user`. The previous mode
  // appended the haiku recap to the END of the last user message,
  // which at iteration_top is often the human's actual prompt text
  // — making the model read the host recap as if the human typed it.
  it('R4-L7: emits push_message wrapped as toolUseSummary side-channel kind', async () => {
    formatMock.mockReturnValue('PREVIOUS BATCH: Read x; Bash y')
    const ctx = makeAttachmentFixture({
      stateOverrides: {
        pendingToolUseSummary: Promise.resolve({
          summary: 'irrelevant — format mock returns the test text',
          toolNames: ['Read', 'Bash'],
        }),
      },
    })
    const action = await pendingToolUseSummaryCollector.run(ctx)
    const pushed = expectPushMessageAction(action)
    expect(pushed.sideChannelKind).toBe(SIDE_CHANNEL_KIND.toolUseSummary)
    expect(pushed.message.role).toBe('user')
    expect(pushed.message._convertedFromSystem).toBe(true)
    expect(pushed.message._sideChannelKind).toBe(SIDE_CHANNEL_KIND.toolUseSummary)
    expect(String(pushed.message.content)).toContain('PREVIOUS BATCH')
    expect(formatMock).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.any(String) }),
      'anthropic',
    )
  })
})

describe('pendingToolUseSummaryCollector — double-consumption safety', () => {
  it('clears state.pendingToolUseSummary BEFORE awaiting (no leak on resolve)', async () => {
    let observedDuringAwait: unknown
    const ctx = makeAttachmentFixture({
      stateOverrides: {
        pendingToolUseSummary: new Promise((resolve) => {
          // Capture state mid-await.
          setTimeout(() => {
            observedDuringAwait = ctx.state.pendingToolUseSummary
            resolve({ summary: 'x', toolNames: [] })
          }, 0)
        }),
      },
    })
    await pendingToolUseSummaryCollector.run(ctx)
    expect(observedDuringAwait).toBeNull()
    expect(ctx.state.pendingToolUseSummary).toBeNull()
  })

  it('clears state even when the promise rejects', async () => {
    const ctx = makeAttachmentFixture({
      stateOverrides: {
        pendingToolUseSummary: Promise.reject(new Error('haiku failed')),
      },
    })
    const result = await pendingToolUseSummaryCollector.run(ctx)
    expect(result).toBeNull()
    expect(ctx.state.pendingToolUseSummary).toBeNull()
  })

  it('clears state when the 2s timeout race wins (slow haiku)', async () => {
    vi.useFakeTimers()
    try {
      const ctx = makeAttachmentFixture({
        stateOverrides: {
          // Never-resolving promise — timeout must win.
          pendingToolUseSummary: new Promise(() => {}),
        },
      })
      const pending = pendingToolUseSummaryCollector.run(ctx)
      await vi.advanceTimersByTimeAsync(2001)
      const result = await pending
      expect(result).toBeNull()
      expect(ctx.state.pendingToolUseSummary).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
