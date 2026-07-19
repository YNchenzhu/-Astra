import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setWorkspacePath } from '../tools/workspaceState'
import { clearAllLocks } from '../tools/fileLock'
import {
  clearTeams,
  loadTeamFile,
  persistTeamFile,
  type Team,
} from '../tools/TeamCreateTool'
import {
  registerActiveAgent,
  unregisterActiveAgent,
} from './activeAgentRegistry'
import { asAgentId } from '../tools/ids'
import type { ActiveAgent } from './types'
import { consumeShutdownResponses } from './teamShutdownResponseHandler'
import {
  TEAM_INTER_AGENT_SCHEMA,
  stringifyTeamInterAgentMessage,
  type TeamInterAgentMessage,
} from './teamInterAgentProtocol'
import { formatTeamMailboxEnvelopeLine } from '../tools/TeamCreateTool'

const TEAM = 'shutdown-team'
const LEAD = 'team-lead@shutdown-team'
const WORKER = 'researcher@shutdown-team'

let workspaceRoot: string

function buildResponseLine(args: {
  approve: boolean
  fromAgentId: string
  requestId?: string
}): string {
  const proto: TeamInterAgentMessage = {
    schema: TEAM_INTER_AGENT_SCHEMA,
    kind: 'shutdown_response',
    requestId: args.requestId ?? 'r-1',
    approve: args.approve,
    from: { agentId: args.fromAgentId, agentType: 'researcher' },
  }
  return formatTeamMailboxEnvelopeLine({
    from: args.fromAgentId,
    to: LEAD,
    teamName: TEAM,
    type: 'shutdown_response',
    payload: stringifyTeamInterAgentMessage(proto),
  })
}

function buildIdleLine(fromAgentId: string): string {
  const proto: TeamInterAgentMessage = {
    schema: TEAM_INTER_AGENT_SCHEMA,
    kind: 'idle_notification',
    detail: 'turn_complete',
    from: { agentId: fromAgentId, agentType: 'researcher' },
  }
  return formatTeamMailboxEnvelopeLine({
    from: fromAgentId,
    to: LEAD,
    teamName: TEAM,
    type: 'idle_notification',
    payload: stringifyTeamInterAgentMessage(proto),
  })
}

function makeRunningAgent(): ActiveAgent {
  const a: Partial<ActiveAgent> = {
    agentId: asAgentId(WORKER),
    name: 'researcher',
    teamName: TEAM,
    status: 'running',
    pendingMessages: [],
    abortController: new AbortController(),
    startTime: Date.now(),
    description: 'stub',
    agentType: 'general-purpose',
    agentDef: { agentType: 'general-purpose' } as ActiveAgent['agentDef'],
    resolve: () => undefined,
  }
  return a as ActiveAgent
}

beforeEach(async () => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-shutdown-'))
  setWorkspacePath(workspaceRoot)
  clearTeams()
  const team: Team = {
    teamName: TEAM,
    leadAgentId: LEAD,
    members: [LEAD, WORKER],
    createdAt: Date.now(),
    mailbox: {},
  }
  await persistTeamFile(workspaceRoot, team)
})

afterEach(() => {
  clearAllLocks({ force: true })
  setWorkspacePath(null)
  clearTeams()
  try {
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('consumeShutdownResponses', () => {
  it('passes everything through when no shutdown_response is present', async () => {
    const lines = [buildIdleLine(WORKER)]
    const r = await consumeShutdownResponses({ teamName: TEAM, lines })
    expect(r.remaining).toEqual(lines)
    expect(r.approvedAgentIds).toEqual([])
    expect(r.removedAgentIds).toEqual([])
  })

  it('drops rejected shutdown_response from the digest but does not remove the member', async () => {
    const reject = buildResponseLine({ approve: false, fromAgentId: WORKER })
    const r = await consumeShutdownResponses({
      teamName: TEAM,
      lines: [reject],
    })
    expect(r.remaining).toHaveLength(0)
    expect(r.approvedAgentIds).toEqual([])
    expect(r.removedAgentIds).toEqual([])
    const team = loadTeamFile(workspaceRoot, TEAM)
    expect(team?.members.length).toBe(2)
  })

  it('aborts the live worker AND removes from TeamFile on approve', async () => {
    const ag = makeRunningAgent()
    expect(registerActiveAgent(ag).ok).toBe(true)
    const abortSpy = vi.spyOn(ag.abortController, 'abort')

    try {
      const approve = buildResponseLine({ approve: true, fromAgentId: WORKER })
      const r = await consumeShutdownResponses({
        teamName: TEAM,
        lines: [approve],
      })
      expect(r.remaining).toHaveLength(0)
      expect(r.approvedAgentIds).toEqual([WORKER])
      expect(r.removedAgentIds).toEqual([WORKER])
      expect(abortSpy).toHaveBeenCalledOnce()

      const team = loadTeamFile(workspaceRoot, TEAM)
      const memberIds = (team?.members ?? []).map((m) =>
        typeof m === 'string' ? m : m.agentId,
      )
      expect(memberIds).toEqual([LEAD])
    } finally {
      unregisterActiveAgent(asAgentId(WORKER))
    }
  })

  it('handles approve with missing sender as a noop (logged) and keeps the line dropped from digest', async () => {
    // Hand-craft a shutdown_response envelope with no `from` field to
    // simulate a pre-R2-M5 sender.
    const proto: TeamInterAgentMessage = {
      schema: TEAM_INTER_AGENT_SCHEMA,
      kind: 'shutdown_response',
      requestId: 'r-no-from',
      approve: true,
    }
    const line = `[${new Date().toISOString()}] ${JSON.stringify({
      // no `from` either
      to: LEAD,
      teamName: TEAM,
      type: 'shutdown_response',
      payload: stringifyTeamInterAgentMessage(proto),
    })}`
    const r = await consumeShutdownResponses({ teamName: TEAM, lines: [line] })
    expect(r.remaining).toHaveLength(0)
    expect(r.approvedAgentIds).toEqual([])
    expect(r.removedAgentIds).toEqual([])
  })

  it('partitions a mixed batch — passes idle through, processes approve', async () => {
    const ag = makeRunningAgent()
    expect(registerActiveAgent(ag).ok).toBe(true)
    try {
      const idle = buildIdleLine(WORKER)
      const approve = buildResponseLine({ approve: true, fromAgentId: WORKER })
      const lines = [idle, approve]
      const r = await consumeShutdownResponses({ teamName: TEAM, lines })
      expect(r.remaining).toEqual([idle])
      expect(r.approvedAgentIds).toEqual([WORKER])
    } finally {
      unregisterActiveAgent(asAgentId(WORKER))
    }
  })
})
