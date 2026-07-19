import { describe, expect, it } from 'vitest'
import {
  buildTeamPermissionResponsePayload,
  resolveTeamLeaderPermissionResponse,
  tryResolveTeamPermissionFromProtocolMessage,
} from './teamPermissionLeaderBridge'
import { TEAM_INTER_AGENT_SCHEMA, parseTeamInterAgentLine } from './teamInterAgentProtocol'
import { formatTeamMailboxEnvelopeLine } from '../tools/TeamCreateTool'

describe('teamPermissionLeaderBridge (§7.9)', () => {
  it('resolveTeamLeaderPermissionResponse is false for unknown id', () => {
    expect(
      resolveTeamLeaderPermissionResponse({
        teamRequestId: 'tperm-missing',
        behavior: 'allow',
      }),
    ).toBe(false)
  })

  it('tryResolveTeamPermissionFromProtocolMessage returns false when no waiter', () => {
    const msg = {
      schema: TEAM_INTER_AGENT_SCHEMA,
      kind: 'permission_response' as const,
      requestId: 'tperm-nobody',
      approve: true,
    }
    expect(tryResolveTeamPermissionFromProtocolMessage(msg)).toBe(false)
  })

  it('parses permission_response from mailbox envelope line', () => {
    const inner = buildTeamPermissionResponsePayload({
      teamRequestId: 'tperm-1',
      approve: true,
      updatedInput: { x: 1 },
    })
    const line = formatTeamMailboxEnvelopeLine({
      from: 'lead',
      to: 'worker',
      teamName: 'T',
      type: 'task',
      payload: inner,
    })
    const p = parseTeamInterAgentLine(line)
    expect(p?.kind).toBe('permission_response')
    expect(p?.requestId).toBe('tperm-1')
    expect(p?.approve).toBe(true)
  })
})
