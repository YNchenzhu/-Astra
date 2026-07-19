/**
 * Team plan-approval bridge (upstream §6.2 — teammate ExitPlanMode → leader mailbox).
 *
 * When a sub-agent (teammate) is running in `plan` permission mode and calls
 * `ExitPlanMode`, it cannot self-approve the exit — the team contract is that
 * the team lead, not the worker, decides when implementation can begin. Without
 * this bridge, the worker would call `requestPermission` locally and either
 * (a) wait forever if no terminal user is attached or (b) silently approve
 * itself. Both are wrong.
 *
 * Mirror of {@link teamPermissionLeaderBridge} — same wait/resolve mechanics,
 * different protocol kind (`plan_approval_request` / `plan_approval_response`
 * registered in {@link teamInterAgentProtocol}).
 *
 * Wiring:
 *   1. Worker `ExitPlanModeTool` calls {@link awaitTeamLeaderPlanApproval}
 *      when it detects a teammate context with a remote leader.
 *   2. The bridge:
 *      - Generates a request id, registers a pending Promise.
 *      - Writes a `plan_approval_request` envelope into the leader's mailbox
 *        (durable; survives leader-side restart).
 *      - Emits a renderer stream event so the leader UI can show an inline
 *        approval card alongside the existing `team_permission_request` UX.
 *      - Awaits with a timeout (default 10 minutes — a plan typically needs
 *        a human glance, not a 30-second auto-decision).
 *   3. Leader's main agent sees the request via
 *      {@link injectPendingInterAgentQueue} (mailbox → system-reminder) and
 *      can reply by sending a `plan_approval_response` envelope via the
 *      `SendMessage` tool. The reply is routed back through the worker's
 *      mailbox poller, which calls
 *      {@link tryResolveTeamPlanApprovalFromProtocolMessage}.
 *
 * Disabled when:
 *   - `ASTRA_TEAM_LEADER_PLAN_APPROVAL_MAILBOX=0` env override
 *   - Worker has no resolvable teamId / TeamFile / leadAgentId
 *   - Worker IS the team leader
 *
 * Production hardening:
 *   - Timeout default 10 min (`ASTRA_TEAM_PLAN_APPROVAL_TIMEOUT_MS` to override).
 *   - Abort signal cooperation: a parent abort cancels the pending wait.
 *   - The pending map is keyed by `requestId` and freed on resolve / timeout
 *     / abort, so a flood of approvals can't leak entries.
 *   - Plan body is size-capped to 24 KB before delivery — the mailbox cap
 *     (`AGENT_MAILBOX_MAX`) drops oldest unread messages, so an unbounded
 *     plan blob would push genuine traffic out of the inbox.
 */

import {
  emitStreamEventForConversation,
  getPermissionMode,
  registerAllCancelHook,
  registerConversationCancelHook,
} from '../ai/interactionState'
import { getAgentContext } from './agentContext'
import { getActiveAgent } from './activeAgentRegistry'
import { getWorkspacePath } from '../tools/workspaceState'
import { loadTeamFile, sendTeamMessage } from '../tools/TeamCreateTool'
import {
  stringifyTeamInterAgentMessage,
  TEAM_INTER_AGENT_SCHEMA,
  type TeamInterAgentMessage,
} from './teamInterAgentProtocol'

export interface TeamPlanApprovalDecision {
  /** True if the team lead approved exiting plan mode. */
  approved: boolean
  /**
   * Why the wait ended. `lead_decision` covers both approve and explicit
   * deny (distinguish via `approved`). Other values mean the worker never
   * heard back from the leader.
   */
  reason: 'lead_decision' | 'timeout' | 'aborted' | 'delivery_failed' | 'no_leader'
  /** Free-form note from the leader (mailbox `detail` text), when supplied. */
  detail?: string
}

interface PendingPlanApproval {
  resolve: (d: TeamPlanApprovalDecision) => void
  timer: ReturnType<typeof setTimeout>
  /**
   * The worker's own conversation (whoever called the bridge). When the
   * worker's chat is cancelled, the worker process is gone and the wait
   * should give up.
   *
   * Empty string when no agent context was active at request time
   * (defensive — production teammate runs always have one).
   */
  workerConversationId: string
  /**
   * The leader / chat target the approval card was emitted to. When the
   * leader's chat is cancelled (e.g. user clicked Stop in the main chat
   * while a teammate card is showing), the approver is gone — drain.
   *
   * Empty string for the team-mailbox path when no active leader stream
   * is registered (the approval still rides on the mailbox protocol);
   * in that case only worker-conv-cancel or all-cancel can drain it.
   */
  leaderConversationId: string
}

const pendingTeamLeaderPlanApproval = new Map<string, PendingPlanApproval>()

/**
 * Drain hook: resolve every pending wait whose worker OR leader
 * conversation matches `conversationId` with an aborted denial. Wired
 * into {@link cancelPendingInteractionsForConversation} via
 * {@link ensureCancelHooks} so a single `cancelStream(cid)` simultaneously
 * aborts the worker's loop AND wakes any teammate plan-approval Promise
 * parked inside it — without this, the worker would block in
 * `tool.call()` for the full 10-minute timeout.
 */
function cancelPendingForConversation(conversationId: string): void {
  for (const [requestId, entry] of pendingTeamLeaderPlanApproval) {
    if (
      entry.workerConversationId !== conversationId &&
      entry.leaderConversationId !== conversationId
    ) {
      continue
    }
    try {
      clearTimeout(entry.timer)
    } catch {
      /* ignore */
    }
    pendingTeamLeaderPlanApproval.delete(requestId)
    entry.resolve({ approved: false, reason: 'aborted' })
  }
}

function cancelAllPending(): void {
  for (const [requestId, entry] of pendingTeamLeaderPlanApproval) {
    try {
      clearTimeout(entry.timer)
    } catch {
      /* ignore */
    }
    pendingTeamLeaderPlanApproval.delete(requestId)
    entry.resolve({ approved: false, reason: 'aborted' })
  }
}

let cancelHooksRegistered = false
function ensureCancelHooks(): void {
  if (cancelHooksRegistered) return
  cancelHooksRegistered = true
  registerConversationCancelHook(cancelPendingForConversation)
  registerAllCancelHook(cancelAllPending)
}

let teamPlanSeq = 0
function nextTeamPlanRequestId(): string {
  teamPlanSeq += 1
  return `tplan-${Date.now()}-${teamPlanSeq}`
}

/**
 * Default 10 minutes — a plan-approval is human-pacing work, not a tool gate.
 * Long enough that the lead can finish a meeting before the worker bails;
 * short enough that an idle review doesn't pin the worker forever.
 */
const DEFAULT_LEADER_PLAN_APPROVAL_MS = 10 * 60 * 1000

/**
 * Hard cap on the plan markdown ferried through the mailbox. The mailbox
 * itself caps at {@link AGENT_MAILBOX_MAX} entries; a single 1 MB plan would
 * shove every prior message out of the queue. Truncate to a generous-but-
 * bounded payload and let the worker's response include a pointer to the
 * persisted plan file under `.cursor/plans/` if the leader needs more.
 */
const PLAN_BODY_MAX_CHARS = 24_000

function truncatePlanBody(text: string): string {
  if (text.length <= PLAN_BODY_MAX_CHARS) return text
  return `${text.slice(0, PLAN_BODY_MAX_CHARS)}\n…[truncated for mailbox delivery; see the persisted plan file under .cursor/plans/ for the full body]`
}

/**
 * Whether ExitPlanMode in this run should delegate approval to the team lead.
 * Mirrors {@link isWorkerToolPermissionDelegatedToTeamLeader} for plan flow.
 *
 * Returns `false` (and the caller falls back to local `requestPermission`) when:
 *   - The env override `ASTRA_TEAM_LEADER_PLAN_APPROVAL_MAILBOX=0` is set.
 *   - No agent context (we're outside an ALS run — main thread / tests).
 *   - No team id is resolvable (sub-agent without a team).
 *   - We are the leader (team has only one member, or this run IS the lead).
 *   - No workspace root (no TeamFile to look up).
 *   - The team file has no `leadAgentId`.
 */
export function isWorkerExitPlanDelegatedToTeamLeader(): boolean {
  if (process.env.ASTRA_TEAM_LEADER_PLAN_APPROVAL_MAILBOX?.trim() === '0') {
    return false
  }
  const ctx = getAgentContext()
  if (!ctx) return false
  // Main chat agent never delegates; main is itself the user-facing surface.
  if (ctx.agentId === 'main') return false
  const teamName = ctx.teamId?.trim()
  if (!teamName) return false
  const ws = getWorkspacePath()?.trim()
  if (!ws) return false
  const team = loadTeamFile(ws, teamName)
  const lead = team?.leadAgentId?.trim()
  if (!lead) return false
  if (ctx.agentId.trim() === lead) return false
  return true
}

interface ApprovalRequestEnvelope {
  teamRequestId: string
  workerAgentId: string
  workerConversationId?: string
  planMarkdown: string
  allowedPrompts?: Array<Record<string, unknown>>
}

function buildPlanApprovalInnerProtocolBody(env: ApprovalRequestEnvelope): string {
  return stringifyTeamInterAgentMessage({
    schema: TEAM_INTER_AGENT_SCHEMA,
    kind: 'plan_approval_request',
    requestId: env.teamRequestId,
    detail: JSON.stringify({
      workerAgentId: env.workerAgentId,
      workerConversationId: env.workerConversationId,
      planMarkdown: truncatePlanBody(env.planMarkdown),
      ...(env.allowedPrompts && env.allowedPrompts.length > 0
        ? { allowedPrompts: env.allowedPrompts }
        : {}),
    }),
  })
}

async function deliverPlanApprovalRequestToLeader(params: {
  workspaceRoot: string
  teamName: string
  leaderAgentId: string
  workerAgentId: string
  innerPayload: string
}): Promise<void> {
  const r = await sendTeamMessage(
    params.workspaceRoot,
    params.teamName,
    params.workerAgentId,
    params.leaderAgentId,
    params.innerPayload,
    { type: 'task' },
  )
  if (!r.ok) throw new Error(r.error || 'sendTeamMessage failed')
}

/**
 * Resolve a pending worker wait. Used by:
 *   - {@link tryResolveTeamPlanApprovalFromProtocolMessage} (mailbox path).
 *   - Direct IPC from a leader-side approval dialog (future UI surface).
 */
export function resolveTeamLeaderPlanApprovalResponse(params: {
  teamRequestId: string
  approved: boolean
  detail?: string
  reason?: 'lead_decision' | 'timeout' | 'aborted' | 'delivery_failed'
}): boolean {
  const entry = pendingTeamLeaderPlanApproval.get(params.teamRequestId)
  if (!entry) return false
  try {
    clearTimeout(entry.timer)
  } catch {
    /* ignore */
  }
  pendingTeamLeaderPlanApproval.delete(params.teamRequestId)
  entry.resolve({
    approved: params.approved,
    reason: params.reason ?? 'lead_decision',
    ...(params.detail ? { detail: params.detail } : {}),
  })
  return true
}

/**
 * Mailbox parser — leader (or tests) sends structured `plan_approval_response`.
 * Returns `true` when a pending wait was resolved, `false` otherwise (the
 * caller may want to surface stray responses as schema-tagged log lines).
 */
export function tryResolveTeamPlanApprovalFromProtocolMessage(
  msg: TeamInterAgentMessage,
): boolean {
  if (msg.kind !== 'plan_approval_response' || !msg.requestId?.trim()) return false
  // The base schema has `approve: boolean`; treat missing as deny (safer
  // failure mode than auto-approve when the leader sent a malformed reply).
  const approved = msg.approve === true
  const detail =
    typeof msg.detail === 'string' && msg.detail.trim() ? msg.detail.trim() : undefined
  return resolveTeamLeaderPlanApprovalResponse({
    teamRequestId: msg.requestId.trim(),
    approved,
    ...(detail ? { detail } : {}),
    reason: 'lead_decision',
  })
}

export async function awaitTeamLeaderPlanApproval(params: {
  planMarkdown: string
  allowedPrompts?: Array<Record<string, unknown>>
  signal?: AbortSignal
}): Promise<TeamPlanApprovalDecision> {
  ensureCancelHooks()
  const ctx = getAgentContext()
  const teamName = ctx?.teamId?.trim()
  const ws = getWorkspacePath()?.trim()
  if (!teamName || !ws || !ctx || ctx.agentId === 'main') {
    return { approved: false, reason: 'no_leader' }
  }
  const team = loadTeamFile(ws, teamName)
  if (!team?.leadAgentId || team.leadAgentId === ctx.agentId) {
    return { approved: false, reason: 'no_leader' }
  }

  const teamRequestId = nextTeamPlanRequestId()
  const workerConversationId = ctx.streamConversationId?.trim() ?? ''
  const leader = getActiveAgent(team.leadAgentId)
  const leaderConversationId =
    typeof leader?.streamConversationId === 'string' && leader.streamConversationId.trim()
      ? leader.streamConversationId.trim()
      : undefined

  return new Promise<TeamPlanApprovalDecision>((resolve) => {
    if (params.signal?.aborted) {
      resolve({ approved: false, reason: 'aborted' })
      return
    }

    const envMs = Number(process.env.ASTRA_TEAM_PLAN_APPROVAL_TIMEOUT_MS)
    const timeoutMs =
      Number.isFinite(envMs) && envMs > 5_000 ? envMs : DEFAULT_LEADER_PLAN_APPROVAL_MS

    const onAbort = () => {
      resolveTeamLeaderPlanApprovalResponse({
        teamRequestId,
        approved: false,
        reason: 'aborted',
      })
    }
    if (params.signal) {
      params.signal.addEventListener('abort', onAbort, { once: true })
    }

    const timer = setTimeout(() => {
      resolveTeamLeaderPlanApprovalResponse({
        teamRequestId,
        approved: false,
        reason: 'timeout',
      })
    }, timeoutMs)

    pendingTeamLeaderPlanApproval.set(teamRequestId, {
      resolve: (d: TeamPlanApprovalDecision) => {
        try {
          clearTimeout(timer)
        } catch {
          /* ignore */
        }
        if (params.signal) params.signal.removeEventListener('abort', onAbort)
        resolve(d)
      },
      timer,
      workerConversationId,
      leaderConversationId: leaderConversationId ?? '',
    })

    const inner = buildPlanApprovalInnerProtocolBody({
      teamRequestId,
      workerAgentId: ctx.agentId,
      workerConversationId: ctx.streamConversationId,
      planMarkdown: params.planMarkdown,
      ...(params.allowedPrompts && params.allowedPrompts.length > 0
        ? { allowedPrompts: params.allowedPrompts }
        : {}),
    })

    void deliverPlanApprovalRequestToLeader({
      workspaceRoot: ws,
      teamName,
      leaderAgentId: team.leadAgentId,
      workerAgentId: ctx.agentId,
      innerPayload: inner,
    }).catch((e) => {
      console.warn('[TeamPlanApproval] deliver to leader failed:', e)
      resolveTeamLeaderPlanApprovalResponse({
        teamRequestId,
        approved: false,
        reason: 'delivery_failed',
      })
    })

    // Emit a renderer stream event tagged at the leader's conversation so a
    // (future or existing) approval-dialog component can surface the request
    // alongside the chat. Mirrors the `team_permission_request` event shape
    // so renderer code can route both via one handler.
    emitStreamEventForConversation(leaderConversationId, {
      type: 'team_plan_approval_request',
      teamRequestId,
      requestId: teamRequestId,
      workerAgentId: ctx.agentId,
      teamName,
      planMarkdown: truncatePlanBody(params.planMarkdown),
      mode: getPermissionMode(),
      ...(params.allowedPrompts && params.allowedPrompts.length > 0
        ? { allowedPrompts: params.allowedPrompts }
        : {}),
    })
  })
}

/**
 * Leader / automation: build the `SendMessage` body that unblocks the worker.
 * Symmetrical with {@link buildTeamPermissionResponsePayload} so leader-side
 * tools can reuse the same pattern.
 */
export function buildTeamPlanApprovalResponsePayload(params: {
  teamRequestId: string
  approve: boolean
  detail?: string
}): string {
  const trimmedDetail = params.detail?.trim()
  return stringifyTeamInterAgentMessage({
    schema: TEAM_INTER_AGENT_SCHEMA,
    kind: 'plan_approval_response',
    requestId: params.teamRequestId.trim(),
    approve: params.approve,
    ...(trimmedDetail ? { detail: trimmedDetail } : {}),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer-teammate path (P0-2 follow-up).
//
// Some teammate runs are spawned directly from the renderer's TeammatePanel
// instead of going through `TeamCreate` / TeamFile. They have no team mailbox
// and no `leadAgentId`; the "leader" is whichever main chat conversation
// kicked them off. For those runs we still want plan-approval to be a
// human-in-the-loop step — so ExitPlanMode emits a `team_plan_approval_request`
// event into the **main chat's** stream channel and waits for the user (via
// an inline approval card → IPC `ai:respond-team-plan-approval`) to resolve
// the same pendingTeamLeaderPlanApproval map.
//
// Both paths share the resolve/timeout/abort machinery — the only difference
// is delivery (TeamFile mailbox vs. direct stream event).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether ExitPlanMode in this run should delegate approval directly to a
 * main-chat conversation (renderer-spawned teammate path). Returns the
 * delegate conversation id when active, `undefined` otherwise.
 *
 * Disabled by env override `ASTRA_TEAM_LEADER_PLAN_APPROVAL_MAILBOX=0` —
 * the same kill-switch as the TeamFile path so a single env flip turns off
 * BOTH approval-routing modes (worker falls back to local `requestPermission`).
 */
export function getChatLeaderPlanApprovalConversationId(): string | undefined {
  if (process.env.ASTRA_TEAM_LEADER_PLAN_APPROVAL_MAILBOX?.trim() === '0') {
    return undefined
  }
  const ctx = getAgentContext()
  if (!ctx) return undefined
  if (ctx.agentId === 'main') return undefined
  const cid = ctx.planApprovalDelegateConversationId?.trim()
  if (!cid) return undefined
  return cid
}

/**
 * Renderer-teammate plan approval — emit the approval request as a stream
 * event into the leader's main chat conversation, register a pending
 * Promise, await the response from the user-side IPC.
 *
 * The pending-Promise map is the SAME `pendingTeamLeaderPlanApproval` used
 * by the TeamFile path, so a single resolver
 * ({@link resolveTeamLeaderPlanApprovalResponse}) closes both — that's how
 * the new IPC `ai:respond-team-plan-approval` can drive either path
 * without branching.
 */
export async function awaitChatLeaderPlanApproval(params: {
  delegateConversationId: string
  planMarkdown: string
  allowedPrompts?: Array<Record<string, unknown>>
  signal?: AbortSignal
}): Promise<TeamPlanApprovalDecision> {
  ensureCancelHooks()
  const ctx = getAgentContext()
  if (!ctx || ctx.agentId === 'main') {
    return { approved: false, reason: 'no_leader' }
  }
  const targetCid = params.delegateConversationId.trim()
  if (!targetCid) {
    return { approved: false, reason: 'no_leader' }
  }

  const teamRequestId = nextTeamPlanRequestId()
  const workerConversationId = ctx.streamConversationId?.trim() ?? ''

  return new Promise<TeamPlanApprovalDecision>((resolve) => {
    if (params.signal?.aborted) {
      resolve({ approved: false, reason: 'aborted' })
      return
    }

    const envMs = Number(process.env.ASTRA_TEAM_PLAN_APPROVAL_TIMEOUT_MS)
    const timeoutMs =
      Number.isFinite(envMs) && envMs > 5_000 ? envMs : DEFAULT_LEADER_PLAN_APPROVAL_MS

    const onAbort = () => {
      resolveTeamLeaderPlanApprovalResponse({
        teamRequestId,
        approved: false,
        reason: 'aborted',
      })
    }
    if (params.signal) {
      params.signal.addEventListener('abort', onAbort, { once: true })
    }

    const timer = setTimeout(() => {
      resolveTeamLeaderPlanApprovalResponse({
        teamRequestId,
        approved: false,
        reason: 'timeout',
      })
    }, timeoutMs)

    pendingTeamLeaderPlanApproval.set(teamRequestId, {
      resolve: (d: TeamPlanApprovalDecision) => {
        try {
          clearTimeout(timer)
        } catch {
          /* ignore */
        }
        if (params.signal) params.signal.removeEventListener('abort', onAbort)
        resolve(d)
      },
      timer,
      workerConversationId,
      leaderConversationId: targetCid,
    })

    // Direct stream event into the leader's chat. The renderer's
    // `handleTeamPlanApprovalRequestEvent` parks this into
    // `pendingTeamPlanApproval` so the inline card surfaces. Resolution
    // happens via the new `ai:respond-team-plan-approval` IPC, which
    // reaches `resolveTeamLeaderPlanApprovalResponse` directly.
    emitStreamEventForConversation(targetCid, {
      type: 'team_plan_approval_request',
      teamRequestId,
      requestId: teamRequestId,
      workerAgentId: ctx.agentId,
      // No teamName for the renderer-spawned path — the renderer knows
      // this means "the teammate I just spawned", not "a member of team X".
      planMarkdown: truncatePlanBody(params.planMarkdown),
      mode: getPermissionMode(),
      ...(params.allowedPrompts && params.allowedPrompts.length > 0
        ? { allowedPrompts: params.allowedPrompts }
        : {}),
    })
  })
}
