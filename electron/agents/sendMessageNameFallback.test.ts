import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearTeams,
  persistTeamFile,
  type Team,
} from '../tools/TeamCreateTool'
import { tryResolveNameFallback } from './sendMessageNameFallback'
import { unregisterActiveAgent, registerActiveAgent } from './activeAgentRegistry'
import type { ActiveAgent } from './types'
import { asAgentId } from '../tools/ids'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setWorkspacePath } from '../tools/workspaceState'
import { clearAllLocks } from '../tools/fileLock'

const TEAM = 'fallback-team'
const LEAD = 'team-lead@fallback-team'

let workspaceRoot: string

function makeRunningAgent(args: {
  agentId: string
  name: string
  teamName: string
}): ActiveAgent {
  // Minimal stub — only the fields tryResolveNameFallback inspects matter.
  const a: Partial<ActiveAgent> = {
    agentId: asAgentId(args.agentId),
    name: args.name,
    teamName: args.teamName,
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
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-name-fb-'))
  setWorkspacePath(workspaceRoot)
  clearTeams()
  const team: Team = {
    teamName: TEAM,
    leadAgentId: LEAD,
    members: [LEAD],
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

describe('tryResolveNameFallback', () => {
  it('returns no_team when no team hint is supplied', () => {
    const r = tryResolveNameFallback({
      lookupId: 'researcher',
      callerAgentId: 'main',
      callerIsTeammate: false,
      teamHint: undefined,
    })
    expect(r.kind).toBe('no_team')
  })

  it('routes "lead" / "team-lead" / "teamlead" to the team lead when caller is a teammate', () => {
    for (const alias of ['lead', 'team-lead', 'teamlead', 'TEAM-LEAD']) {
      const r = tryResolveNameFallback({
        lookupId: alias,
        callerAgentId: 'researcher@fallback-team',
        callerIsTeammate: true,
        teamHint: TEAM,
      })
      expect(r.kind, `alias=${alias}`).toBe('lead')
      if (r.kind === 'lead') {
        expect(r.teamName).toBe(TEAM)
        expect(r.leadAgentId).toBe(LEAD)
      }
    }
  })

  it('refuses to send to lead when the caller IS the lead (self_lead)', () => {
    const r = tryResolveNameFallback({
      lookupId: 'lead',
      callerAgentId: 'main',
      callerIsTeammate: false,
      teamHint: TEAM,
    })
    expect(r.kind).toBe('self_lead')
  })

  it('returns not_a_name for synthetic ids (uuid-ish, agent-bg-…, lead-… numeric)', () => {
    for (const id of [
      'agent-bg-1779730118322-1',
      'agent-fg-1779730118322-7',
      'lead-1779730118322-1',
      '550e8400-e29b-41d4-a716-446655440000',
    ]) {
      const r = tryResolveNameFallback({
        lookupId: id,
        callerAgentId: 'main',
        callerIsTeammate: false,
        teamHint: TEAM,
      })
      expect(r.kind, `id=${id}`).toBe('not_a_name')
    }
  })

  it('resolves to a uniquely registered member by NAME', () => {
    const ag = makeRunningAgent({
      agentId: 'researcher@fallback-team',
      name: 'researcher',
      teamName: TEAM,
    })
    expect(registerActiveAgent(ag).ok).toBe(true)

    try {
      const r = tryResolveNameFallback({
        lookupId: 'researcher',
        callerAgentId: 'main',
        callerIsTeammate: false,
        teamHint: TEAM,
      })
      expect(r.kind).toBe('member')
      if (r.kind === 'member') {
        expect(r.agent.agentId).toBe('researcher@fallback-team')
        expect(r.teamName).toBe(TEAM)
      }
    } finally {
      unregisterActiveAgent(asAgentId('researcher@fallback-team'))
    }
  })

  it('flags ambiguous when ≥2 members share a NAME on the same team', () => {
    const a1 = makeRunningAgent({
      agentId: 'researcher@fallback-team',
      name: 'researcher',
      teamName: TEAM,
    })
    const a2 = makeRunningAgent({
      agentId: 'researcher-2@fallback-team',
      name: 'researcher',
      teamName: TEAM,
    })
    expect(registerActiveAgent(a1).ok).toBe(true)
    expect(registerActiveAgent(a2).ok).toBe(true)

    try {
      const r = tryResolveNameFallback({
        lookupId: 'researcher',
        callerAgentId: 'main',
        callerIsTeammate: false,
        teamHint: TEAM,
      })
      expect(r.kind).toBe('ambiguous')
      if (r.kind === 'ambiguous') {
        expect(r.candidates).toHaveLength(2)
      }
    } finally {
      unregisterActiveAgent(asAgentId('researcher@fallback-team'))
      unregisterActiveAgent(asAgentId('researcher-2@fallback-team'))
    }
  })

  it('does not match members from a different team scope', () => {
    const ag = makeRunningAgent({
      agentId: 'researcher@other-team',
      name: 'researcher',
      teamName: 'other-team',
    })
    expect(registerActiveAgent(ag).ok).toBe(true)

    try {
      const r = tryResolveNameFallback({
        lookupId: 'researcher',
        callerAgentId: 'main',
        callerIsTeammate: false,
        teamHint: TEAM,
      })
      expect(r.kind).toBe('not_a_name')
    } finally {
      unregisterActiveAgent(asAgentId('researcher@other-team'))
    }
  })
})
