/**
 * TeamDeleteTool — remove a team from memory and delete its TeamFile.
 */

import {
  getAllTeams,
  getTeam,
  getTeamFilePath,
  removeTeamFromMemory,
  deleteTeamFile,
} from './TeamCreateTool'
import { getTeamInboxDir } from './teamInboxFiles'
import fs from 'node:fs'
import { teamDeleteInputZod } from './toolInputZod'
import { getWorkspacePath } from './workspaceState'
import { getActiveAgents } from '../agents/activeAgentRegistry'
import { buildTool } from './buildTool'

/**
 * P1-24: abort every running agent that belongs to the named team. We can't
 * unregister entries here — the agentic loop's own `finally` does that —
 * we only need to signal the AbortController so the loops actually stop
 * (otherwise teammates keep producing tool calls and writing to a mailbox
 * whose backing TeamFile we just deleted).
 */
function abortRunningTeamMembers(teamName: string): number {
  const target = teamName.trim()
  if (!target) return 0
  const reg = getActiveAgents()
  let aborted = 0
  for (const agent of reg.values()) {
    if (agent.status !== 'running') continue
    if ((agent.teamName ?? '').trim() !== target) continue
    try {
      agent.abortController.abort()
      aborted++
    } catch {
      /* loop teardown handles fallout */
    }
  }
  return aborted
}

export const teamDeleteTool = buildTool({
  name: 'TeamDelete',
  zInputSchema: teamDeleteInputZod,
  description:
    'Disband team(s): remove from the active session and delete `.claude/teams/<name>.json` when a workspace is open. Pass team_name for one team, or omit to clear all.',
  inputSchema: [
    {
      name: 'team_name',
      type: 'string',
      description: 'Specific team to delete. If omitted, all in-memory teams are disbanded.',
    },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,
  async call({ team_name }) {
    const workspaceRoot = getWorkspacePath()

    if (team_name && team_name.trim()) {
      const name = team_name.trim()
      if (!getTeam(name)) {
        return { success: false, error: `No team named "${name}" in the active session.` }
      }
      // P1-24: abort running members BEFORE we delete the TeamFile so any
      // in-flight tool call can finish writing to a still-existing mailbox.
      const aborted = abortRunningTeamMembers(name)
      removeTeamFromMemory(name)
      if (workspaceRoot) {
        await deleteTeamFile(workspaceRoot, name)
        // TEAM-01: clean inbox directories to prevent disk leaks and
        // privacy residue after team deletion.
        try {
          const inboxDir = getTeamInboxDir(workspaceRoot, name)
          if (fs.existsSync(inboxDir)) {
            fs.rmSync(inboxDir, { recursive: true, force: true })
          }
        } catch { /* inbox cleanup is non-fatal */ }
      }
      const memberSuffix = aborted > 0 ? ` Aborted ${aborted} running member(s).` : ''
      return {
        success: true,
        output: `Team "${name}" removed.${workspaceRoot ? ` Deleted ${getTeamFilePath(workspaceRoot, name)} if present.` : ''}${memberSuffix}`,
      }
    }

    const all = getAllTeams()
    if (all.length === 0) {
      return { success: false, error: 'No active teams to delete' }
    }

    const names = all.map((t) => t.teamName)
    let totalAborted = 0
    for (const n of names) {
      // P1-24: same shutdown sequence in the bulk path.
      totalAborted += abortRunningTeamMembers(n)
      removeTeamFromMemory(n)
      if (workspaceRoot) {
        await deleteTeamFile(workspaceRoot, n)
        // TEAM-01 (audit C-P1-1): the bulk path skipped the inbox cleanup
        // the single-team path performs — same disk/privacy residue.
        try {
          const inboxDir = getTeamInboxDir(workspaceRoot, n)
          if (fs.existsSync(inboxDir)) {
            fs.rmSync(inboxDir, { recursive: true, force: true })
          }
        } catch { /* inbox cleanup is non-fatal */ }
      }
    }

    const memberSuffix = totalAborted > 0 ? ` Aborted ${totalAborted} running member(s).` : ''
    return {
      success: true,
      output: `Deleted team(s): ${names.join(', ')}.${memberSuffix}`,
    }
  },
})
