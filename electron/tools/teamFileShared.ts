/**
 * Shared TeamFile types and path helpers (no teamMailbox / registry imports).
 */

import path from 'node:path'
import type { AgentId } from './ids'

export const TEAM_FILE_VERSION = 1 as const

/** Host transport: in-process (Electron) or external pane hints when detected (§7.3 / AC-7.2). */
export type SwarmBackendKind = 'in-process' | 'tmux' | 'iterm2'

/**
 * upstream report §7.4 — per-member metadata (optional). `members` may mix plain ids and objects.
 */
export interface TeamMemberProfile {
  agentId: AgentId
  name?: string
  agentType?: string
  model?: string
  color?: string
  joinedAt?: number
  planModeRequired?: boolean
  sessionId?: string
  cwd?: string
  isActive?: boolean
  backendType?: SwarmBackendKind
  subscriptions?: string[]
  /** Permission mode label when leader pushes mode_set (subset). */
  mode?: string
}

export type TeamMemberSlot = string | TeamMemberProfile

export function teamMemberIds(slots: TeamMemberSlot[] | undefined): string[] {
  if (!slots?.length) return []
  const out: string[] = []
  for (const s of slots) {
    if (typeof s === 'string') {
      const id = s.trim()
      if (id) out.push(id)
    } else if (s?.agentId?.trim()) {
      out.push(s.agentId.trim())
    }
  }
  return out
}

export function teamHasMember(slots: TeamMemberSlot[] | undefined, agentId: AgentId): boolean {
  const id = agentId.trim()
  if (!id) return false
  return teamMemberIds(slots).includes(id)
}

/** Append a plain id when missing (keeps existing rich entries). */
export function appendTeamMemberSlot(
  slots: TeamMemberSlot[] | undefined,
  agentId: AgentId,
): TeamMemberSlot[] {
  const list = slots ?? []
  if (teamHasMember(list, agentId)) return list
  return [...list, agentId.trim()]
}

/**
 * S5 — drop a member by agentId. Used after a `shutdown_response{approve}`
 * is processed so the TeamFile roster reflects the actual live team.
 * Pure / immutable — returns a new slot array; callers persist as usual.
 */
export function removeTeamMemberSlot(
  slots: TeamMemberSlot[] | undefined,
  agentId: AgentId,
): TeamMemberSlot[] {
  if (!slots?.length) return []
  const id = agentId.trim()
  if (!id) return [...slots]
  return slots.filter((s) => {
    if (typeof s === 'string') return s.trim() !== id
    return (s?.agentId ?? '').trim() !== id
  })
}

export interface Team {
  teamName: string
  description?: string
  agentType?: string
  leadAgentId: string
  /** Member roster: string ids and/or §7.4-style profile objects. */
  members: TeamMemberSlot[]
  createdAt: number
  /** Durable mailbox: agentId → queued notes (audit / tooling). */
  mailbox?: Record<string, string[]>
  /** AC-7.2 — Swarm / team transport hint (`detectSwarmBackend`); coordination still uses TeamFile + registry. */
  swarmBackend?: SwarmBackendKind
  /** Absolute path to this team’s TeamFile JSON (set on create / load). */
  teamFilePath?: string
  /**
   * Contract audit (2026-07) — set when the auto-launch plan downgraded the
   * template's coordination style (today: swarm → parallel, single-process
   * host). Persisted on the TeamFile so `TeamStatus` can keep surfacing the
   * downgrade after the TeamCreate response scrolled out of context.
   */
  coordinationDowngradedFrom?: string
}

export interface TeamFilePayload extends Team {
  version: typeof TEAM_FILE_VERSION
}

/** Safe segment for team JSON filename and `teams/{team}/…` directory names (upstream §7.8). */
export function sanitizeTeamFileBase(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'team'
}

export function getTeamFilePath(workspaceRoot: string, teamName: string): string {
  const dir = path.join(workspaceRoot, '.claude', 'teams')
  return path.join(dir, `${sanitizeTeamFileBase(teamName)}.json`)
}
