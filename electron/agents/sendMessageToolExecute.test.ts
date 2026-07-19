/**
 * Tests for sendMessageTool.execute — focused on the typed-handoff path
 * introduced by the inter-agent schema registry. We intentionally exercise
 * only the validation slice (which short-circuits BEFORE any routing /
 * registry / workspace lookup) so the test surface stays small.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./agentContext', () => ({
  getAgentContext: vi.fn(() => ({ agentId: 'sender-1', teamId: 'T' })),
}))

vi.mock('../tools/workspaceState', () => ({
  getWorkspacePath: vi.fn(() => '/tmp/ws'),
}))

vi.mock('./activeAgentRegistry', () => ({
  enqueueAgentMailboxMessage: vi.fn(() => ({ ok: true, droppedOldest: false, pendingLength: 1 })),
  getActiveAgent: vi.fn(() => undefined),
  getActiveAgents: vi.fn(() => new Map()),
  lookupActiveAgent: vi.fn(() => ({ kind: 'not_found' as const })),
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
import {
  TEAM_INTER_AGENT_SCHEMA,
  clearInterAgentSchemasForTests,
  registerInterAgentSchema,
} from './teamInterAgentProtocol'
import { z } from 'zod'

describe('sendMessageTool — typed handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    clearInterAgentSchemasForTests()
  })

  it('rejects when the named schema is not registered', async () => {
    const r = await sendMessageTool.execute({
      to: 'worker-1',
      message: '{"schema":"openclaude.team.v1","kind":"plan_approval_response","requestId":"x","approve":true}',
      schema: 'totally_made_up_schema',
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Unknown inter-agent schema/i)
    expect(r.error).toContain('Registered:')
  })

  it('rejects when message body is not valid JSON', async () => {
    const r = await sendMessageTool.execute({
      to: 'worker-1',
      message: 'not-json-at-all',
      schema: 'plan_approval_response',
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/requires a JSON message body/i)
  })

  it('rejects when JSON body fails the registered Zod schema', async () => {
    const body = JSON.stringify({
      schema: TEAM_INTER_AGENT_SCHEMA,
      kind: 'plan_approval_response',
      // requestId missing — schema requires it
      approve: true,
    })
    const r = await sendMessageTool.execute({
      to: 'worker-1',
      message: body,
      schema: 'plan_approval_response',
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Schema validation failed/i)
    expect(r.error).toContain('requestId')
  })

  it('passes validation and proceeds to routing when body conforms', async () => {
    const body = JSON.stringify({
      schema: TEAM_INTER_AGENT_SCHEMA,
      kind: 'plan_approval_response',
      requestId: 'req-1',
      approve: true,
    })
    const r = await sendMessageTool.execute({
      to: 'worker-1',
      message: body,
      schema: 'plan_approval_response',
    })
    // Validation passed, but the receiver agent is not registered (mocked
    // lookup returns 'not_found') → routing layer reports the agent error.
    // The important contract: we get PAST validation (no
    // "Schema validation failed" / "Unknown inter-agent schema") and into
    // the registry layer.
    expect(r.success).toBe(false)
    expect(r.error).not.toMatch(/Schema validation failed/i)
    expect(r.error).not.toMatch(/Unknown inter-agent schema/i)
    expect(r.error).toContain('No active agent')
  })

  it('respects custom schemas registered at runtime', async () => {
    registerInterAgentSchema(
      'my_handoff',
      z.object({
        schema: z.literal(TEAM_INTER_AGENT_SCHEMA),
        kind: z.literal('idle_notification'),
        ticketId: z.string().regex(/^TKT-\d+$/),
      }),
    )

    // Bad ticketId → custom schema rejects.
    const bad = await sendMessageTool.execute({
      to: 'worker-1',
      message: JSON.stringify({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'idle_notification',
        ticketId: 'NOT-A-TICKET',
      }),
      schema: 'my_handoff',
    })
    expect(bad.success).toBe(false)
    expect(bad.error).toMatch(/Schema validation failed/i)

    // Good ticketId → passes validation.
    const good = await sendMessageTool.execute({
      to: 'worker-1',
      message: JSON.stringify({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'idle_notification',
        ticketId: 'TKT-42',
      }),
      schema: 'my_handoff',
    })
    expect(good.error).not.toMatch(/Schema validation failed/i)
  })

  it('legacy free-form path is unchanged when schema is omitted', async () => {
    // No `schema` parameter — message body can be any string.
    const r = await sendMessageTool.execute({
      to: 'worker-1',
      message: 'just a plain string, not JSON',
    })
    // Same expectation as the success-validation case: routing fails, but
    // we never see a schema-related error.
    expect(r.success).toBe(false)
    expect(r.error).not.toMatch(/Schema validation failed/i)
    expect(r.error).not.toMatch(/Unknown inter-agent schema/i)
    expect(r.error).not.toMatch(/requires a JSON message body/i)
  })
})
