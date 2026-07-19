/**
 * Unit tests for the `agent_listing_delta` collector.
 *
 * Reads the agent definition revision counter to fast-path the
 * "nothing changed" case, then diffs the agent set against the
 * conversation's last-seen snapshot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetAgentListingSnapshotsForTests,
  agentListingDeltaCollector,
} from './agentListingDelta'
import {
  expectPushMessageAction,
  makeAttachmentFixture,
} from './testFixtures'

const ORIGINAL_ENV = process.env.POLE_AGENT_LISTING_DELTA

const getAgentContextMock = vi.fn()
const getBuiltInAgentsMock = vi.fn()
const getAgentDefinitionRevisionMock = vi.fn()

vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))
vi.mock('../../../agents/builtInAgents', () => ({
  getBuiltInAgents: () => getBuiltInAgentsMock(),
}))
vi.mock('../../../agents/agentRegistryRevision', () => ({
  getAgentDefinitionRevision: () => getAgentDefinitionRevisionMock(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  __resetAgentListingSnapshotsForTests()
  process.env.POLE_AGENT_LISTING_DELTA = '1'
  getAgentContextMock.mockReturnValue({ streamConversationId: 'conv-1' })
  getAgentDefinitionRevisionMock.mockReturnValue(1)
})

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.POLE_AGENT_LISTING_DELTA
  else process.env.POLE_AGENT_LISTING_DELTA = ORIGINAL_ENV
})

function agent(type: string, whenToUse?: string) {
  return {
    agentType: type,
    whenToUse: whenToUse ?? `use ${type} for ${type}`,
  }
}

describe('agentListingDeltaCollector — gating', () => {
  it('runs at post_tool only', () => {
    expect(agentListingDeltaCollector.callSites).toEqual(['post_tool'])
  })

  it('is enabled when env flag is unset (default-on)', async () => {
    delete process.env.POLE_AGENT_LISTING_DELTA
    // Empty agent list → no emit, but the gate didn't close it.
    getBuiltInAgentsMock.mockReturnValue([])
    expect(
      await agentListingDeltaCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    // Sanity: the agent-listing path was reached.
    expect(getBuiltInAgentsMock).toHaveBeenCalled()
  })

  it('returns null when env flag is explicitly disabled (POLE_X=0)', async () => {
    process.env.POLE_AGENT_LISTING_DELTA = '0'
    expect(
      await agentListingDeltaCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    expect(getBuiltInAgentsMock).not.toHaveBeenCalled()
  })

  it('returns null when no conversation id', async () => {
    getAgentContextMock.mockReturnValue(null)
    expect(
      await agentListingDeltaCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when revision unchanged vs last snapshot (fast path)', async () => {
    getBuiltInAgentsMock.mockReturnValue([agent('Explore'), agent('Plan')])
    // First call — fully surfaces as added, advances snapshot to revision=1
    await agentListingDeltaCollector.run(makeAttachmentFixture({}))
    // Second call with same revision — fast path no-op.
    expect(
      await agentListingDeltaCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })
})

describe('agentListingDeltaCollector — diff emission', () => {
  // Audit fix R2-M6 — the very first observation per conversation
  // returns null (the system prompt already lists every available
  // agent; emitting them all as "newly available" would duplicate
  // that list and frame it as a directive). Only subsequent revision
  // changes surface as deltas.
  it('first call returns null (audit R2-M6: suppress first-turn duplication of system prompt list)', async () => {
    getBuiltInAgentsMock.mockReturnValue([
      agent('Explore', 'investigate code'),
      agent('Plan', 'design implementation'),
    ])
    const action = await agentListingDeltaCollector.run(
      makeAttachmentFixture({}),
    )
    expect(action).toBeNull()
  })

  it('surfaces added + removed when revision bumps after first observation', async () => {
    // Snapshot iter 1: Explore + Plan. (no emission — first observation)
    getBuiltInAgentsMock.mockReturnValue([agent('Explore'), agent('Plan')])
    await agentListingDeltaCollector.run(makeAttachmentFixture({}))
    // Iter 2: Plan removed, Debug added — revision bumps.
    getAgentDefinitionRevisionMock.mockReturnValue(2)
    getBuiltInAgentsMock.mockReturnValue([agent('Explore'), agent('Debug')])
    const action = await agentListingDeltaCollector.run(
      makeAttachmentFixture({}),
    )
    const body = String(expectPushMessageAction(action).message.content)
    expect(body).toContain('Debug')
    expect(body).toContain('no longer available')
    expect(body).toContain('Plan')
    // Audit fix R2-M6 — stable marker + informational framing.
    expect(body).toContain('[Agent registry updated]')
    expect(body).toMatch(/informational; invoke only if relevant/)
  })

  it('no-op when revision bumps but the agent SET is identical', async () => {
    getBuiltInAgentsMock.mockReturnValue([agent('Explore')])
    await agentListingDeltaCollector.run(makeAttachmentFixture({}))
    // Spurious revision bump (e.g. plugin registered then unregistered same agent).
    getAgentDefinitionRevisionMock.mockReturnValue(2)
    expect(
      await agentListingDeltaCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('isolates snapshots per conversation (first observation per conv is silent)', async () => {
    getBuiltInAgentsMock.mockReturnValue([agent('Explore')])
    getAgentContextMock.mockReturnValue({ streamConversationId: 'conv-A' })
    expect(
      await agentListingDeltaCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    // conv-B has never been observed — first observation is also silent.
    getAgentContextMock.mockReturnValue({ streamConversationId: 'conv-B' })
    expect(
      await agentListingDeltaCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('R2-M6 — emits after first observation when the SECOND turn brings a new agent', async () => {
    getBuiltInAgentsMock.mockReturnValue([agent('Explore')])
    // Turn 1: silent snapshot.
    expect(
      await agentListingDeltaCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    // Turn 2: plugin registers a new agent type, revision bumps.
    getAgentDefinitionRevisionMock.mockReturnValue(2)
    getBuiltInAgentsMock.mockReturnValue([
      agent('Explore'),
      agent('Debug', 'reproduce + diagnose failing tests'),
    ])
    const action = await agentListingDeltaCollector.run(
      makeAttachmentFixture({}),
    )
    const body = String(expectPushMessageAction(action).message.content)
    expect(body).toContain('Debug')
    expect(body).toContain('reproduce + diagnose failing tests')
    expect(body).toContain('[Agent registry updated]')
  })
})
