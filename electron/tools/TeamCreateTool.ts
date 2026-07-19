/**
 * TeamCreateTool — multi-agent team with durable TeamFile under `.claude/teams/`.
 *
 * Aligns with ARCHITECTURE.md: TeamCreate → TeamFile (lead + members) + in-memory coordination.
 * Phase 3: durable mailbox helpers, member registration, team status snapshot.
 */

import fs from 'node:fs'
import path from 'node:path'
import { teamStatusInputZod, teamCreateInputZod } from './toolInputZod'
import { buildTool } from './buildTool'
import { getWorkspacePath } from './workspaceState'
import { withFileLock } from './fileLock'
import { patchAgentContextTeamId, getAgentContext } from '../agents/agentContext'
import { getActiveBundle } from '../agents/bundles/bundleRegistryQueries'
import { asAgentId, type AgentId } from './ids'
import {
  TEAM_FILE_VERSION,
  type SwarmBackendKind,
  type Team,
  type TeamFilePayload,
  getTeamFilePath,
  teamMemberIds,
  teamHasMember,
  appendTeamMemberSlot,
  removeTeamMemberSlot,
} from './teamFileShared'
import {
  buildTeamSwarmMetadataAsync,
  isExternalSwarmBackendAvailableAsync,
} from './swarmBackend'
import { appendTeamMailbox, readAndClearTeamMailbox } from './teamMailbox'
import { getTeamInboxDir } from './teamInboxFiles'
import { writeJsonFileAtomic } from '../fs/atomicWrite'
import {
  enqueueAgentMailboxMessage,
  getActiveAgent,
  getActiveAgents,
} from '../agents/activeAgentRegistry'
import { taskRuntimeStore, type TaskRuntimeStatus } from './TaskRuntimeStore'
import { formatLeadAgentId } from '../agents/teamAgentIdFormat'

export { TEAM_FILE_VERSION, type Team, type TeamFilePayload, getTeamFilePath } from './teamFileShared'

const teams = new Map<string, Team>()

export async function persistTeamFile(workspaceRoot: string, team: Team): Promise<void> {
  const fp = getTeamFilePath(workspaceRoot, team.teamName)
  await withFileLock(fp, async () => {
    const payload: TeamFilePayload = { version: TEAM_FILE_VERSION, ...team }
    // P0-4 / TEAM-02: shared atomic writer (tmp+rename) — collision-safe tmp
    // names + guaranteed cleanup on partial-write failure. Replaces the
    // hand-rolled `Date.now()`-suffixed implementation that could leave
    // orphan `.tmp-*.json` files when the rename step threw.
    writeJsonFileAtomic(fp, payload, 2)
  })
}

export function loadTeamFile(workspaceRoot: string, teamName: string): Team | null {
  try {
    const fp = getTeamFilePath(workspaceRoot, teamName)
    if (!fs.existsSync(fp)) return null
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8')) as TeamFilePayload
    if (!raw.teamName || !raw.leadAgentId) return null
    const { version: _v, ...rest } = raw
    return rest as Team
  } catch {
    return null
  }
}

export async function deleteTeamFile(workspaceRoot: string, teamName: string): Promise<boolean> {
  const fp = getTeamFilePath(workspaceRoot, teamName)
  return withFileLock(fp, async () => {
    let removed = false
    try {
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp)
        removed = true
      }
    } catch {
      /* ignore — best-effort cleanup */
    }

    // Bug T-13 fix: also remove the per-team inbox mirror directory at
    // `.claude/teams/<teamSeg>/inboxes/`. The previous implementation only
    // unlinked `<teamSeg>.json`, leaving member inbox JSONs (and the
    // wrapping team directory if otherwise empty) on disk. Disk + privacy
    // leak. Best-effort: ignore errors so a partially-readable inbox does
    // not block team deletion.
    try {
      const inboxDir = getTeamInboxDir(workspaceRoot, teamName)
      if (fs.existsSync(inboxDir)) {
        fs.rmSync(inboxDir, { recursive: true, force: true })
      }
      const teamDir = path.dirname(inboxDir)
      if (fs.existsSync(teamDir)) {
        try {
          const remaining = fs.readdirSync(teamDir)
          if (remaining.length === 0) fs.rmdirSync(teamDir)
        } catch {
          /* ignore — leftover unrelated files keep the dir alive */
        }
      }
    } catch {
      /* ignore — inbox cleanup is non-fatal for deletion success */
    }

    return removed
  })
}

export function getTeam(name: string): Team | undefined {
  const cached = teams.get(name)
  if (cached) return cached
  // Fall-through to disk: after a process restart (and in tests that
  // persist via {@link persistTeamFile} without going through the tool's
  // `call()` path) the in-memory `teams` Map is empty, but the on-disk
  // TeamFile is the source of truth. Match the lazy-load behaviour
  // already used by {@link broadcastTeamMessage} / {@link getTeamStatus}
  // so callers that only know the team's name (e.g. SendMessage NAME
  // fallback's lead-alias lookup) work consistently.
  const ws = getWorkspacePath()
  if (!ws) return undefined
  const loaded = loadTeamFile(ws, name)
  if (loaded) {
    teams.set(name, loaded)
    return loaded
  }
  return undefined
}

export function getAllTeams(): Team[] {
  return [...teams.values()]
}

export function clearTeams(): void {
  teams.clear()
}

export function removeTeamFromMemory(teamName: string): boolean {
  return teams.delete(teamName)
}

// ========== Phase 3: mailbox + member sync ==========

export function formatTeamMailboxLine(body: string): string {
  return `[${new Date().toISOString()}] ${body}`
}

export function formatTeamMailboxEnvelopeLine(envelope: Record<string, unknown>): string {
  return formatTeamMailboxLine(JSON.stringify(envelope))
}

/**
 * Add an agent id to the team on disk + in-memory (idempotent).
 * The entire read-check-write cycle is wrapped in withFileLock to prevent
 * TOCTOU races when two agents concurrently add different members.
 */
export async function ensureTeamMember(teamName: string, agentId: AgentId): Promise<void> {
  const ws = getWorkspacePath()
  if (!ws || !teamName.trim() || !agentId) return

  const fp = getTeamFilePath(ws, teamName)
  await withFileLock(fp, async () => {
    // Re-read from disk inside the lock to guarantee freshness
    const team = loadTeamFile(ws, teamName)
    if (!team) return
    if (!teamHasMember(team.members, agentId)) {
      team.members = appendTeamMemberSlot(team.members, agentId)
      teams.set(teamName, team)
      // P0-4: persist atomically (tmp+rename) so a crash mid-write cannot
      // truncate the TeamFile and silently lose the membership entry.
      const payload: TeamFilePayload = { version: TEAM_FILE_VERSION, ...team }
      writeJsonFileAtomic(fp, payload, 2)
    } else {
      // Already a member — just ensure in-memory is up to date
      teams.set(teamName, team)
    }
  })
}

/**
 * S5 — drop a member from the team file (and in-memory map). The lead
 * calls this after consuming a `shutdown_response{approve:true}` from
 * the member, mirroring upstream's `removeTeammateFromTeamFile`.
 *
 * Idempotent + lock-safe: re-reads under {@link withFileLock} so two
 * concurrent removals don't lose intermediate writes. Never throws —
 * callers should treat removal as best-effort cleanup. Returns whether
 * a row was actually deleted (false = nothing to remove).
 */
export async function removeTeamMember(
  teamName: string,
  agentId: AgentId,
): Promise<boolean> {
  const ws = getWorkspacePath()
  if (!ws || !teamName.trim() || !agentId) return false

  const fp = getTeamFilePath(ws, teamName)
  return withFileLock(fp, async () => {
    const team = loadTeamFile(ws, teamName)
    if (!team) return false
    if (!teamHasMember(team.members, agentId)) {
      teams.set(teamName, team)
      return false
    }
    team.members = removeTeamMemberSlot(team.members, agentId)
    // Drop any lingering mailbox queue for the departing member so a
    // future `getTeamStatus` doesn't surface stale backlog.
    if (team.mailbox && agentId in team.mailbox) {
      const next: Record<string, string[]> = { ...team.mailbox }
      delete next[agentId]
      team.mailbox = next
    }
    teams.set(teamName, team)
    const payload: TeamFilePayload = { version: TEAM_FILE_VERSION, ...team }
    writeJsonFileAtomic(fp, payload, 2)
    return true
  })
}

/** Append to durable mailbox + optional live queue for a specific member. */
export async function sendTeamMessage(
  workspaceRoot: string,
  teamName: string,
  fromAgentId: string,
  toAgentId: string,
  message: string,
  options?: { type?: string },
): Promise<{ ok: boolean; error?: string }> {
  const line = formatTeamMailboxEnvelopeLine({
    from: fromAgentId,
    to: toAgentId,
    teamName,
    type: options?.type || 'task',
    payload: message,
  })
  try {
    await appendTeamMailbox(workspaceRoot, teamName, toAgentId, line)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
  const target = getActiveAgent(toAgentId)
  if (target?.status === 'running') {
    enqueueAgentMailboxMessage(target, line)
  }
  return { ok: true }
}

/** Consumptive read of queued durable lines for one agent. */
export async function readTeamMailbox(
  workspaceRoot: string,
  teamName: string,
  agentId: AgentId,
): Promise<string[]> {
  const lines = await readAndClearTeamMailbox(workspaceRoot, teamName, agentId)
  const t = teams.get(teamName)
  if (t) {
    t.mailbox = { ...(t.mailbox || {}), [agentId]: [] }
  }
  return lines
}

/** Broadcast a message to all team members except the sender (file + running agents on that team). */
export async function broadcastTeamMessage(
  workspaceRoot: string,
  teamName: string,
  fromAgentId: string,
  message: string,
  options?: { type?: string },
): Promise<{ delivered: number; recipientIds: string[] }> {
  let team = getTeam(teamName)
  if (!team) {
    const loaded = loadTeamFile(workspaceRoot, teamName)
    if (loaded) {
      teams.set(teamName, loaded)
      team = loaded
    }
  }
  if (!team) return { delivered: 0, recipientIds: [] }

  const recipients = new Set<string>()
  for (const id of teamMemberIds(team.members)) {
    if (id !== fromAgentId) recipients.add(id)
  }
  for (const [, a] of getActiveAgents()) {
    if (a.teamName === teamName && a.agentId !== fromAgentId && a.status === 'running') {
      recipients.add(a.agentId)
    }
  }

  const recipientIds = [...recipients]
  let delivered = 0
  for (const id of recipientIds) {
    const r = await sendTeamMessage(workspaceRoot, teamName, fromAgentId, id, message, {
      type: options?.type || 'broadcast',
    })
    if (r.ok) delivered++
  }
  return { delivered, recipientIds }
}

export interface TeamMemberRuntimeStatus {
  agentId: AgentId
  name?: string
  listedInTeamFile: boolean
  agentStatus?: 'running' | 'completed' | 'failed' | 'killed'
  pendingQueueDepth: number
  mailboxBacklog: number
  /** Number of unread in-memory mailbox messages dropped due to queue limits. */
  mailboxDroppedCount: number
  lastMailboxDropAt?: number
}

function mapTaskRuntimeStatusToAgentStatus(
  status: TaskRuntimeStatus | undefined,
): TeamMemberRuntimeStatus['agentStatus'] | undefined {
  if (status === 'running' || status === 'pending') return 'running'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'stopped') return 'killed'
  return undefined
}

export interface TeamStatusSnapshot {
  teamName: string
  leadAgentId: string
  memberAgentIds: string[]
  createdAt: number
  members: TeamMemberRuntimeStatus[]
  /** AC-7.2 — always `in-process` in Electron; external Swarm backends are unavailable. */
  swarmBackend?: SwarmBackendKind
  teamFilePath?: string
  /** Contract audit (2026-07) — coordination style the launch plan downgraded FROM (e.g. 'swarm'). */
  coordinationDowngradedFrom?: string
}

/** Runtime + durable mailbox view for orchestration / UI. */
export function getTeamStatus(teamName: string): TeamStatusSnapshot | null {
  const ws = getWorkspacePath()
  if (!ws) return null

  let team = getTeam(teamName)
  if (!team) {
    const loaded = loadTeamFile(ws, teamName)
    if (!loaded) return null
    teams.set(teamName, loaded)
    team = loaded
  }

  const disk = loadTeamFile(ws, teamName)
  const diskMailbox = disk?.mailbox || {}

  const ids = new Set<string>(teamMemberIds(team.members))
  for (const [, a] of getActiveAgents()) {
    if (a.teamName === teamName) ids.add(a.agentId)
  }

  const members: TeamMemberRuntimeStatus[] = []
  for (const rawAgentId of ids) {
    const agentId = asAgentId(rawAgentId)
    const active = getActiveAgent(agentId)
    const runtime = taskRuntimeStore.get(agentId)
    const memMailbox = team.mailbox?.[agentId]
    const diskM = diskMailbox[agentId]
    const mailboxBacklog = Math.max(memMailbox?.length ?? 0, diskM?.length ?? 0)
    members.push({
      agentId,
      name: active?.name,
      listedInTeamFile: teamHasMember(team.members, agentId),
      agentStatus: active?.status ?? mapTaskRuntimeStatusToAgentStatus(runtime?.status),
      pendingQueueDepth: active?.pendingMessages.length ?? 0,
      mailboxBacklog,
      mailboxDroppedCount: active?.mailboxDroppedCount ?? 0,
      ...(active?.lastMailboxDropAt ? { lastMailboxDropAt: active.lastMailboxDropAt } : {}),
    })
  }

  // P1 (audit 1): `memberAgentIds` was previously sourced only from
  // `team.members` (the TeamFile roster). For template-driven teams the
  // launcher only writes to the roster AFTER each member finishes (see
  // `launchTeamFromTemplateAsync` → `ensureTeamMember`), so the slim id
  // list under-reported the live team for the entire duration of a run —
  // users querying `TeamStatus.memberAgentIds` only saw the `lead-…` id
  // even though `SendMessage`'s broadcast (which iterates the same `ids`
  // set merged below) correctly addressed every live member. We now
  // publish the merged set so the slim list and the rich `members[]`
  // field agree.
  return {
    teamName: team.teamName,
    leadAgentId: team.leadAgentId,
    memberAgentIds: [...ids],
    createdAt: team.createdAt,
    members,
    swarmBackend: team.swarmBackend,
    teamFilePath: team.teamFilePath || (ws ? getTeamFilePath(ws, team.teamName) : undefined),
    ...(team.coordinationDowngradedFrom
      ? { coordinationDowngradedFrom: team.coordinationDowngradedFrom }
      : {}),
  }
}

/**
 * Per-member preview window in `TeamStatus`. The 12_000 cap that lived
 * here previously was tight enough that team scenarios with workers
 * producing typical 30-80k char reports came back looking complete to
 * the coordinator while only the tail had actually arrived. Bumped to
 * 40_000 so a typical worker report fits inline; for longer reports we
 * now also surface explicit `outputTruncated` / `fullOutputCharCount`
 * metadata so the coordinator can decide whether to call `TaskOutput`
 * for the full body instead of silently reasoning off a truncated tail.
 */
const TEAM_STATUS_OUTPUT_PREVIEW = 40_000

/** Read-only: team roster + per-member latest streamed text (for parent after SendMessage). */
export const teamStatusTool = buildTool({
  name: 'TeamStatus',
  zInputSchema: teamStatusInputZod,
  description:
    'Return team members, run/mailbox state, and each member\'s latest streamed text output. ' +
    '`team_summary` gives the rollup: overall (running / completed / *_with_failures / *_with_aborts / failed / aborted / idle), per-status counts, a `failures[]` list with per-member errors, an `aborted[]` list for killed/stopped members (not failures, not successes), and a coordination downgrade note when the launch plan degraded (e.g. swarm → parallel). Check `team_summary.failures` FIRST — auto-launch does not fail the TeamCreate call when members fail. ' +
    'Main-spawned background workers inject **new** streamed text into the **next** user turn automatically (capped); use TeamStatus for immediate mailbox/preview without waiting, or for coordinator-spawned members. ' +
    'Each member object reports `outputTruncated` and `fullOutputCharCount` when its preview was clipped — call `TaskOutput` with `task_id=<member.taskOutputTaskId>` (offset/limit) to page through the full body instead of reasoning off the tail alone.',
  inputSchema: [
    { name: 'team_name', type: 'string', description: 'Team name from TeamCreate', required: true },
  ],
  isReadOnly: true,
  isConcurrencySafe: true,
  async call({ team_name }) {
    const name = typeof team_name === 'string' ? team_name.trim() : ''
    if (!name) {
      return { success: false, error: 'team_name is required' }
    }
    const snap = getTeamStatus(name)
    if (!snap) {
      return { success: false, error: `Team "${name}" not found (no TeamFile or unknown name).` }
    }
    // Contract audit (2026-07) — team-level rollup so the caller does not
    // have to fold member rows itself (and so failures can't hide inside a
    // long members[] array). The lead row is excluded when it has no live
    // agent behind it (manual-path teams: the lead is the calling agent).
    const countable = snap.members.filter(
      (m) => !(m.agentId === snap.leadAgentId && m.agentStatus === undefined),
    )
    const statusCounts = { running: 0, completed: 0, failed: 0, killed: 0, unknown: 0 }
    const failures: Array<{ agentId: string; name?: string; error?: string }> = []
    // Audit R4 (2026-07) — killed/stopped members are NOT failures (the stop
    // may be user-initiated) but they are NOT successes either. Previously
    // they only appeared in `counts.killed`, so "2 completed + 3 killed"
    // rolled up as overall 'completed' — hiding aborted work from a caller
    // that reads only `overall` + `failures`. Track them explicitly.
    const aborted: Array<{ agentId: string; name?: string }> = []
    for (const m of countable) {
      const s = m.agentStatus ?? 'unknown'
      statusCounts[s]++
      if (s === 'failed') {
        failures.push({
          agentId: m.agentId,
          ...(m.name ? { name: m.name } : {}),
          ...(taskRuntimeStore.get(m.agentId)?.error
            ? { error: taskRuntimeStore.get(m.agentId)!.error }
            : {}),
        })
      } else if (s === 'killed') {
        aborted.push({
          agentId: m.agentId,
          ...(m.name ? { name: m.name } : {}),
        })
      }
    }
    const overall =
      statusCounts.running > 0
        ? failures.length > 0
          ? 'running_with_failures'
          : 'running'
        : failures.length > 0
          ? statusCounts.completed > 0
            ? 'completed_with_failures'
            : 'failed'
          : aborted.length > 0
            ? statusCounts.completed > 0
              ? 'completed_with_aborts'
              : 'aborted'
            : statusCounts.completed > 0
              ? 'completed'
              : 'idle'
    const teamSummary = {
      overall,
      counts: statusCounts,
      memberCount: countable.length,
      ...(failures.length > 0 ? { failures } : {}),
      ...(aborted.length > 0 ? { aborted } : {}),
      ...(snap.coordinationDowngradedFrom
        ? {
            coordination_note: `Launch plan was downgraded from "${snap.coordinationDowngradedFrom}" (not supported in this host); members ran with the downgraded coordination style.`,
          }
        : {}),
    }
    const enriched = {
      ...snap,
      team_summary: teamSummary,
      members: snap.members.map((m) => {
        const ag = getActiveAgent(m.agentId)
        const runtime = taskRuntimeStore.get(m.agentId)
        const runtimeText = runtime?.chunks
          .filter((chunk) => chunk.stream === 'text')
          .map((chunk) => chunk.text)
          .join('')
          .trim()
        const raw = ag?.latestTextOutput?.trim() || runtimeText
        const fullCharCount = raw ? raw.length : 0
        const truncated = fullCharCount > TEAM_STATUS_OUTPUT_PREVIEW
        const preview = truncated
          ? `…${raw!.slice(-TEAM_STATUS_OUTPUT_PREVIEW)}`
          : raw
        return {
          ...m,
          taskOutputTaskId: m.agentId,
          latestTextOutputPreview: preview || undefined,
          ...(fullCharCount > 0
            ? {
                outputTruncated: truncated,
                fullOutputCharCount: fullCharCount,
              }
            : {}),
        }
      }),
    }
    return { success: true, output: JSON.stringify(enriched, null, 2) }
  },
})

export const teamCreateTool = buildTool({
  name: 'TeamCreate',
  zInputSchema: teamCreateInputZod,
  description:
    'Create a multi-agent collaboration team and become its lead. ' +
    'Writes a TeamFile under `.claude/teams/` (lead + members) and registers the team for SendMessage / orchestration. ' +
    'Requires an open workspace folder. ' +
    '\n\n' +
    'IMPORTANT — workflow after TeamCreate:\n' +
    '1) The "lead" of the team is YOU (the calling agent). The returned `lead_agent_id` is an internal TeamFile key — do NOT pass it to SendMessage; you cannot send messages to yourself.\n' +
    '2) Spawn teammates with the Agent tool, passing both `team_name` (this team) and `name` (e.g. "researcher", "tester"). Each spawned member is addressable by its NAME.\n' +
    '3) Communicate with members by NAME via SendMessage: `to: "researcher"` (NOT the agentId). Use `to: "team:<team_name>"` to broadcast to the whole team.\n' +
    '4) Optional: pass `template=<TeamTemplate.id>` from the active Bundle to auto-launch members per the template (solo/parallel/sequential/swarm/coordinator). Progress: `TeamStatus`. Per-member full output: `TaskOutput(task_id=<member.taskOutputTaskId>)`. Set `POLE_TEAM_AUTO_LAUNCH=0` to fall back to LLM-driven spawning.',
  inputSchema: [
    { name: 'team_name', type: 'string', description: 'Name for the new team', required: true },
    { name: 'description', type: 'string', description: 'Team purpose or goal description' },
    { name: 'agent_type', type: 'string', description: 'Lead coordinator agent type (e.g. Coordinator, general-purpose)' },
    { name: 'template', type: 'string', description: 'Optional: TeamTemplate.id from the active Bundle to auto-launch.' },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,
  async call({ team_name, description, agent_type, template }) {
    const workspaceRoot = getWorkspacePath()
    if (!workspaceRoot) {
      return {
        success: false,
        error: 'TeamCreate requires a workspace folder (open a project first).',
      }
    }

    if (!team_name || !team_name.trim()) {
      return { success: false, error: 'team_name is required' }
    }

    let finalName = team_name.trim()
    let suffix = 1
    while (teams.has(finalName)) {
      finalName = `${team_name.trim()}-${suffix}`
      suffix++
    }

    // S4 — upstream-aligned deterministic lead id `team-lead@<team>`.
    // Replaces the pre-S4 `lead-<ts>-<counter>` synthetic which made the
    // lead id look like a sendable target.
    const leadAgentId: AgentId = formatLeadAgentId(finalName)

    const swarmMeta = await buildTeamSwarmMetadataAsync(workspaceRoot, finalName)
    const team: Team = {
      teamName: finalName,
      description: description?.trim(),
      agentType: agent_type?.trim(),
      leadAgentId,
      members: [
        {
          agentId: leadAgentId,
          name: 'lead',
          joinedAt: Date.now(),
          backendType: 'in-process',
          // S7: do NOT mark the lead row as `isActive`. The lead is the
          // calling agent itself (no separate active-agent registry row),
          // not a spawned teammate. Marking it active misled callers
          // (and the model) into believing they could SendMessage to it.
        },
      ],
      createdAt: Date.now(),
      mailbox: {},
      swarmBackend: swarmMeta.swarmBackend,
      teamFilePath: swarmMeta.teamFilePath,
    }

    teams.set(finalName, team)
    await persistTeamFile(workspaceRoot, team)
    patchAgentContextTeamId(finalName)

    // Auto-launch path — enabled by default when `template` is provided.
    // Wires the `runCoordinatorWorkflow` engine to a concrete TeamTemplate
    // from the active bundle. Set POLE_TEAM_AUTO_LAUNCH=0 to disable.
    const templateRef = typeof template === 'string' ? template.trim() : ''
    let autoLaunchSummary: Record<string, unknown> | undefined
    if (templateRef.length > 0) {
      try {
        const { isTeamAutoLaunchEnabled, launchTeamFromTemplateAsync } = await import(
          '../agents/teamAutoLauncher'
        )
        if (isTeamAutoLaunchEnabled()) {
          const bundle = getActiveBundle()
          const matched = bundle?.teams?.find((t) => t.id === templateRef)
          if (!bundle) {
            autoLaunchSummary = {
              status: 'skipped',
              reason: 'no active bundle (template lookup requires an activated bundle)',
            }
          } else if (!matched) {
            autoLaunchSummary = {
              status: 'skipped',
              reason: `template "${templateRef}" not found in active bundle "${bundle.meta.id}"`,
              availableTemplateIds: (bundle.teams || []).map((t) => t.id),
            }
          } else {
            // P0: thread the parent's abort signal through so a user cancel
            // (or main-stream abort) cascades into every auto-launched team
            // member. Without this, the launcher's `parentAbortSignal` plumbing
            // (teamAutoLauncher.ts:562-568) was unreachable from the
            // production caller and team members kept running after the user
            // hit Stop.
            const parentAbortSignal = getAgentContext()?.signal
            const dispatch = launchTeamFromTemplateAsync({
              template: matched,
              teamName: finalName,
              userGoal: description?.trim() || '',
              workspaceRoot,
              leadAgentId,
              ...(parentAbortSignal ? { parentAbortSignal } : {}),
            })
            // Deliberately do NOT await dispatch.completion — auto-launch is
            // asynchronous so the main AI's TeamCreate tool_use returns
            // immediately with the plan preview. Progress is queryable via
            // TeamStatus; per-member output surfaces through TaskOutput.
            void dispatch.completion.catch(() => {
              /* already logged by launcher */
            })
            autoLaunchSummary = {
              status: 'launched',
              // Contract audit (2026-07) — make the optimistic success
              // semantics explicit at the source: `launched` means the plan
              // was DISPATCHED, not that any member finished. Member failures
              // surface later via TeamStatus / TaskOutput (the internal
              // workflow runs with failurePolicy 'continue').
              status_note:
                'Dispatched asynchronously — members are still running (or may fail later). ' +
                'This does NOT mean any member completed. Track progress with TeamStatus; ' +
                'read member output with TaskOutput. Member failures do NOT fail this call.',
              templateId: matched.id,
              templateName: matched.name,
              coordination: dispatch.plan.coordination,
              launchedMembers: dispatch.plan.members.map((m) => ({
                agentType: m.agentType,
                role: m.role ?? null,
                phase: m.phase,
                memberIndex: m.memberIndex,
              })),
              phases: dispatch.plan.phases,
              ...(dispatch.plan.downgradedFrom
                ? { downgradedFrom: dispatch.plan.downgradedFrom }
                : {}),
            }
            // Persist coordination downgrade on the TeamFile so TeamStatus
            // keeps reporting it after this response leaves the context.
            if (dispatch.plan.downgradedFrom) {
              team.coordinationDowngradedFrom = dispatch.plan.downgradedFrom
              await persistTeamFile(workspaceRoot, team)
            }
          }
        } else {
          autoLaunchSummary = {
            status: 'skipped',
            reason: 'POLE_TEAM_AUTO_LAUNCH is disabled (set to 0); template reference recorded but not executed',
            templateRef,
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        autoLaunchSummary = { status: 'error', error: msg, templateRef }
      }
    }

    // Contract audit (2026-07) — the lead-id note must match reality. Two
    // distinct cases previously shared one sentence and created a "who is the
    // lead: me or the first live member?" mental conflict:
    //   - manual path: the lead row is the CALLING agent itself (no live
    //     spawned agent behind the id) → SendMessage(lead id) is meaningless.
    //   - auto-launch path: the launcher deliberately runs the FIRST planned
    //     member under this id so SendMessage can reach a live agent.
    const autoLaunched = autoLaunchSummary?.status === 'launched'
    const leadAgentIdNote = autoLaunched
      ? 'Internal TeamFile key. Because auto-launch is active, the FIRST planned template member runs under this id (a live agent, listed in auto_launch.launchedMembers[0]). Prefer addressing members by NAME via SendMessage; the raw id also resolves to that live member.'
      : 'Internal TeamFile key only. The lead is the calling agent (you). Do NOT pass this id to SendMessage; you cannot send messages to yourself. Address members by NAME.'

    return {
      success: true,
      output: JSON.stringify({
        team_name: finalName,
        lead_agent_id: leadAgentId,
        lead_agent_id_note: leadAgentIdNote,
        lead_role: autoLaunched ? 'first-live-member' : 'caller',
        team_file: getTeamFilePath(workspaceRoot, finalName),
        swarm_backend: team.swarmBackend,
        external_swarm_available: await isExternalSwarmBackendAvailableAsync(),
        description: team.description || '',
        message: autoLaunched
          ? `Team "${finalName}" created; TeamFile written under .claude/teams/. Template plan dispatched — members are running in the background and are NOT done yet.`
          : `Team "${finalName}" created; TeamFile written under .claude/teams/.`,
        next_steps: [
          `Spawn members with the Agent tool: pass team_name="${finalName}" and a name (e.g. "researcher", "tester").`,
          'Send messages by NAME: SendMessage({to:"<member_name>", message:"..."}).',
          `Broadcast: SendMessage({to:"team:${finalName}", message:"..."}).`,
          `Inspect progress: TeamStatus({team_name:"${finalName}"}). Read full member output: TaskOutput({task_id:"<member.taskOutputTaskId>"}).`,
        ],
        ...(autoLaunchSummary ? { auto_launch: autoLaunchSummary } : {}),
      }),
    }
  },
})
