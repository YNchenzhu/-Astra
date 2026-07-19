/**
 * Unit tests for the `token_usage` collector.
 *
 * Math contract: derives `total` from `(estimatedTokens * 100 / usagePct)`.
 * Skips when either input is missing / zero.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetTokenUsageThrottleForTests,
  tokenUsageCollector,
} from './tokenUsage'
import {
  expectPushMessageAction,
  makeAttachmentFixture,
} from './testFixtures'

const ORIGINAL_ENV = process.env.POLE_TOKEN_USAGE_ATTACHMENT

const getAgentContextMock = vi.fn()
vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.POLE_TOKEN_USAGE_ATTACHMENT = '1'
  getAgentContextMock.mockReturnValue({ agentId: 'main' })
  // Audit fix R4-L4 — clear the per-conversation delta throttle so
  // tests don't pollute each other's first-emission state.
  __resetTokenUsageThrottleForTests()
})

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.POLE_TOKEN_USAGE_ATTACHMENT
  else process.env.POLE_TOKEN_USAGE_ATTACHMENT = ORIGINAL_ENV
})

describe('tokenUsageCollector — callSite + env gate', () => {
  it('runs at post_tool only', () => {
    expect(tokenUsageCollector.callSites).toEqual(['post_tool'])
  })

  it('is enabled when env flag is unset (default-on)', async () => {
    delete process.env.POLE_TOKEN_USAGE_ATTACHMENT
    const ctx = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 50_000, usagePercentOfWindow: 25 },
    })
    const result = await tokenUsageCollector.run(ctx)
    expect(result).not.toBeNull()
  })

  it('returns null when env flag is explicitly disabled (POLE_X=0)', async () => {
    process.env.POLE_TOKEN_USAGE_ATTACHMENT = '0'
    const ctx = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 50_000, usagePercentOfWindow: 25 },
    })
    expect(await tokenUsageCollector.run(ctx)).toBeNull()
  })

  it('returns null for sub-agents', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'sub-1' })
    const ctx = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 50_000, usagePercentOfWindow: 25 },
    })
    expect(await tokenUsageCollector.run(ctx)).toBeNull()
  })
})

describe('tokenUsageCollector — input gating', () => {
  it('returns null when estimatedTokens is 0', async () => {
    const ctx = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 0, usagePercentOfWindow: 25 },
    })
    expect(await tokenUsageCollector.run(ctx)).toBeNull()
  })

  it('returns null when usagePercentOfWindow is 0', async () => {
    const ctx = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 50_000, usagePercentOfWindow: 0 },
    })
    expect(await tokenUsageCollector.run(ctx)).toBeNull()
  })

  it('returns null when usagePercentOfWindow is undefined', async () => {
    const ctx = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 50_000 },
    })
    expect(await tokenUsageCollector.run(ctx)).toBeNull()
  })
})

describe('tokenUsageCollector — math', () => {
  it('derives total correctly (50k at 25% → 200k total, 150k remaining)', async () => {
    const ctx = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 50_000, usagePercentOfWindow: 25 },
    })
    const body = String(
      expectPushMessageAction(
        await tokenUsageCollector.run(ctx),
      ).message.content,
    )
    expect(body).toContain('50000/200000')
    expect(body).toContain('150000 remaining')
  })

  it('handles edge case: used > total via clamping remaining to 0', async () => {
    // estimatedTokens=100 at 200% → total=50, remaining=max(0, 50-100)=0
    const ctx = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 100, usagePercentOfWindow: 200 },
    })
    const body = String(
      expectPushMessageAction(
        await tokenUsageCollector.run(ctx),
      ).message.content,
    )
    expect(body).toContain('0 remaining')
  })

  it('reports usage to appendixReport', async () => {
    const ctx = makeAttachmentFixture({
      iteration: 3,
      ctxManagerState: { estimatedTokens: 10_000, usagePercentOfWindow: 10 },
    })
    await tokenUsageCollector.run(ctx)
    expect(ctx.state.appendixReport).toHaveBeenCalledWith(
      'P2_Q_compaction_reminder',
      expect.objectContaining({
        kind: 'token_usage',
        used: 10_000,
        total: 100_000,
        remaining: 90_000,
      }),
    )
  })

  // Audit fix R4-L4 — per-conversation delta throttle.
  it('R4-L4: skips second emission when usagePct hasn\'t moved by ≥5% (with conversationId)', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv-delta',
    })
    const ctx1 = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 50_000, usagePercentOfWindow: 25 },
    })
    expect(await tokenUsageCollector.run(ctx1)).not.toBeNull()
    // 26% is +1% from 25% — under the 5% threshold, must skip.
    const ctx2 = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 52_000, usagePercentOfWindow: 26 },
    })
    expect(await tokenUsageCollector.run(ctx2)).toBeNull()
  })

  it('R4-L4: emits again once usagePct moves by ≥5%', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv-delta-2',
    })
    const ctx1 = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 50_000, usagePercentOfWindow: 25 },
    })
    expect(await tokenUsageCollector.run(ctx1)).not.toBeNull()
    // 31% is +6% from 25% — crosses the threshold, must emit.
    const ctx2 = makeAttachmentFixture({
      ctxManagerState: { estimatedTokens: 62_000, usagePercentOfWindow: 31 },
    })
    expect(await tokenUsageCollector.run(ctx2)).not.toBeNull()
  })
})
