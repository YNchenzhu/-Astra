/**
 * upstream report §7.6 — in-process teammate identity helpers (Electron main / ALS).
 *
 * upstream uses `agentId` like `researcher@my-team`; this host often uses opaque ids but still
 * binds `teamId` + optional display `name` — {@link buildTeammateRuntimeContext} normalizes both.
 */

import type { AgentId } from '../tools/ids'

export interface TeammateRuntimeContext {
  /** Stable id for registry / SendMessage (may be opaque uuid or `name@team`). */
  agentId: AgentId
  /** Short agent name within the team. */
  agentName: string
  /** Team id / TeamFile key (same semantic as {@link AgentContext.teamId}). */
  teamName: string
  isInProcess: true
  planModeRequired: boolean
  /** Renderer stream session or parent correlation id when available. */
  parentSessionId?: string
  color?: string
}

/** Parse `name@team` agent ids (upstream teammate convention). */
export function parseTeammateAgentId(agentId: AgentId): { agentName: string; teamName: string } | null {
  const i = agentId.indexOf('@')
  if (i <= 0 || i === agentId.length - 1) return null
  const agentName = agentId.slice(0, i).trim()
  const teamName = agentId.slice(i + 1).trim()
  if (!agentName || !teamName) return null
  return { agentName, teamName }
}

/**
 * Build ALS teammate snapshot for any sub-agent run that is scoped to a team.
 */
export function buildTeammateRuntimeContext(params: {
  agentId: AgentId
  name?: string
  teamName: string
  planModeRequired?: boolean
  parentSessionId?: string
  color?: string
}): TeammateRuntimeContext {
  const teamTrim = params.teamName.trim()
  const parsed = parseTeammateAgentId(params.agentId)
  const agentName = parsed?.agentName ?? (params.name?.trim() || params.agentId)
  const teamName = parsed?.teamName ?? teamTrim
  return {
    agentId: params.agentId,
    agentName,
    teamName,
    isInProcess: true,
    planModeRequired: params.planModeRequired ?? false,
    parentSessionId: params.parentSessionId,
    color: params.color,
  }
}

export function isTeammateAgentContext(
  ctx: { teammate?: TeammateRuntimeContext | null } | null | undefined,
): boolean {
  return ctx?.teammate?.isInProcess === true
}

export function getTeammateAgentName(
  ctx: { teammate?: TeammateRuntimeContext | null } | null | undefined,
): string | undefined {
  return ctx?.teammate?.agentName
}

export function getTeammateTeamName(
  ctx: { teammate?: TeammateRuntimeContext | null } | null | undefined,
): string | undefined {
  return ctx?.teammate?.teamName
}

/** Whether this agent id is the team lead recorded on {@link Team}. */
export function isTeamLead(agentId: AgentId, leadAgentId: AgentId | undefined): boolean {
  if (!leadAgentId?.trim() || !agentId.trim()) return false
  return agentId.trim() === leadAgentId.trim()
}

/**
 * S7 — whether the **caller's** ALS agent context represents the lead of
 * the given team. Lead semantics (mirrors upstream): the team lead is the
 * top-level chat session itself, not a spawned teammate.
 *
 * True iff:
 * - context exists,
 * - `ctx.teamId` matches `teamName` (trimmed equality),
 * - `ctx.teammate` is unset (caller is NOT a spawned teammate),
 * - `ctx.agentId === 'main'` (caller is the top-level chat session).
 *
 * This is the predicate to use when deciding "is the SendMessage target
 * `lead` / `team-lead` actually addressed at me?" or "should this UI
 * element show only to the team lead?".
 */
export function isCallerLead(
  ctx:
    | { agentId: AgentId; teamId?: string; teammate?: TeammateRuntimeContext | null }
    | null
    | undefined,
  teamName: string | undefined,
): boolean {
  if (!ctx || !teamName) return false
  const t = teamName.trim()
  if (!t) return false
  if ((ctx.teamId ?? '').trim() !== t) return false
  if (ctx.teammate) return false
  return String(ctx.agentId).trim() === 'main'
}
