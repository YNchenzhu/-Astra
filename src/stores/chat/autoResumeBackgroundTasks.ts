/**
 * Auto-resume on background-task completion.
 *
 * Problem: a backgrounded runtime task (Bash / skill / sub-agent) finishes
 * AFTER the agent already ended its turn (nothing else to do). The runtime's
 * `<task_notifications>` are only drained on the NEXT tool batch, so an idle
 * conversation just sits there until the user types. This controller closes
 * that gap: when a background task reaches a terminal state and the
 * conversation is idle, it auto-starts ONE continuation turn so the agent
 * picks the work back up without the user having to say anything.
 *
 * Safety is the whole point here — autonomously re-driving the agent is
 * powerful and easy to turn into a runaway loop / surprise cost. Every one of
 * these guards must hold before a resume fires:
 *   1. Feature enabled (localStorage `astra:auto-resume-bg` !== '0').
 *   2. There is a current conversation.
 *   3. Chat input mode is `agent` (plan/ask must not be auto-driven).
 *   4. The conversation is IDLE (no streaming assistant in flight).
 *   5. The input box is empty (never clobber what the user is typing, and a
 *      typed draft means the user is about to drive it themselves).
 *   6. No pending user-interaction gate (permission / ask / plan approval).
 *   7. Under the rolling cap: at most {@link MAX_RESUMES_PER_WINDOW} auto-
 *      resumes per {@link WINDOW_MS} per conversation — bounds any
 *      resume → spawns task → completes → resume … cycle.
 *
 * Completions are debounced so a burst of finishing tasks coalesces into a
 * single resume.
 *
 * Cohort gate + dedup (2026-06 fix for "staggered sub-agents trigger multiple
 * resumes / a premature resume while siblings are still working"):
 *   - GATE: a `subagent-terminal-wake` carries `outstandingActiveAgents` — the
 *     count of background agents STILL actively working. The resume only fires
 *     when this hits 0 (the whole spawned cohort has gone idle/terminal), so
 *     the main agent is never woken mid-flight on a partial batch.
 *   - DEDUP: each wake's `agentId` is remembered once it has been "surfaced" by
 *     a fired resume. A later wake (e.g. the SAME team members terminating
 *     after the lead shut them down) brings no NEW agentId and is suppressed —
 *     killing the redundant second resume.
 */
import { useChatStore } from '../useChatStore'
import { pendingAssistantByConversation } from './sessionSlice'
import { onStreamEvent } from '../../services/electronAPI'

const DEBOUNCE_MS = 2_000
const WINDOW_MS = 120_000
const MAX_RESUMES_PER_WINDOW = 5

const AUTO_RESUME_PROMPT =
  '[自动续跑] 后台任务已完成。请用 TaskOutput 查看相关后台任务的结果，并继续之前尚未完成的工作；' +
  '如果确实没有可继续的事项，简要说明现状即可（无需向我追问）。'

const AUTO_RESUME_SUBAGENT_PROMPT =
  '[自动续跑] 后台子代理/团队成员已产出新结果或进入待命。请查看上方注入的子代理输出（或用 TaskOutput / ' +
  'TeamStatus 拉取详情），整合结果并继续尚未完成的工作；若团队成员处于待命且没有后续任务，请用 SendMessage ' +
  '发送 shutdown_request（或 TeamDelete）收尾，不要让成员一直挂着；如果确实没有可继续的事项，简要总结现状即可（无需向我追问）。'

/**
 * Wake-trigger predicate — exported for unit tests.
 *
 *   - `background-task-completed`: backgrounded SHELL task finished
 *     (emitted by `notificationSystem.maybeEmitBackgroundCompleted`).
 *   - `subagent-terminal-wake`: background sub-agent reached a terminal
 *     state, or a team member finished its work and entered the idle
 *     mailbox wait (emitted by `electron/agents/mainAgentWakeup.ts`).
 */
export function isWakeTriggerEvent(type: unknown): boolean {
  return type === 'background-task-completed' || type === 'subagent-terminal-wake'
}

/**
 * Pure cohort-gate + dedup decision (exported for unit tests).
 *
 *   - `outstandingActiveAgents > 0` → cohort NOT settled; hold (a later wake,
 *     when the next sibling settles, re-evaluates). Returns `wait`.
 *   - cohort settled but every pending agent was already surfaced by a prior
 *     resume → nothing new (e.g. members terminating after the lead's shutdown)
 *     → `suppress`.
 *   - cohort settled with at least one un-surfaced agent → `resume`.
 *
 * Shell-task completions (`background-task-completed`) carry no agent cohort
 * (`isSubAgentWake === false`) and always pass straight through (`resume`).
 */
export function decideCohortResume(input: {
  isSubAgentWake: boolean
  outstandingActiveAgents: number
  pendingAgentIds: ReadonlySet<string>
  surfacedAgentIds: ReadonlySet<string>
}): 'resume' | 'wait' | 'suppress' {
  if (!input.isSubAgentWake) return 'resume'
  if (input.outstandingActiveAgents > 0) return 'wait'
  for (const id of input.pendingAgentIds) {
    if (!input.surfacedAgentIds.has(id)) return 'resume'
  }
  return 'suppress'
}

const recentResumes = new Map<string, number[]>()
/** Per-conversation cohort bookkeeping for the gate + dedup (see `decideCohortResume`). */
const pendingAgentsByConv = new Map<string, Set<string>>()
const surfacedAgentsByConv = new Map<string, Set<string>>()
const lastOutstandingByConv = new Map<string, number>()
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let installed = false
let unsubscribe: (() => void) | null = null

function isEnabled(): boolean {
  try {
    return localStorage.getItem('astra:auto-resume-bg') !== '0'
  } catch {
    return true
  }
}


function underRollingCap(convId: string): boolean {
  const now = Date.now()
  const arr = (recentResumes.get(convId) ?? []).filter((t) => now - t < WINDOW_MS)
  recentResumes.set(convId, arr)
  return arr.length < MAX_RESUMES_PER_WINDOW
}

function recordResume(convId: string): void {
  const arr = recentResumes.get(convId) ?? []
  arr.push(Date.now())
  recentResumes.set(convId, arr)
}

/** Which prompt to use for the pending resume (sub-agent wakes carry team guidance). */
let pendingWakeIsSubAgent = false

function checkAndResume(): void {
  if (!isEnabled()) return
  const state = useChatStore.getState()
  const convId = state.currentConversationId
  if (!convId) return
  // Plan / Ask must not be auto-driven — only Agent mode.
  if (state.chatInteractionMode !== 'agent') return
  // Idle only: a streaming assistant means the loop is already running and the
  // post-tool notification drain will surface the completion on its own.
  if (pendingAssistantByConversation.has(convId)) return
  // Never clobber a user draft, and a draft means the user is steering.
  if (state.inputText.trim()) return
  // Waiting on the user for something — don't barge in.
  if (
    state.pendingPermissionRequest ||
    state.pendingAskUserQuestion ||
    state.pendingPlanApproval ||
    state.pendingTeamPlanApproval
  ) {
    return
  }

  // Cohort gate + dedup. `wait` (cohort still working) and `suppress` (nothing
  // new — e.g. already-surfaced members terminating after shutdown) both skip
  // WITHOUT consuming the rolling-cap budget; only a real `resume` records one.
  const pending = pendingAgentsByConv.get(convId) ?? new Set<string>()
  const surfaced = surfacedAgentsByConv.get(convId) ?? new Set<string>()
  const decision = decideCohortResume({
    isSubAgentWake: pendingWakeIsSubAgent,
    outstandingActiveAgents: lastOutstandingByConv.get(convId) ?? 0,
    pendingAgentIds: pending,
    surfacedAgentIds: surfaced,
  })
  if (decision === 'wait') return
  if (decision === 'suppress') {
    pending.clear() // consumed: these wakes added nothing new
    return
  }

  if (!underRollingCap(convId)) return

  recordResume(convId)
  // Surface every agent represented by this resume so their later (terminal)
  // wakes don't re-trigger; then clear the pending batch.
  if (pendingWakeIsSubAgent) {
    for (const id of pending) surfaced.add(id)
    surfacedAgentsByConv.set(convId, surfaced)
    pending.clear()
  }
  const prompt = pendingWakeIsSubAgent ? AUTO_RESUME_SUBAGENT_PROMPT : AUTO_RESUME_PROMPT
  pendingWakeIsSubAgent = false
  useChatStore.setState({ inputText: prompt })
  void Promise.resolve(useChatStore.getState().sendMessage()).catch((err) => {
    console.warn('[autoResumeBackgroundTasks] auto-resume send failed:', err)
  })
}

function scheduleCheck(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    try {
      checkAndResume()
    } catch (err) {
      console.warn('[autoResumeBackgroundTasks] check failed:', err)
    }
  }, DEBOUNCE_MS)
}

/**
 * Install the once-per-process subscription. Mirrors `ensurePlanTabStream` /
 * `ensureTaskListV2Stream`: multiple mounts share a single listener.
 */
export function ensureAutoResumeBackgroundTaskController(): void {
  if (installed) return
  installed = true
  try {
    const off = onStreamEvent((event) => {
      // Precise triggers (see `isWakeTriggerEvent`):
      //   - `background-task-completed` — backgrounded shell task finished.
      //   - `subagent-terminal-wake` — background sub-agent terminal, or a
      //     team member went idle after finishing its work (audit 2026-06:
      //     previously NOTHING re-triggered the main agent after its turn
      //     ended, so finished sub-agent/team work sat invisible and idle
      //     team members hung until timeout).
      // The idle / draft / pending / cap guards in `checkAndResume` still
      // apply at fire time.
      if (!isWakeTriggerEvent(event.type)) return
      if (event.type === 'subagent-terminal-wake') {
        pendingWakeIsSubAgent = true
        // Record this wake's agent into the current conversation's pending
        // cohort and remember the latest outstanding-active count for the gate.
        const convId = useChatStore.getState().currentConversationId
        if (convId) {
          const set = pendingAgentsByConv.get(convId) ?? new Set<string>()
          if (typeof event.agentId === 'string' && event.agentId) set.add(event.agentId)
          pendingAgentsByConv.set(convId, set)
          lastOutstandingByConv.set(
            convId,
            typeof event.outstandingActiveAgents === 'number'
              ? event.outstandingActiveAgents
              : 0,
          )
        }
      }
      scheduleCheck()
    })
    unsubscribe = typeof off === 'function' ? off : null
  } catch {
    installed = false
    unsubscribe = null
  }
}

/** Test / HMR teardown counterpart. */
export function disposeAutoResumeBackgroundTaskController(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (unsubscribe) {
    try { unsubscribe() } catch { /* noop */ }
    unsubscribe = null
  }
  pendingAgentsByConv.clear()
  surfacedAgentsByConv.clear()
  lastOutstandingByConv.clear()
  installed = false
}
