/**
 * Per-agent inbox JSON mirror under `.claude/teams/{team}/inboxes/{agent}.json` (upstream §7.8).
 * Team file remains canonical; this is a durable mirror for tooling / upstream-style layout.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Team } from './teamFileShared'
import { getTeamFilePath, sanitizeTeamFileBase } from './teamFileShared'
import { asAgentId, type AgentId } from './ids'

function sanitizeAgentIdForPath(agentId: AgentId): string {
  return agentId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'agent'
}

export function getTeamInboxDir(workspaceRoot: string, teamName: string): string {
  const teamSeg = sanitizeTeamFileBase(teamName)
  return path.join(workspaceRoot, '.claude', 'teams', teamSeg, 'inboxes')
}

export function getTeamInboxFilePath(
  workspaceRoot: string,
  teamName: string,
  agentId: AgentId,
): string {
  return path.join(getTeamInboxDir(workspaceRoot, teamName), `${sanitizeAgentIdForPath(agentId)}.json`)
}

export async function mirrorTeamMailboxToInboxFiles(
  workspaceRoot: string,
  team: Team,
): Promise<void> {
  const mailbox = team.mailbox
  if (!mailbox || typeof mailbox !== 'object') return
  const dir = getTeamInboxDir(workspaceRoot, team.teamName)
  await fs.mkdir(dir, { recursive: true })
  for (const [agentId, messages] of Object.entries(mailbox)) {
    if (!Array.isArray(messages)) continue
    const file = getTeamInboxFilePath(workspaceRoot, team.teamName, asAgentId(agentId))
    const payload = {
      teamName: team.teamName,
      agentId,
      messages,
      updatedAt: new Date().toISOString(),
    }
    await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }
}

export async function mirrorTeamFileMailboxToInboxes(
  workspaceRoot: string,
  teamName: string,
): Promise<void> {
  const teamPath = getTeamFilePath(workspaceRoot, teamName)
  let raw: string
  try {
    raw = await fs.readFile(teamPath, 'utf8')
  } catch {
    return
  }
  let team: Team
  try {
    team = JSON.parse(raw) as Team
  } catch {
    return
  }
  await mirrorTeamMailboxToInboxFiles(workspaceRoot, team)
}
