/**
 * Audit #11 + R4 (2026-07) — dedicated tests for the `team_summary` rollup
 * that the TeamStatus tool computes over live member rows:
 *
 *   - `overall` classification matrix (running / *_with_failures /
 *     completed / failed / *_with_aborts / aborted / idle)
 *   - `failures[]` collects ONLY `failed` members
 *   - `aborted[]` (R4) collects killed/stopped members so "2 completed +
 *     3 killed" can no longer roll up as a clean 'completed'
 *   - the lead row without a live agent behind it is excluded from counts
 *   - `coordination_note` surfaces a persisted swarm downgrade
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { setWorkspacePath } from './workspaceState'
import {
  clearTeams,
  persistTeamFile,
  teamStatusTool,
  type Team,
} from './TeamCreateTool'
import { registerActiveAgent, unregisterActiveAgent } from '../agents/activeAgentRegistry'
import type { ActiveAgent, BuiltInAgentDefinition } from '../agents/types'

const stubDef: BuiltInAgentDefinition = {
  source: 'built-in',
  agentType: 'Explore',
  whenToUse: '',
  getSystemPrompt: () => '',
}

let ws: string
let registeredIds: string[] = []

function makeWorkspace(): string {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-team-summary-'))
  setWorkspacePath(ws)
  return ws
}

function registerMember(
  agentId: string,
  teamName: string,
  status: ActiveAgent['status'],
): void {
  const agent: ActiveAgent = {
    agentId: agentId as ActiveAgent['agentId'],
    agentType: 'Explore',
    agentDef: stubDef,
    description: agentId,
    teamName,
    messages: [],
    pendingMessages: [],
    abortController: new AbortController(),
    startTime: Date.now(),
    status,
    resolve: () => {},
  }
  registerActiveAgent(agent)
  registeredIds.push(agentId)
}

async function makeTeam(
  members: Array<{ id: string; status?: ActiveAgent['status'] }>,
  opts?: { coordinationDowngradedFrom?: string },
): Promise<void> {
  makeWorkspace()
  const team: Team = {
    teamName: 'sum-team',
    leadAgentId: 'lead-s',
    members: ['lead-s', ...members.map((m) => m.id)],
    createdAt: Date.now(),
    mailbox: {},
    ...(opts?.coordinationDowngradedFrom
      ? { coordinationDowngradedFrom: opts.coordinationDowngradedFrom }
      : {}),
  }
  await persistTeamFile(ws, team)
  for (const m of members) {
    if (m.status) registerMember(m.id, 'sum-team', m.status)
  }
}

interface TeamSummaryShape {
  overall: string
  counts: Record<string, number>
  memberCount: number
  failures?: Array<{ agentId: string; name?: string; error?: string }>
  aborted?: Array<{ agentId: string; name?: string }>
  coordination_note?: string
}

async function readSummary(): Promise<TeamSummaryShape> {
  const res = await teamStatusTool.execute!({ team_name: 'sum-team' })
  expect(res.success).toBe(true)
  const parsed = JSON.parse(String(res.output)) as { team_summary: TeamSummaryShape }
  return parsed.team_summary
}

afterEach(() => {
  for (const id of registeredIds) unregisterActiveAgent(id)
  registeredIds = []
  setWorkspacePath(null)
  clearTeams()
  try {
    fs.rmSync(ws, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('TeamStatus team_summary — overall classification matrix', () => {
  it('all completed → overall "completed", no failures/aborted lists', async () => {
    await makeTeam([
      { id: 'w1', status: 'completed' },
      { id: 'w2', status: 'completed' },
    ])
    const s = await readSummary()
    expect(s.overall).toBe('completed')
    expect(s.counts.completed).toBe(2)
    expect(s.failures).toBeUndefined()
    expect(s.aborted).toBeUndefined()
  })

  it('running + failed → "running_with_failures" with the failed member listed', async () => {
    await makeTeam([
      { id: 'w1', status: 'running' },
      { id: 'w2', status: 'failed' },
    ])
    const s = await readSummary()
    expect(s.overall).toBe('running_with_failures')
    expect(s.failures?.map((f) => f.agentId)).toEqual(['w2'])
  })

  it('all failed → overall "failed"', async () => {
    await makeTeam([{ id: 'w1', status: 'failed' }])
    const s = await readSummary()
    expect(s.overall).toBe('failed')
    expect(s.failures).toHaveLength(1)
  })

  it('completed + failed → "completed_with_failures"', async () => {
    await makeTeam([
      { id: 'w1', status: 'completed' },
      { id: 'w2', status: 'failed' },
    ])
    const s = await readSummary()
    expect(s.overall).toBe('completed_with_failures')
  })

  it('R4 — completed + killed → "completed_with_aborts" with aborted[] (was silently "completed")', async () => {
    await makeTeam([
      { id: 'w1', status: 'completed' },
      { id: 'w2', status: 'killed' },
      { id: 'w3', status: 'killed' },
    ])
    const s = await readSummary()
    expect(s.overall).toBe('completed_with_aborts')
    expect(s.counts.killed).toBe(2)
    expect(s.aborted?.map((a) => a.agentId).sort()).toEqual(['w2', 'w3'])
    // killed members are NOT failures — the lists stay semantically distinct.
    expect(s.failures).toBeUndefined()
  })

  it('R4 — killed only → overall "aborted"', async () => {
    await makeTeam([{ id: 'w1', status: 'killed' }])
    const s = await readSummary()
    expect(s.overall).toBe('aborted')
    expect(s.aborted).toHaveLength(1)
  })

  it('failed takes precedence over killed in overall (completed_with_failures)', async () => {
    await makeTeam([
      { id: 'w1', status: 'completed' },
      { id: 'w2', status: 'failed' },
      { id: 'w3', status: 'killed' },
    ])
    const s = await readSummary()
    expect(s.overall).toBe('completed_with_failures')
    expect(s.failures?.map((f) => f.agentId)).toEqual(['w2'])
    expect(s.aborted?.map((a) => a.agentId)).toEqual(['w3'])
  })

  it('roster-only members (no live agent, no runtime) count as unknown → overall "idle"', async () => {
    await makeTeam([{ id: 'w1' }]) // listed in TeamFile, never launched
    const s = await readSummary()
    expect(s.overall).toBe('idle')
    expect(s.counts.unknown).toBe(1)
  })

  it('excludes the lead row when it has no live agent behind it (manual path)', async () => {
    await makeTeam([{ id: 'w1', status: 'completed' }])
    const s = await readSummary()
    // lead-s is in the roster but has no live agent → excluded from counts.
    expect(s.memberCount).toBe(1)
    expect(s.overall).toBe('completed')
  })
})

describe('TeamStatus team_summary — coordination downgrade note', () => {
  it('surfaces coordination_note when the TeamFile persisted a downgrade', async () => {
    await makeTeam([{ id: 'w1', status: 'completed' }], {
      coordinationDowngradedFrom: 'swarm',
    })
    const s = await readSummary()
    expect(s.coordination_note).toContain('"swarm"')
  })

  it('omits coordination_note when no downgrade happened', async () => {
    await makeTeam([{ id: 'w1', status: 'completed' }])
    const s = await readSummary()
    expect(s.coordination_note).toBeUndefined()
  })
})
