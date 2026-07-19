/**
 * Team Auto-Launcher — the "sleeping engine" wake-up for Bundle.teams.
 *
 * Context: a Bundle's `teams: TeamTemplate[]` is today only rendered into the
 * main AI's system prompt as a markdown roster ("here are the coordination
 * templates available in this bundle"). The actual spawn of members is left
 * entirely to the LLM — it must call `TeamCreate` AND then individually call
 * `Agent(subagent_type=X)` for each member, while mentally tracking the
 * `coordination` (parallel / sequential / swarm / coordinator) order.
 *
 * This module takes the TemplateTemplate from the active bundle and turns it
 * into a concrete execution plan fed to the (previously idle)
 * `runCoordinatorWorkflow` engine — so the orchestrator, not the LLM, owns
 * the fan-out / ordering / aggregation.
 *
 * Scope of this first cut:
 *   - **solo** / **parallel** / **sequential** / **coordinator** are fully
 *     executed. **swarm** is downgraded to parallel — swarm coordination
 *     requires a distributed agent mesh with dynamic peer discovery and
 *     unstructured fan-out, which is not practical in a single-process
 *     Electron host. The downgrade is surfaced via `downgradedFrom: 'swarm'`
 *     on the launch plan so callers and UIs can communicate this to users.
 *   - Launch is **always asynchronous** — TeamCreate returns immediately after
 *     the plan is dispatched; progress is observable via the existing
 *     `TeamStatus` / `TaskOutput` / SendMessage surfaces.
 *   - Every member goes to the same `teamName` created by TeamCreate, so the
 *     TeamFile mailbox already wired by `TeamCreateTool.ensureTeamMember`
 *     works transparently.
 *
 * Team auto-launch is **enabled by default** since v3.2. Set
 * `POLE_TEAM_AUTO_LAUNCH=0` to disable and fall back to LLM-driven spawning.
 */

import type { TeamCoordination, TeamTemplate } from './bundles/types'
import type { CoordinatorPhase, SubAgentEvent, SubAgentResult } from './types'
import { findAgentDefinition, runSubAgent, READONLY_AGENT_TYPES } from './subAgentRunner'
import { getAgentContext } from './agentContext'
import { runCoordinatorWorkflow, type CoordinatorTask } from './coordinatorMode'
import { ensureTeamMember } from '../tools/TeamCreateTool'
import { getAllAgentDefinitions } from '../tools/registry'
import { asAgentId, type AgentId } from '../tools/ids'
import { emitSessionDebugLog } from '../debugSessionLog'
import { getMultiAgentOrchestrator } from './multiAgentOrchestratorSingleton'
import { getActiveAgent } from './activeAgentRegistry'
import {
  trackAgentInOrchestrator,
  unspawnAndUntrackAgent,
} from './agentLifecycle'
import { taskRuntimeStore } from '../tools/TaskRuntimeStore'
import { emitSubAgentStreamEvent } from './agentTool'
import {
  registerBackgroundAgent,
  completeAgentTask,
  failAgentTask,
} from '../tools/tasks/AgentTaskManager'
import { getTaskState } from '../tools/tasks/taskStateManager'

// ============================================================
// Feature flag — default ON; opt-out via env
// ============================================================

const AUTO_LAUNCH_ENV_KEYS = ['POLE_TEAM_AUTO_LAUNCH', 'ASTRA_TEAM_AUTO_LAUNCH'] as const
export const TEAM_AUTO_LAUNCH_MEMBER_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.POLE_TEAM_AUTO_LAUNCH_MEMBER_TIMEOUT_MS ?? '1800000'),
)

/**
 * Monotonic counter for synthesised team-member kernel ids. Same pattern as
 * `subAgentRunner.generateAgentId()` but local to the launcher so we can
 * stamp the orchestrator-side id BEFORE calling `runSubAgent` (which
 * generates its own id internally if none is supplied).
 */
let teamMemberIdCounter = 0
function generateTeamMemberAgentId(): string {
  teamMemberIdCounter++
  return `team-member-${Date.now()}-${teamMemberIdCounter}`
}

export function isTeamAutoLaunchEnabled(): boolean {
  for (const k of AUTO_LAUNCH_ENV_KEYS) {
    const v = process.env[k]?.trim().toLowerCase()
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
    if (v === '1' || v === 'true' || v === 'yes') return true
  }
  // Default: enabled
  return true
}

// ============================================================
// Plan types — pure, testable
// ============================================================

/** One concrete spawn the launcher will perform (one call to `runSubAgent`). */
export interface PlannedTeamMember {
  /** Canonical agentType string (matches AgentDefinition.agentType). */
  agentType: string
  /** Optional free-form role from the TemplateMember (e.g. "reviewer"). */
  role?: string
  /** Synthesised prompt for this member's sub-agent. */
  prompt: string
  /** Phase key used by `runCoordinatorWorkflow` — ordering is by insertion. */
  phase: CoordinatorPhase
  /**
   * Index within the template's `members` array, preserved so telemetry and
   * tests can match launched members back to the source template without
   * relying on agentType (which may repeat).
   */
  memberIndex: number
}

export interface TeamLaunchPlan {
  templateId: string
  templateName: string
  coordination: TeamCoordination
  members: PlannedTeamMember[]
  /** Ordered list of phase keys the coordinator workflow will walk. */
  phases: CoordinatorPhase[]
  /** Concurrency ceiling passed to `runCoordinatorWorkflow`. */
  maxParallel: number
  /** Fallback note emitted when we had to downgrade (e.g. swarm → parallel). */
  downgradedFrom?: TeamCoordination
}

// ============================================================
// Plan builder — pure function, testable in isolation
// ============================================================

/**
 * Map a `TeamTemplate` to an execution plan. `userGoal` is the original
 * intent the main AI passed to `TeamCreate`; it's embedded in every member's
 * prompt so sub-agents know the big picture without a separate briefing hop.
 *
 * Coordination policies:
 *   - **solo**: first member only, 1 phase.
 *   - **parallel**: all members, 1 phase, maxParallel = members.length.
 *   - **sequential** without `parallelGroup`: N phases (stage-0..N-1), 1
 *     member per phase.
 *   - **sequential** with `parallelGroup`: phases grouped by
 *     `parallelGroup`, same-group members run in parallel within that phase.
 *   - **coordinator**: phase 0 = single member flagged by `role: 'coordinator'`
 *     (or the first member if no such flag); phase 1 = the rest in parallel.
   *   - **swarm**: downgraded to `parallel` (swarm requires a distributed agent mesh with dynamic peer discovery not feasible in single-process Electron). The downgrade is recorded in `downgradedFrom` on the plan for UI surfacing.
 */
export function buildTeamLaunchPlan(
  template: TeamTemplate,
  userGoal: string,
  /**
   * Runtime team key registered via `TeamCreate`. Threaded through the
   * member prompts so the model is told to broadcast on the *live* team
   * file (audit BUG-007). Falls back to `template.id` when omitted so
   * legacy callers still get a working broadcast hint.
   */
  teamName?: string,
): TeamLaunchPlan {
  const allMembers = Array.isArray(template.members) ? template.members : []
  const normalizedMembers = allMembers.filter(
    (m) => typeof m.agentType === 'string' && m.agentType.trim().length > 0,
  )

  const effectiveCoordination: TeamCoordination =
    template.coordination === 'swarm' ? 'parallel' : template.coordination
  const downgradedFrom: TeamCoordination | undefined =
    template.coordination === 'swarm' ? 'swarm' : undefined

  if (normalizedMembers.length === 0) {
    return {
      templateId: template.id,
      templateName: template.name,
      coordination: effectiveCoordination,
      members: [],
      phases: [],
      maxParallel: 1,
      ...(downgradedFrom ? { downgradedFrom } : {}),
    }
  }

  // Audit BUG-007: SendMessage / TeamStatus must reference the *live* team
  // key registered by TeamCreate, not the design-time template id/name. Fall
  // back to template values only when no runtime name was supplied (test /
  // legacy callers).
  const liveTeamKey = teamName?.trim() || template.id
  const liveTeamDisplay = teamName?.trim() || template.name
  const mkPrompt = (agentType: string, role: string | undefined, peers: string[]): string => {
    // Read-only async agents (`Explore` / `Plan` / `Verification`) have
    // `SendMessage` + `TeamCreate` in their disallowedTools and
    // `TeamStatus` is not in `ASYNC_AGENT_ALLOWED_TOOLS` — so the
    // previous "Use SendMessage(...) / TeamStatus(...)" lines below
    // were instructions to call tools the agent literally cannot see.
    // The model would either skip the lines (best case) or attempt the
    // call and stall on the "unknown tool" retry loop (worst case,
    // which presented as a permanent "...; booting..." for the
    // research-plan-verify Explore stage). For read-only members we
    // therefore replace the share-progress section with a plain
    // "return your final report" instruction; for everyone else the
    // mailbox/status hint stands.
    const isReadOnly = READONLY_AGENT_TYPES.has(agentType)
    const shareProgressLines = isReadOnly
      ? [
          `## How to share progress`,
          `You do not have SendMessage / TeamStatus / TeamCreate in your tool surface — that is intentional for read-only roles.`,
          `Return your concise final report as the answer to this turn; the orchestrator aggregates the results across phases and your peers will read it via TaskOutput.`,
        ]
      : [
          `## How to share progress`,
          `Use \`SendMessage(to: "team:${liveTeamKey}", message: "...")\` to broadcast findings your peers need.`,
          `Use \`TeamStatus(team_name: "${liveTeamKey}")\` if you need to check who's online.`,
          `Return a concise final answer when your role is done — the orchestrator aggregates results.`,
        ]
    const lines: string[] = [
      `You are running as the "${role ?? agentType}" role on team "${liveTeamDisplay}".`,
      '',
      `## Team goal`,
      userGoal.trim() || '(no goal provided — ask the user to clarify before proceeding)',
      '',
      `## This team's coordination style`,
      `${template.coordination}${downgradedFrom ? ` (downgraded from ${downgradedFrom})` : ''}`,
      '',
      `## Your peers on this team`,
      peers.length === 0 ? '(you are the only member)' : peers.map((p) => `- ${p}`).join('\n'),
      '',
      ...shareProgressLines,
    ]
    return lines.join('\n')
  }

  const peerLabels = normalizedMembers.map(
    (m, i) => `${m.role ?? m.agentType}${i === 0 ? '' : ''}`,
  )
  // Build a (role | agentType) label list for the per-member "peers" section,
  // excluding the member being described.
  const peersFor = (excludeIdx: number): string[] =>
    peerLabels.filter((_l, i) => i !== excludeIdx)

  // ---------- solo ----------
  if (effectiveCoordination === 'solo') {
    const first = normalizedMembers[0]!
    const member: PlannedTeamMember = {
      agentType: first.agentType,
      ...(first.role ? { role: first.role } : {}),
      prompt: mkPrompt(first.agentType, first.role, peersFor(0)),
      phase: 'research',
      memberIndex: 0,
    }
    return {
      templateId: template.id,
      templateName: template.name,
      coordination: effectiveCoordination,
      members: [member],
      phases: ['research'],
      maxParallel: 1,
      ...(downgradedFrom ? { downgradedFrom } : {}),
    }
  }

  // ---------- parallel ----------
  if (effectiveCoordination === 'parallel') {
    const members: PlannedTeamMember[] = normalizedMembers.map((m, i) => ({
      agentType: m.agentType,
      ...(m.role ? { role: m.role } : {}),
      prompt: mkPrompt(m.agentType, m.role, peersFor(i)),
      phase: 'research',
      memberIndex: i,
    }))
    return {
      templateId: template.id,
      templateName: template.name,
      coordination: effectiveCoordination,
      members,
      phases: ['research'],
      maxParallel: Math.max(1, members.length),
      ...(downgradedFrom ? { downgradedFrom } : {}),
    }
  }

  // ---------- coordinator ----------
  if (effectiveCoordination === 'coordinator') {
    const coordIdx = normalizedMembers.findIndex((m) => m.role === 'coordinator')
    const leadIdx = coordIdx >= 0 ? coordIdx : 0
    const lead = normalizedMembers[leadIdx]!

    const leadMember: PlannedTeamMember = {
      agentType: lead.agentType,
      ...(lead.role ? { role: lead.role } : {}),
      prompt: mkPrompt(lead.agentType, lead.role ?? 'coordinator', peersFor(leadIdx)),
      phase: 'research',
      memberIndex: leadIdx,
    }

    const peerMembers: PlannedTeamMember[] = []
    normalizedMembers.forEach((m, absoluteIdx) => {
      if (absoluteIdx === leadIdx) return
      peerMembers.push({
        agentType: m.agentType,
        ...(m.role ? { role: m.role } : {}),
        prompt: mkPrompt(m.agentType, m.role, peersFor(absoluteIdx)),
        phase: 'implementation',
        memberIndex: absoluteIdx,
      })
    })

    const members = [leadMember, ...peerMembers]
    return {
      templateId: template.id,
      templateName: template.name,
      coordination: effectiveCoordination,
      members,
      phases: peerMembers.length > 0 ? ['research', 'implementation'] : ['research'],
      maxParallel: Math.max(1, peerMembers.length || 1),
      ...(downgradedFrom ? { downgradedFrom } : {}),
    }
  }

  // ---------- sequential (with optional parallelGroup) ----------
  // Group by parallelGroup; members without one each form a singleton group
  // at their insertion index. Result: ordered groups → phases, same-group →
  // same phase (parallel within).
  const groupsByKey = new Map<number, Array<{ member: PlannedTeamMember; rawIdx: number }>>()
  const standaloneGroups: Array<{ member: PlannedTeamMember; rawIdx: number }> = []
  normalizedMembers.forEach((m, i) => {
    const pm: PlannedTeamMember = {
      agentType: m.agentType,
      ...(m.role ? { role: m.role } : {}),
      prompt: mkPrompt(m.agentType, m.role, peersFor(i)),
      phase: 'research', // placeholder; overwritten below
      memberIndex: i,
    }
    if (typeof m.parallelGroup === 'number' && Number.isFinite(m.parallelGroup)) {
      const key = m.parallelGroup
      const arr = groupsByKey.get(key) ?? []
      arr.push({ member: pm, rawIdx: i })
      groupsByKey.set(key, arr)
    } else {
      standaloneGroups.push({ member: pm, rawIdx: i })
    }
  })

  // Order: groups by ascending `parallelGroup` key first, then standalone
  // groups in their original member-array order. Callers who care about the
  // interleaving can set `parallelGroup` explicitly.
  const orderedGroups: Array<Array<{ member: PlannedTeamMember; rawIdx: number }>> = []
  for (const key of [...groupsByKey.keys()].sort((a, b) => a - b)) {
    orderedGroups.push(groupsByKey.get(key)!)
  }
  for (const sg of standaloneGroups) {
    orderedGroups.push([sg])
  }

  const phases: CoordinatorPhase[] = []
  const flatMembers: PlannedTeamMember[] = []
  let maxGroupSize = 1
  orderedGroups.forEach((group, gi) => {
    const phaseKey: CoordinatorPhase = `stage-${gi}`
    phases.push(phaseKey)
    maxGroupSize = Math.max(maxGroupSize, group.length)
    for (const { member } of group) {
      flatMembers.push({ ...member, phase: phaseKey })
    }
  })

  return {
    templateId: template.id,
    templateName: template.name,
    coordination: effectiveCoordination,
    members: flatMembers,
    phases,
    maxParallel: maxGroupSize,
    ...(downgradedFrom ? { downgradedFrom } : {}),
  }
}

// ============================================================
// Runtime launcher — wires plan to runCoordinatorWorkflow + runSubAgent
// ============================================================

export interface LaunchTeamFromTemplateParams {
  /** The matched TeamTemplate from the active bundle. */
  template: TeamTemplate
  /**
   * Name of the team registered with `TeamCreate` (TeamFile under
   * `.claude/teams/`). All launched members are registered as members of this
   * team via `ensureTeamMember`.
   */
  teamName: string
  /** The original user intent / description passed to `TeamCreate`. */
  userGoal: string
  /** Workspace root (from `getWorkspacePath()` at call site). */
  workspaceRoot: string
  /**
   * Optional TeamFile lead id created by TeamCreate. When supplied, the first
   * planned member runs under this id so SendMessage(lead_agent_id) reaches a
   * live agent instead of a TeamFile-only placeholder.
   */
  leadAgentId?: AgentId
  /**
   * Optional abort signal that cascades into every spawned member. When the
   * main chat's tool-stop fires, the whole team should terminate.
   */
  parentAbortSignal?: AbortSignal
  /**
   * Injected sub-agent executor — default uses the production `runSubAgent`
   * path. Tests pass a stub to avoid spinning up real LLM calls.
   */
  executor?: (task: PlannedTeamMemberLaunchRequest) => Promise<SubAgentResult>
}

export interface PlannedTeamMemberLaunchRequest {
  plan: TeamLaunchPlan
  member: PlannedTeamMember
  teamName: string
  workspaceRoot: string
  abortSignal: AbortSignal
  agentIdOverride?: AgentId
}

export interface LaunchTeamFromTemplateResult {
  /** The resolved execution plan, returned so callers can surface telemetry. */
  plan: TeamLaunchPlan
  /** Number of members successfully dispatched (may be < plan.members.length if spawn failed early). */
  launchedCount: number
  /**
   * Promise resolving when ALL dispatched members finish. Callers (e.g.
   * TeamCreateTool) typically DO NOT await this — progress is observable via
   * `TeamStatus`, and the TaskOutput stream; awaiting would block the
   * TeamCreate tool call for the whole multi-agent run (≥ minutes).
   */
  completion: Promise<ReadonlyArray<SubAgentResult>>
}

/**
 * Default executor — spawns one sub-agent via the production `runSubAgent`.
 * Non-test callers use this implicitly; test suites inject a lightweight
 * stub to avoid real model calls.
 */
async function defaultMemberExecutor(
  req: PlannedTeamMemberLaunchRequest,
): Promise<SubAgentResult> {
  // Enforce concurrency ceiling for team auto-launch spawns.
  const orchestrator = getMultiAgentOrchestrator()
  const parentKernelId = getAgentContext()?.agentId ? String(getAgentContext()!.agentId) : 'main-chat'
  try {
    orchestrator.enforceConcurrencyLimit(parentKernelId)
  } catch (ceilingErr) {
    const msg = ceilingErr instanceof Error ? ceilingErr.message : String(ceilingErr)
    return {
      success: false,
      agentId: asAgentId(`team-member-ceiling-${Date.now()}`),
      agentType: req.member.agentType,
      output: msg,
      totalTokens: 0,
      totalDurationMs: 0,
      totalToolUses: 0,
    }
  }

  const parentCtx = getAgentContext()
  if (!parentCtx) {
    // No parent ALS context (e.g. called from a non-agentic IPC path).
    // Return a synthetic failure instead of throwing — callers already
    // emit a warning above.
    return {
      success: false,
      agentId: asAgentId(`team-member-no-ctx-${Date.now()}`),
      agentType: req.member.agentType,
      output: 'Team auto-launch requires an active AgentContext — not invoked from a chat turn.',
      totalTokens: 0,
      totalDurationMs: 0,
      totalToolUses: 0,
    }
  }

  const agentDef = findAgentDefinition(req.member.agentType, getAllAgentDefinitions())
  if (!agentDef) {
    return {
      success: false,
      agentId: asAgentId(`team-member-unknown-${Date.now()}`),
      agentType: req.member.agentType,
      output: `Unknown agentType "${req.member.agentType}" in team template.`,
      totalTokens: 0,
      totalDurationMs: 0,
      totalToolUses: 0,
    }
  }
  const agentDefForRun =
    agentDef.timeout === undefined
      ? ({ ...agentDef, timeout: TEAM_AUTO_LAUNCH_MEMBER_TIMEOUT_MS } as typeof agentDef)
      : agentDef

  // ── P0: orchestrator registration parity with `agentTool.ts:551-569` ──
  //
  // Without this, team auto-launch members were a black hole for the
  // MultiAgentOrchestrator: they never landed in `children.get(parent)`
  // so `enforceConcurrencyLimit` (called above) was checking a count that
  // could not include this very spawn — a 5-member template would sail
  // past `maxConcurrentChildren=4` because every member saw the count as
  // whatever the *other* (non-team) call paths had registered.
  //
  // We synthesise the kernel id BEFORE `runSubAgent` so the orchestrator
  // edge exists for the entire lifetime of the spawn. Pass that id in via
  // `agentIdOverride` so `runSubAgent`'s internal `ActiveAgent` registry
  // and the orchestrator share the same key — that's what makes
  // `interruptTree(parent)` actually find this child.
  //
  // The bridge `AbortController` lets the orchestrator's interrupt path
  // (`shim.interrupt() → controller.abort()`) flow into `runSubAgent`'s
  // `signal` parameter. We also mirror the team-level `req.abortSignal`
  // into it so the team-wide cancel still propagates after a member
  // is registered.
  const memberAgentIdStr = req.agentIdOverride ?? generateTeamMemberAgentId()
  const memberAgentId = asAgentId(memberAgentIdStr)

  const memberAbortController = new AbortController()
  if (req.abortSignal) {
    if (req.abortSignal.aborted) {
      memberAbortController.abort()
    } else {
      req.abortSignal.addEventListener(
        'abort',
        () => {
          if (!memberAbortController.signal.aborted) memberAbortController.abort()
        },
        { once: true },
      )
    }
  }

  // Add the orchestrator edge ONLY — team members get their `ActiveAgent`
  // registered later by `runSubAgent`'s ephemeral-register branch (via the
  // `agentIdOverride` we pass below). Routing through the facade keeps
  // teardown symmetric with the other spawn paths via `unspawnAndUntrackAgent`.
  const orchestratorKernelId = String(memberAgentId)
  const orchTrack = trackAgentInOrchestrator({
    agentId: memberAgentId,
    agentType: agentDefForRun.agentType,
    abortController: memberAbortController,
    parentAgentId: parentKernelId,
    ...(parentCtx.streamConversationId
      ? { conversationId: String(parentCtx.streamConversationId) }
      : {}),
  })
  // Bookkeeping must never sink the spawn — log and continue (legacy policy).
  if (!orchTrack.ok) {
    console.warn('[teamAutoLauncher] orchestrator.register failed:', orchTrack.error)
  }
  const registeredWithOrchestrator = orchTrack.ok

  // P0 (audit 6b): also register the member with the V2 `taskStateManager`
  // (LocalAgentTask). Without this, `TaskStop` / `KillAgentTasks` /
  // `KillAllTasks` go through the dispatcher's `getTaskState` lookup, miss
  // the run entirely (it only lived in `activeAgentRegistry` and
  // `MultiAgentOrchestrator`), and return "Task not found". Aborting via
  // this path delegates to `killAgentTask` which calls `controller.abort()`
  // on the very same `memberAbortController` we created above — so the
  // signal flows uniformly into `runSubAgent.signal → bridgeAc →
  // effectiveLoopSignal` (in-process AND worker, after fix 6a).
  let registeredAsLocalAgentTask = false
  try {
    registerBackgroundAgent({
      taskId: memberAgentIdStr,
      agentId: memberAgentId,
      prompt: req.member.prompt,
      agentType: agentDefForRun.agentType,
      abortController: memberAbortController,
    })
    registeredAsLocalAgentTask = true
  } catch (err) {
    console.warn('[teamAutoLauncher] registerBackgroundAgent failed:', err)
  }

  let runResult: SubAgentResult | undefined
  let runError: unknown
  try {
    runResult = await runSubAgent({
      config: parentCtx.config,
      model: parentCtx.model,
      agentDef: agentDefForRun,
      prompt: req.member.prompt,
      name: req.member.role ?? agentDefForRun.agentType,
      teamName: req.teamName,
      agentIdOverride: memberAgentIdStr,
      signal: memberAbortController.signal,
      onEvent: (event: SubAgentEvent): void => {
        mirrorTeamMemberRuntimeEvent(event)
        // P0 — forward to the renderer's sub-agent IPC channel so the UI
        // sees live text/tool/complete deltas (mirrors what `agentTool.ts`
        // wires for background sub-agents, and what `skillForkRunner.ts`
        // wires for skill forks). Without this hop, team-auto-launched
        // members only show their initial "...; booting..." meta line in
        // the renderer (taskRuntimeStore is updated via
        // `mirrorTeamMemberRuntimeEvent` but never flushed to the chat
        // UI), giving the impression that the agent is stuck in a
        // permanent boot. `emitSubAgentStreamEvent` is also what feeds
        // the parent's `<system-reminder>` injection buffer and the
        // `recordSubAgentTextForParent` path that powers `TeamStatus`'s
        // `latestTextOutputPreview` for parents observing via the
        // standard agent-stream pipe.
        try {
          emitSubAgentStreamEvent(event)
        } catch {
          /* renderer dispatch is best-effort; never sink the member run */
        }
        // Relay into the session debug log so UI / test observers can see which
        // template-driven member fired which event. Kept lightweight — the
        // renderer still gets its normal SubAgent stream via subAgentRunner.
        try {
          emitSessionDebugLog({
            kind: 'team_auto_launch_event',
            teamName: req.teamName,
            templateId: req.plan.templateId,
            memberIndex: req.member.memberIndex,
            eventType: event.type,
          })
        } catch {
          /* non-fatal */
        }
      },
    })
    return runResult
  } catch (err) {
    runError = err
    throw err
  } finally {
    if (registeredWithOrchestrator) {
      // `unspawnAndUntrackAgent` drops the orchestrator edge (via the unified
      // orchestrator path so any tools still in flight under this kernel
      // also get aborted — mirrors prior `agentTool.ts:693 / :847` cleanup)
      // AND tries to drop the registry entry. The latter is a best-effort
      // no-op when `runSubAgent` has already unregistered its ephemeral
      // ActiveAgent.
      unspawnAndUntrackAgent(orchestratorKernelId)
    }
    // P0 (audit 6b): finalize the V2 LocalAgentTask state so subsequent
    // `TaskList`/`TaskStop` calls reflect terminal status. Skip when the
    // dispatcher already marked it `killed` (e.g. an external `TaskStop`
    // raced ahead of natural completion) so we don't clobber `killed` →
    // `completed` and lose the user-initiated abort record.
    if (registeredAsLocalAgentTask) {
      try {
        const state = getTaskState(memberAgentIdStr)
        const isAlreadyTerminal =
          state !== undefined &&
          state.status !== 'running' &&
          state.status !== 'pending'
        if (!isAlreadyTerminal) {
          if (runError !== undefined) {
            const msg = runError instanceof Error ? runError.message : String(runError)
            failAgentTask(memberAgentIdStr, msg)
          } else if (runResult && !runResult.success) {
            const msg =
              typeof runResult.error === 'string' && runResult.error.trim()
                ? runResult.error
                : (runResult.output?.slice(0, 200) || 'team member did not complete cleanly')
            failAgentTask(memberAgentIdStr, msg)
          } else {
            const summary = runResult?.output?.slice(0, 200) || undefined
            completeAgentTask(memberAgentIdStr, summary)
          }
        }
      } catch (err) {
        console.warn('[teamAutoLauncher] task state finalization failed:', err)
      }
    }
  }
}

const TEAM_MEMBER_TEXT_PREVIEW_MAX = 200_000

function appendLatestTeamMemberText(agentId: AgentId, text: string): void {
  const active = getActiveAgent(agentId)
  if (!active || !text) return
  let next = (active.latestTextOutput ?? '') + text
  if (next.length > TEAM_MEMBER_TEXT_PREVIEW_MAX) {
    next = next.slice(-TEAM_MEMBER_TEXT_PREVIEW_MAX)
  }
  active.latestTextOutput = next
}

function mirrorTeamMemberRuntimeEvent(event: SubAgentEvent): void {
  const agentId = event.agentId
  if (!agentId) return

  try {
    if (event.type === 'subagent_start') {
      taskRuntimeStore.start(agentId, 'agent')
      taskRuntimeStore.append(
        agentId,
        'meta',
        `Team member dispatched (agentType=${event.agentType}, id=${agentId}); booting...\n`,
      )
      return
    }

    if (event.type === 'subagent_text') {
      // Audit 2026-06 — DO NOT append here. The launcher's onEvent also
      // calls `emitSubAgentStreamEvent`, whose `recordSubAgentTextForParent`
      // already appends every text delta to BOTH `taskRuntimeStore` and
      // `ActiveAgent.latestTextOutput`. Appending here too doubled every
      // team member's streamed text in the TaskOutput view and in the
      // parent-context injection buffer.
      return
    }

    if (event.type === 'subagent_error') {
      const msg = event.error || 'sub-agent error'
      taskRuntimeStore.markFailed(agentId, msg)
      const active = getActiveAgent(agentId)
      if (active) active.terminalError = msg
      return
    }

    if (event.type === 'subagent_complete') {
      const result = event.result
      const record = taskRuntimeStore.get(agentId)
      const hasText = record?.chunks.some((chunk) => chunk.stream === 'text') === true
      if (!hasText && result.output?.trim()) {
        taskRuntimeStore.append(agentId, 'text', result.output)
        appendLatestTeamMemberText(agentId, result.output)
      }
      taskRuntimeStore.append(
        agentId,
        'meta',
        `Team member ${agentId} finished (durationMs=${result.totalDurationMs}, tokens=${result.totalTokens}, toolUses=${result.totalToolUses}).\n`,
      )
      if (result.success) {
        taskRuntimeStore.markCompleted(agentId)
      } else {
        taskRuntimeStore.markFailed(
          agentId,
          typeof result.error === 'string' && result.error.trim()
            ? result.error
            : `Team member ${agentId} did not complete cleanly`,
        )
      }
    }
  } catch {
    // Runtime mirroring is observability only; never sink the team run.
  }
}

/**
 * Dispatch a team template asynchronously. Returns immediately after the
 * workflow is scheduled; does NOT await member completion.
 */
export function launchTeamFromTemplateAsync(
  params: LaunchTeamFromTemplateParams,
): LaunchTeamFromTemplateResult {
  const { template, teamName, userGoal, workspaceRoot, parentAbortSignal, leadAgentId } = params
  const plan = buildTeamLaunchPlan(template, userGoal, teamName)

  if (plan.members.length === 0) {
    return {
      plan,
      launchedCount: 0,
      completion: Promise.resolve([]),
    }
  }

  // One abort controller for the whole team run — cascaded from parent.
  const teamAbort = new AbortController()
  if (parentAbortSignal) {
    if (parentAbortSignal.aborted) {
      teamAbort.abort()
    } else {
      parentAbortSignal.addEventListener('abort', () => teamAbort.abort(), { once: true })
    }
  }

  const executor = params.executor ?? defaultMemberExecutor

  // Map PlannedTeamMember[] → CoordinatorTask[] so the coordinator engine
  // drives phase ordering + parallel fan-out. The engine's `execute` arg is
  // our thin bridge into `runSubAgent`.
  const tasks: CoordinatorTask[] = plan.members.map((m) => ({
    id: `${template.id}:${m.memberIndex}:${m.agentType}`,
    phase: m.phase,
    label: `${template.name} / ${m.role ?? m.agentType}`,
    prompt: m.prompt,
    ...(m.agentType ? { subagentType: m.agentType } : {}),
  }))

  const completion = (async (): Promise<ReadonlyArray<SubAgentResult>> => {
    const results: SubAgentResult[] = []
    try {
      const state = await runCoordinatorWorkflow(
        {
          phases: plan.phases,
          maxParallelAgents: plan.maxParallel,
          failurePolicy: 'continue',
        },
        tasks,
        async (task): Promise<SubAgentResult> => {
          // Recover the source PlannedTeamMember via the task.id suffix.
          const member = plan.members.find(
            (m) => `${template.id}:${m.memberIndex}:${m.agentType}` === task.id,
          )
          if (!member) {
            return {
              success: false,
              agentId: asAgentId(`team-member-map-miss-${Date.now()}`),
              agentType: task.subagentType ?? 'unknown',
              output: `Plan drift: no member matched task ${task.id}`,
              totalTokens: 0,
              totalDurationMs: 0,
              totalToolUses: 0,
            }
          }
          const r = await executor({
            plan,
            member,
            teamName,
            workspaceRoot,
            abortSignal: teamAbort.signal,
            ...(leadAgentId && member === plan.members[0]
              ? { agentIdOverride: leadAgentId }
              : {}),
          })
          results.push(r)
          // Register the spawned agent into the TeamFile so mailbox / SendMessage
          // / TeamStatus see it. Fire-and-forget; failure is non-fatal because
          // the agent can still receive mailbox sends without roster membership.
          try {
            const syntheticFailure =
              !r.success && String(r.agentId).startsWith('team-member-')
            if (!syntheticFailure) {
              await ensureTeamMember(teamName, r.agentId)
            }
          } catch {
            /* non-fatal */
          }
          return r
        },
      )
      void state
    } catch (err) {
      try {
        emitSessionDebugLog({
          kind: 'team_auto_launch_workflow_error',
          teamName,
          templateId: template.id,
          error: err instanceof Error ? err.message : String(err),
        })
      } catch {
        /* ignore */
      }
    }
    return results
  })()

  return {
    plan,
    launchedCount: plan.members.length,
    completion,
  }
}
