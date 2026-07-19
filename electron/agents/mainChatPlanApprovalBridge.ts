/**
 * Main-chat plan approval bridge (the IDE `create_plan`-style gate).
 *
 * Sibling to {@link teamPlanApprovalLeaderBridge}, but scoped to the main chat
 * agent. When the main agent (not a teammate, not a TeamFile worker) calls
 * `ExitPlanMode`, we don't have a "team leader" to delegate to — the user
 * watching the chat IS the approver. Instead of falling through to the generic
 * `requestPermission` allow/deny dialog, we emit a structured
 * `plan_approval_request` stream event carrying the full plan envelope
 * (markdown + todos + phases + name/overview/isProject) and park a Promise
 * until the user picks one of three outcomes:
 *
 *   - `accepted`  → exit plan mode, continue implementation.
 *   - `rejected`  → stay in plan mode, model gets the reason and revises.
 *   - `cancelled` → abort the current stream entirely (`cancelStream` is
 *                   triggered by the caller, not here — this bridge only
 *                   reports the outcome).
 *
 * Mirrors the wait/resolve mechanics of the teammate bridge: pending Promise
 * keyed by requestId, 10-minute default timeout, abort-signal cooperation,
 * single resolver freed exactly once.
 */

import {
  emit,
  getPermissionMode,
  registerAllCancelHook,
  registerConversationCancelHook,
} from '../ai/interactionState'
import { getAgentContext } from './agentContext'

/** the IDE-style tri-state outcome. */
export type PlanApprovalOutcome = 'accepted' | 'rejected' | 'cancelled'

export interface PlanApprovalDecision {
  outcome: PlanApprovalOutcome
  /**
   * Why the wait ended. `user_decision` is the only outcome that came from
   * an actual button click; the rest are failure modes the bridge applied
   * itself.
   */
  reason: 'user_decision' | 'timeout' | 'aborted'
  /** Optional free-form note the user typed into the reject input. */
  detail?: string
}

/**
 * Structured plan envelope ferried from `ExitPlanMode` arguments to the
 * renderer card. Mirrors the IDE's `cursor/create_plan` request shape
 * (`name`, `overview`, `plan`, `todos`, `phases`, `isProject`) without
 * forcing every field — agents that only have a markdown body still work.
 */
export interface PlanApprovalEnvelope {
  planMarkdown: string
  name?: string
  overview?: string
  isProject?: boolean
  todos?: Array<PlanTodo>
  phases?: Array<{ name: string; todos: Array<PlanTodo> }>
  allowedPrompts?: Array<Record<string, unknown>>
}

export interface PlanTodo {
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

interface PendingMainPlanApproval {
  resolve: (d: PlanApprovalDecision) => void
  timer: ReturnType<typeof setTimeout>
  /**
   * Conversation that owns this wait. Used by the drain hooks so a global
   * `cancelStream(cid)` wakes ONLY the right entries instead of all of them
   * (parallel chats would otherwise cross-cancel each other).
   *
   * Empty string when no agent context was active at request time (CLI /
   * test path); such entries can only ever be drained via the all-cancel
   * hook or their own timeout.
   */
  conversationId: string
}

const pendingMainChatPlanApproval = new Map<string, PendingMainPlanApproval>()

let mainPlanSeq = 0
function nextMainPlanRequestId(): string {
  mainPlanSeq += 1
  return `plan-${Date.now()}-${mainPlanSeq}`
}

/**
 * Default 10 minutes — same as the teammate bridge. A plan approval is a
 * human-pacing step; if no one is around for 10 min, time out and let the
 * agent move on with `rejected` semantics rather than pin the loop forever.
 */
const DEFAULT_MAIN_PLAN_APPROVAL_MS = 10 * 60 * 1000

/** Hard cap on plan markdown ferried over the renderer wire (24 KB). */
const PLAN_BODY_MAX_CHARS = 24_000

function truncatePlanBody(text: string): string {
  if (text.length <= PLAN_BODY_MAX_CHARS) return text
  return `${text.slice(0, PLAN_BODY_MAX_CHARS)}\n…[truncated for display; full plan persisted under .cursor/plans/ once approved]`
}

/**
 * Resolve a pending wait. Returns true when an entry matched, false when
 * the requestId was unknown (stale IPC after timeout / already resolved).
 */
export function resolveMainChatPlanApprovalResponse(params: {
  requestId: string
  outcome: PlanApprovalOutcome
  detail?: string
  reason?: PlanApprovalDecision['reason']
}): boolean {
  const entry = pendingMainChatPlanApproval.get(params.requestId)
  if (!entry) return false
  try {
    clearTimeout(entry.timer)
  } catch {
    /* ignore */
  }
  pendingMainChatPlanApproval.delete(params.requestId)
  entry.resolve({
    outcome: params.outcome,
    reason: params.reason ?? 'user_decision',
    ...(params.detail ? { detail: params.detail } : {}),
  })
  return true
}

/**
 * Resolve every pending wait that belongs to `conversationId` with a
 * cancelled / aborted outcome. Wired into
 * {@link cancelPendingInteractionsForConversation} via {@link ensureCancelHooks}
 * so a single `cancelStream(cid)` simultaneously aborts the loop AND wakes
 * any plan-approval Promise parked inside it — without this, the loop
 * would hang inside `tool.call()` until the 10-minute timeout fired.
 */
function cancelPendingForConversation(conversationId: string): void {
  for (const [requestId, entry] of pendingMainChatPlanApproval) {
    if (entry.conversationId !== conversationId) continue
    try {
      clearTimeout(entry.timer)
    } catch {
      /* ignore */
    }
    pendingMainChatPlanApproval.delete(requestId)
    entry.resolve({ outcome: 'cancelled', reason: 'aborted' })
  }
}

/** Same as above, scope-blind. Used by app-shutdown / global cancel. */
function cancelAllPending(): void {
  for (const [requestId, entry] of pendingMainChatPlanApproval) {
    try {
      clearTimeout(entry.timer)
    } catch {
      /* ignore */
    }
    pendingMainChatPlanApproval.delete(requestId)
    entry.resolve({ outcome: 'cancelled', reason: 'aborted' })
  }
}

let cancelHooksRegistered = false
function ensureCancelHooks(): void {
  if (cancelHooksRegistered) return
  cancelHooksRegistered = true
  registerConversationCancelHook(cancelPendingForConversation)
  registerAllCancelHook(cancelAllPending)
}

/**
 * Block the calling tool until the user resolves the plan approval card.
 *
 * The stream event is tagged with the current conversation (via `emit`,
 * which reads `streamConversationId` from the active agent context) so the
 * card surfaces in the chat that issued the request — exactly like
 * `permission_request` does today.
 */
export async function awaitMainChatPlanApproval(
  envelope: PlanApprovalEnvelope,
  options?: { signal?: AbortSignal },
): Promise<PlanApprovalDecision> {
  ensureCancelHooks()
  const requestId = nextMainPlanRequestId()
  const conversationId = getAgentContext()?.streamConversationId?.trim() ?? ''

  return new Promise<PlanApprovalDecision>((resolve) => {
    if (options?.signal?.aborted) {
      resolve({ outcome: 'cancelled', reason: 'aborted' })
      return
    }

    const envMs = Number(process.env.ASTRA_MAIN_PLAN_APPROVAL_TIMEOUT_MS)
    const timeoutMs =
      Number.isFinite(envMs) && envMs > 5_000 ? envMs : DEFAULT_MAIN_PLAN_APPROVAL_MS

    const onAbort = () => {
      resolveMainChatPlanApprovalResponse({
        requestId,
        outcome: 'cancelled',
        reason: 'aborted',
      })
    }
    if (options?.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const timer = setTimeout(() => {
      resolveMainChatPlanApprovalResponse({
        requestId,
        outcome: 'rejected',
        reason: 'timeout',
      })
    }, timeoutMs)

    pendingMainChatPlanApproval.set(requestId, {
      resolve: (d) => {
        try {
          clearTimeout(timer)
        } catch {
          /* ignore */
        }
        if (options?.signal) options.signal.removeEventListener('abort', onAbort)
        resolve(d)
      },
      timer,
      conversationId,
    })

    const truncatedPlan = truncatePlanBody(envelope.planMarkdown || '')
    const planEnvelopePayload: Record<string, unknown> = {
      ...(envelope.name ? { name: envelope.name } : {}),
      ...(envelope.overview ? { overview: envelope.overview } : {}),
      ...(typeof envelope.isProject === 'boolean'
        ? { isProject: envelope.isProject }
        : {}),
      ...(envelope.todos && envelope.todos.length > 0 ? { todos: envelope.todos } : {}),
      ...(envelope.phases && envelope.phases.length > 0
        ? { phases: envelope.phases }
        : {}),
    }

    emit({
      type: 'plan_approval_request',
      requestId,
      planMarkdown: truncatedPlan,
      mode: getPermissionMode(),
      ...(Object.keys(planEnvelopePayload).length > 0
        ? { planEnvelope: planEnvelopePayload }
        : {}),
      ...(envelope.allowedPrompts && envelope.allowedPrompts.length > 0
        ? { allowedPrompts: envelope.allowedPrompts }
        : {}),
    })
  })
}
