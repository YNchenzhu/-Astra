/**
 * S4 — upstream-aligned deterministic agent id format.
 *
 * upstream-main builds agent ids as `<name>@<teamName>` (`team-lead@my-team`,
 * `researcher@my-team`, …) — see
 * `upstream-main/src/utils/agentId.ts:38-40` and
 * `upstream-main/src/tools/TeamCreateTool/TeamCreateTool.ts:146`. Benefits:
 *
 *   - Reproducible: same name+team → same id, so reconnect after a
 *     restart works without a registry side-table.
 *   - Human-readable: ids are debuggable in logs and tool output.
 *   - Predictable: the lead can compute a member's id without lookup.
 *
 * cursor-ui-clone previously generated synthetic ids via `Date.now()` +
 * a counter (`lead-1779730118322-1`, `agent-bg-1779…-3`). Those ids
 * still work end-to-end, but they're opaque to the model — and they
 * trip up users who read the TeamCreate output and assume `lead_agent_id`
 * is a SendMessage target (the bug that started this entire alignment).
 *
 * This module centralises the upstream format so the team / spawn /
 * sendMessage paths can adopt it incrementally without each site
 * re-deriving sanitisation rules.
 */

import { asAgentId, type AgentId } from '../tools/ids'
import { sanitizeTeamFileBase } from '../tools/teamFileShared'

/** Default name used by upstream for the team lead. */
export const TEAM_LEAD_NAME = 'team-lead'

/** Separator between agent name and team name. */
export const AGENT_ID_AT = '@'

/**
 * Sanitise a free-form agent name so it survives an id role:
 *   - strip `@` (the separator)
 *   - replace runs of whitespace / control / id-unsafe chars with `-`
 *   - collapse repeated dashes
 *   - lowercase optional? upstream keeps original case — we follow.
 *
 * Empty / falsy input returns `'anon'` so downstream code never
 * synthesises `@<team>` (a lead alias collision).
 */
export function sanitizeAgentName(raw: string | undefined): string {
  const s = (raw ?? '').trim()
  if (!s) return 'anon'
  const cleaned = s
    .replace(/@/g, '')
    // eslint-disable-next-line no-control-regex -- control chars are deliberately stripped from agent ids.
    .replace(/[\s\u0000-\u001f\\/:]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned.length > 0 ? cleaned : 'anon'
}

/**
 * Build the deterministic id for the team lead. Mirrors upstream's
 * `formatAgentId(TEAM_LEAD_NAME, teamName)`.
 *
 * The team segment is run through {@link sanitizeTeamFileBase} so the id
 * never contains slashes / control chars and stays safe to embed in
 * mailbox keys, log lines, file paths, and JSON envelopes.
 */
export function formatLeadAgentId(teamName: string): AgentId {
  const team = sanitizeTeamFileBase(teamName)
  return asAgentId(`${TEAM_LEAD_NAME}${AGENT_ID_AT}${team}`)
}

/**
 * Build the deterministic id for a spawned teammate. Mirrors upstream's
 * `formatAgentId(sanitizeAgentName(name), teamName)`.
 */
export function formatTeammateAgentId(name: string, teamName: string): AgentId {
  const cleanName = sanitizeAgentName(name)
  const team = sanitizeTeamFileBase(teamName)
  return asAgentId(`${cleanName}${AGENT_ID_AT}${team}`)
}

/**
 * Append a suffix when the desired teammate id already exists in the
 * registry — upstream calls this `generateUniqueTeammateName`. We keep
 * `name@team`, `name-2@team`, `name-3@team`, … so the user-visible
 * NAME stays close to what the caller asked for.
 *
 * @param desiredId   the candidate id (typically from {@link formatTeammateAgentId})
 * @param isTaken    predicate: returns true if an id is in use; usually
 *                    backed by `getActiveAgent(id)` + roster lookup.
 */
export function makeUniqueTeammateAgentId(
  name: string,
  teamName: string,
  isTaken: (candidateId: string) => boolean,
): AgentId {
  const team = sanitizeTeamFileBase(teamName)
  const baseName = sanitizeAgentName(name)
  let candidate = `${baseName}${AGENT_ID_AT}${team}`
  if (!isTaken(candidate)) return asAgentId(candidate)
  for (let n = 2; n < 1024; n++) {
    candidate = `${baseName}-${n}${AGENT_ID_AT}${team}`
    if (!isTaken(candidate)) return asAgentId(candidate)
  }
  // Last-resort: append a timestamp so the run still proceeds; this is
  // pathological (1000+ same-name spawns in one team).
  candidate = `${baseName}-${Date.now()}${AGENT_ID_AT}${team}`
  return asAgentId(candidate)
}
