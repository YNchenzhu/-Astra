/**
 * Unit tests for the `mcp_instructions_delta` collector.
 *
 * The collector reads from `electron/mcp/instructionsTracker.ts`
 * (tested separately) and formats a delta message. These tests
 * mock the tracker to isolate collector formatting / gating logic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpInstructionsDeltaCollector } from './mcpInstructionsDelta'
import {
  expectPushMessageAction,
  makeAttachmentFixture,
} from './testFixtures'

const ORIGINAL_ENV = process.env.POLE_MCP_INSTRUCTIONS_DELTA

const getAgentContextMock = vi.fn()
const diffMock = vi.fn()

vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))
vi.mock('../../../mcp/instructionsTracker', () => ({
  diffMcpInstructionsForConversation: (cid: string) => diffMock(cid),
}))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.POLE_MCP_INSTRUCTIONS_DELTA = '1'
  getAgentContextMock.mockReturnValue({ streamConversationId: 'conv-1' })
})

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.POLE_MCP_INSTRUCTIONS_DELTA
  else process.env.POLE_MCP_INSTRUCTIONS_DELTA = ORIGINAL_ENV
})

describe('mcpInstructionsDeltaCollector — gating', () => {
  it('runs at post_tool only', () => {
    expect(mcpInstructionsDeltaCollector.callSites).toEqual(['post_tool'])
  })

  it('is enabled when env flag is unset (default-on)', async () => {
    delete process.env.POLE_MCP_INSTRUCTIONS_DELTA
    diffMock.mockReturnValue({ added: [], changed: [], removed: [] })
    // Returns null because the diff is empty, NOT because the gate
    // closed it. The collector ran (we know because the mock was hit).
    expect(
      await mcpInstructionsDeltaCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    expect(diffMock).toHaveBeenCalled()
  })

  it('returns null when env flag is explicitly disabled (POLE_X=0)', async () => {
    process.env.POLE_MCP_INSTRUCTIONS_DELTA = '0'
    expect(
      await mcpInstructionsDeltaCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    // Gate closes before the diff is consulted.
    expect(diffMock).not.toHaveBeenCalled()
  })

  it('returns null when no conversation id', async () => {
    getAgentContextMock.mockReturnValue(null)
    expect(
      await mcpInstructionsDeltaCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when delta is empty', async () => {
    diffMock.mockReturnValue({ added: [], changed: [], removed: [] })
    expect(
      await mcpInstructionsDeltaCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })
})

describe('mcpInstructionsDeltaCollector — formatting', () => {
  it('formats `added` section', async () => {
    diffMock.mockReturnValue({
      added: [{ name: 'alpha', instructions: 'do the alpha thing' }],
      changed: [],
      removed: [],
    })
    const action = await mcpInstructionsDeltaCollector.run(
      makeAttachmentFixture({}),
    )
    const body = String(expectPushMessageAction(action).message.content)
    expect(body).toContain('newly available')
    expect(body).toContain('alpha')
    expect(body).toContain('do the alpha thing')
  })

  it('formats `changed` section with the new instructions', async () => {
    diffMock.mockReturnValue({
      added: [],
      changed: [
        { name: 'beta', previous: 'v1 text', current: 'v2 text' },
      ],
      removed: [],
    })
    const body = String(
      expectPushMessageAction(
        await mcpInstructionsDeltaCollector.run(makeAttachmentFixture({})),
      ).message.content,
    )
    expect(body).toContain('updated instructions')
    expect(body).toContain('beta')
    expect(body).toContain('v2 text')
    // Previous text is NOT included (delta is forward-looking only).
    expect(body).not.toContain('v1 text')
  })

  it('formats `removed` section', async () => {
    diffMock.mockReturnValue({
      added: [],
      changed: [],
      removed: [{ name: 'gamma', previous: 'old' }],
    })
    const body = String(
      expectPushMessageAction(
        await mcpInstructionsDeltaCollector.run(makeAttachmentFixture({})),
      ).message.content,
    )
    expect(body).toContain('disconnected')
    expect(body).toContain('gamma')
  })

  it('clamps very long instructions strings', async () => {
    const huge = 'A'.repeat(2_000)
    diffMock.mockReturnValue({
      added: [{ name: 'big', instructions: huge }],
      changed: [],
      removed: [],
    })
    const body = String(
      expectPushMessageAction(
        await mcpInstructionsDeltaCollector.run(makeAttachmentFixture({})),
      ).message.content,
    )
    expect(body).toContain('truncated')
    expect(body.length).toBeLessThan(huge.length + 500)
  })

  it('combines added + changed + removed into one body', async () => {
    diffMock.mockReturnValue({
      added: [{ name: 'a', instructions: 'instr-a' }],
      changed: [{ name: 'b', previous: 'old', current: 'new' }],
      removed: [{ name: 'c', previous: 'old' }],
    })
    const body = String(
      expectPushMessageAction(
        await mcpInstructionsDeltaCollector.run(makeAttachmentFixture({})),
      ).message.content,
    )
    expect(body).toContain('newly available')
    expect(body).toContain('updated instructions')
    expect(body).toContain('disconnected')
  })

  it('reports counts to appendixReport', async () => {
    diffMock.mockReturnValue({
      added: [{ name: 'a', instructions: 'x' }],
      changed: [{ name: 'b', previous: 'x', current: 'y' }],
      removed: [{ name: 'c', previous: 'z' }],
    })
    const ctx = makeAttachmentFixture({ iteration: 4 })
    await mcpInstructionsDeltaCollector.run(ctx)
    expect(ctx.state.appendixReport).toHaveBeenCalledWith(
      'P2_Q_compaction_reminder',
      expect.objectContaining({
        kind: 'mcp_instructions_delta',
        added: 1,
        changed: 1,
        removed: 1,
      }),
    )
  })
})
