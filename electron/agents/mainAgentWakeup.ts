/**
 * Main-agent wake-up signal (audit 2026-06 — "spawn → main turn ends →
 * results never reach the main agent" gap).
 *
 * Problem this closes: when the main agent dispatches background
 * sub-agents (or a team) and then ends its own turn, every result
 * channel back to it is PULL-based — the `post_tool` collectors only
 * run while the main loop is alive, and the `streamHandler` entry
 * injection only runs on the next USER message. Nothing re-triggered
 * the main agent, so finished work sat invisible (and idle team
 * members waited in their mailbox loop until the 30-minute timeout
 * marked them failed).
 *
 * The renderer already has a guarded auto-continuation controller
 * (`src/stores/chat/autoResumeBackgroundTasks.ts`: idle check, draft
 * protection, pending-gate check, debounce, rolling cap). It was only
 * wired to backgrounded SHELL task completions
 * (`background-task-completed`). This module gives the agent subsystem
 * its own trigger on the same stream channel:
 *
 *   - {@link requestSubAgentTerminalWake}    — a background sub-agent
 *     (or team member run) reached a terminal state.
 *   - {@link requestTeamMemberIdleWake}      — a team member finished
 *     its current work and entered the idle mailbox wait (it is NOT
 *     terminal — it idles for new assignments; the lead must be woken
 *     to read the result / assign more work / wind the team down).
 *
 * Both emit a `subagent-terminal-wake` stream event; the renderer
 * controller treats it exactly like `background-task-completed`. All
 * safety guards (idle-only, cap, debounce) live renderer-side — this
 * module is a fire-and-forget signal, never a driver.
 */

export interface SubAgentWakePayload {
  agentId: string
  /** 'completed' | 'failed' for terminal wakes; 'idle' for team-member idle. */
  status: 'completed' | 'failed' | 'idle'
  /** Optional team for observability. */
  teamName?: string
}

/**
 * Agents that have entered the idle mailbox wait (team members that finished
 * their current assignment and are alive waiting for the lead). They are still
 * `status: 'running'` in the registry, so {@link countOutstandingActiveAgents}
 * must explicitly EXCLUDE them — otherwise the renderer cohort-gate would never
 * see the cohort "settle" and a team's lead would never be woken to read
 * results / wind the team down. An agent leaves this set when it terminates.
 */
const idleAgents = new Set<string>()

/**
 * Count background agents still ACTIVELY working — registry status `running`
 * AND not parked in the idle mailbox wait. This is the renderer auto-resume
 * cohort-gate signal: a resume should only fire once this reaches 0 (the whole
 * spawned cohort has either gone idle or terminated), so the main agent is not
 * woken mid-flight while siblings are still producing results.
 *
 * Lazy-require the registry to keep this module importable in vitest suites
 * with no Electron runtime (same rationale as the `mainWindow` require below).
 */
function countOutstandingActiveAgents(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy to stay vitest-safe
    const { getActiveAgents } = require('./activeAgentRegistry') as typeof import('./activeAgentRegistry')
    let n = 0
    for (const [id, a] of getActiveAgents()) {
      if (a.status === 'running' && !idleAgents.has(id)) n++
    }
    return n
  } catch {
    return 0
  }
}

/** @internal test seam — captures the last emitted wake payloads. */
export const __emittedWakesForTests: Array<Record<string, unknown>> = []

function emitWake(payload: SubAgentWakePayload): void {
  const event = {
    type: 'subagent-terminal-wake',
    agentId: payload.agentId,
    status: payload.status,
    // Cohort-gate signal for the renderer auto-resume controller (see
    // `src/stores/chat/autoResumeBackgroundTasks.ts`): how many background
    // agents are STILL actively working after this wake. 0 ⇒ the cohort has
    // settled and a single resume is safe.
    outstandingActiveAgents: countOutstandingActiveAgents(),
    ...(payload.teamName ? { teamName: payload.teamName } : {}),
  }
  if (process.env.VITEST && __emittedWakesForTests.length < 100) {
    __emittedWakesForTests.push(event)
  }
  try {
    // Lazy-require keeps `electron` out of this module's static import
    // graph — same pattern as `notificationSystem.maybeEmitBackgroundCompleted`.
    // `subAgentRunner` / `agentTool` are imported by many vitest suites
    // that have no Electron runtime; a static `window/mainWindow` import
    // here would crash them at module load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy electron dependency
    const { sendToMainWindow } = require('../window/mainWindow') as typeof import('../window/mainWindow')
    sendToMainWindow('ai:stream-event', event)
  } catch {
    /* wake is a convenience signal — never let it break the caller */
  }
}

/** A background sub-agent finished (success or failure). */
export function requestSubAgentTerminalWake(args: {
  agentId: string
  success: boolean
  teamName?: string
}): void {
  // Terminal: no longer idle-waiting. Remove BEFORE counting so the outstanding
  // figure reflects the post-termination cohort.
  idleAgents.delete(args.agentId)
  emitWake({
    agentId: args.agentId,
    status: args.success ? 'completed' : 'failed',
    ...(args.teamName ? { teamName: args.teamName } : {}),
  })
}

/** A team member finished its current work and entered the idle mailbox wait. */
export function requestTeamMemberIdleWake(args: {
  agentId: string
  teamName: string
}): void {
  // Mark idle BEFORE counting so this member is excluded from the outstanding
  // figure — it has settled (waiting for the lead), it is not active work.
  idleAgents.add(args.agentId)
  emitWake({ agentId: args.agentId, status: 'idle', teamName: args.teamName })
}

/**
 * @internal test seam — reset the idle-tracking set between unit tests so a
 * leftover idle member from one case doesn't skew another's outstanding count.
 */
export function __resetIdleAgentsForTests(): void {
  idleAgents.clear()
}
