/**
 * Destructive test — SendMessage self-send guard (audit 2026-06).
 *
 * A confused model addressing its OWN agentId (or its own registered
 * NAME) previously enqueued the message into its own `pendingMessages`,
 * waking its own mailbox wait and re-entering the loop with its own
 * words as fresh input — an unbounded token-burning livelock. The
 * direct-active routing path must reject self-sends the same way the
 * NAME-fallback path rejects `self_lead`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const SELF_ID = 'researcher@alpha'

const selfAgent = {
  agentId: SELF_ID,
  agentType: 'general-purpose',
  name: 'researcher',
  teamName: 'alpha',
  status: 'running' as const,
  pendingMessages: [] as string[],
}

vi.mock('./agentContext', () => ({
  getAgentContext: vi.fn(() => ({ agentId: SELF_ID, teamId: 'alpha' })),
}))

vi.mock('../tools/workspaceState', () => ({
  getWorkspacePath: vi.fn(() => '/tmp/ws'),
}))

const enqueueMock = vi.fn(() => ({ ok: true, droppedOldest: false, pendingLength: 1 }))

vi.mock('./activeAgentRegistry', () => ({
  enqueueAgentMailboxMessage: (...args: unknown[]) => enqueueMock(...args),
  getActiveAgent: vi.fn((id: string) =>
    id === SELF_ID || id === 'researcher' ? selfAgent : undefined,
  ),
  getActiveAgents: vi.fn(() => new Map([[SELF_ID, selfAgent]])),
  lookupActiveAgent: vi.fn((id: string) =>
    id === SELF_ID || id === 'researcher'
      ? { kind: 'found' as const, agent: selfAgent }
      : { kind: 'not_found' as const },
  ),
}))

vi.mock('../tools/teamMailbox', () => ({
  appendTeamMailbox: vi.fn(async () => undefined),
}))

vi.mock('../tools/TeamCreateTool', () => ({
  broadcastTeamMessage: vi.fn(async () => ({ delivered: 0, recipientIds: [] })),
  formatTeamMailboxEnvelopeLine: vi.fn(() => '[t] ENVELOPE'),
  formatTeamMailboxLine: vi.fn(() => '[t] PLAIN'),
  getAllTeams: vi.fn(() => []),
}))

import { sendMessageTool } from './sendMessageTool'

describe('sendMessageTool — self-send guard (direct-active path)', () => {
  beforeEach(() => {
    enqueueMock.mockClear()
    selfAgent.pendingMessages = []
  })

  it('rejects sending to the caller own agentId', async () => {
    const r = await sendMessageTool.execute({ to: SELF_ID, message: 'hello me' })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/yourself|itself/i)
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('rejects sending to the caller own registered NAME', async () => {
    const r = await sendMessageTool.execute({ to: 'researcher', message: 'hello me' })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/yourself|itself/i)
    expect(enqueueMock).not.toHaveBeenCalled()
  })
})
