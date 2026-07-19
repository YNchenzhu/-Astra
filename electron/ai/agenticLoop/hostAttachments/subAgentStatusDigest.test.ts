/**
 * Unit tests for the `sub_agent_status_digest` collector.
 *
 * Surfaces a snapshot of currently-running and recently-failed sub-agents.
 * Distinct from `subAgentOutputs` (which delivers terminal content one-shot).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subAgentStatusDigestCollector } from './subAgentStatusDigest'
import {
  expectPushMessageAction,
  makeAttachmentFixture,
} from './testFixtures'

const ORIGINAL_ENV = process.env.POLE_SUB_AGENT_STATUS_DIGEST

const getAgentContextMock = vi.fn()
const getActiveAgentsMock = vi.fn(
  () => new Map<string, Record<string, unknown>>(),
)

vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))
vi.mock('../../../agents/activeAgentRegistry', () => ({
  getActiveAgents: () => getActiveAgentsMock(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.POLE_SUB_AGENT_STATUS_DIGEST = '1'
  getAgentContextMock.mockReturnValue({ agentId: 'main' })
})

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.POLE_SUB_AGENT_STATUS_DIGEST
  else process.env.POLE_SUB_AGENT_STATUS_DIGEST = ORIGINAL_ENV
})

function makeAgent(
  id: string,
  agentType: string,
  status: 'running' | 'completed' | 'failed' | 'killed',
  extra?: { name?: string; description?: string },
): Record<string, unknown> {
  return {
    agentId: id,
    agentType,
    status,
    name: extra?.name,
    description: extra?.description ?? `${agentType} working on stuff`,
    pendingMessages: [],
    messages: [],
  }
}

describe('subAgentStatusDigestCollector — callSite + env gate', () => {
  it('runs at post_tool and no_tools_continue', () => {
    expect(subAgentStatusDigestCollector.callSites).toEqual(['post_tool', 'no_tools_continue'])
  })

  it('is enabled when env flag is unset (default-on)', async () => {
    delete process.env.POLE_SUB_AGENT_STATUS_DIGEST
    // Empty registry → no emit, but the registry was consulted.
    expect(
      await subAgentStatusDigestCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    expect(getActiveAgentsMock).toHaveBeenCalled()
  })

  it('returns null when env flag is explicitly disabled (POLE_X=0)', async () => {
    process.env.POLE_SUB_AGENT_STATUS_DIGEST = '0'
    expect(
      await subAgentStatusDigestCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    expect(getActiveAgentsMock).not.toHaveBeenCalled()
  })

  it('returns null for sub-agents (main chat only)', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'sub-1' })
    getActiveAgentsMock.mockReturnValue(
      new Map([['sub-1', makeAgent('sub-1', 'Explore', 'running')]]),
    )
    expect(
      await subAgentStatusDigestCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })
})

describe('subAgentStatusDigestCollector — content gating', () => {
  it('returns null when no active agents', async () => {
    getActiveAgentsMock.mockReturnValue(new Map())
    expect(
      await subAgentStatusDigestCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when all agents are in non-interesting terminal states', async () => {
    getActiveAgentsMock.mockReturnValue(
      new Map([
        ['a', makeAgent('a', 'Explore', 'completed')],
        ['b', makeAgent('b', 'Plan', 'killed')],
      ]),
    )
    expect(
      await subAgentStatusDigestCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('lists running agents with the H4 audit-fix marker on the first body line', async () => {
    getActiveAgentsMock.mockReturnValue(
      new Map([
        [
          'a',
          makeAgent('a', 'Explore', 'running', {
            name: 'CodeSearch',
            description: 'searching for usages',
          }),
        ],
      ]),
    )
    const ctx = makeAttachmentFixture({})
    const action = await subAgentStatusDigestCollector.run(ctx)
    const pushed = expectPushMessageAction(action)
    const body = String(pushed.message.content)
    expect(body).toContain('running')
    expect(body).toContain('CodeSearch')
    expect(body).toContain('Explore')
    // Audit fix R2-M4 — stable bracket marker on the first body line
    // and "NOT your own work" framing so the model treats this as
    // background, not first-person working memory.
    expect(body).toMatch(/\[Sub-agent status snapshot/)
    expect(body).toMatch(/NOT your own work/i)
  })

  it('lists failed agents with `unacknowledged` tag in totals', async () => {
    getActiveAgentsMock.mockReturnValue(
      new Map([['a', makeAgent('a', 'Plan', 'failed')]]),
    )
    const action = await subAgentStatusDigestCollector.run(
      makeAttachmentFixture({}),
    )
    const body = String(expectPushMessageAction(action).message.content)
    expect(body).toContain('failed')
    expect(body).toContain('unacknowledged')
  })

  it('caps listed agents and reports overflow', async () => {
    const big = new Map<string, Record<string, unknown>>()
    for (let i = 0; i < 25; i++) {
      big.set(`a-${i}`, makeAgent(`a-${i}`, 'Explore', 'running'))
    }
    getActiveAgentsMock.mockReturnValue(big)
    const action = await subAgentStatusDigestCollector.run(
      makeAttachmentFixture({}),
    )
    const body = String(expectPushMessageAction(action).message.content)
    expect(body).toContain('… (+5 more)')
  })
})
