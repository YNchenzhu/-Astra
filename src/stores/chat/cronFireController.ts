/**
 * Cron fire → main chat bridge.
 *
 * The main process schedules cron tasks (CronCreate tool → cronWorker) and on
 * each fire sends `ai:cron-fire` to the renderer (appBootstrap.setCronFireHandler).
 * Before this controller existed, NOTHING subscribed to that event — the
 * payload (prompt + taskId) arrived in the renderer and was silently dropped,
 * so "scheduled agent tasks" never actually executed.
 *
 * This controller closes that gap: on fire, the prompt is submitted through
 * the regular main-chat send pipeline (`setInputText` + `sendMessage()`), the
 * same programmatic-injection pattern used by `autoResumeBackgroundTasks`.
 * `sendMessage` already handles the busy case (streaming conversation →
 * `enqueueMainChatTurn`), so the only local guard needed is "never clobber a
 * user draft": if the input box has text or pending attachments, the fire is
 * queued here and retried until the draft clears or the entry expires.
 */
import { useChatStore } from '../useChatStore'
import { onCronFire, type CronFirePayload } from '../../services/electronAPI'

const RETRY_MS = 5_000
const QUEUE_MAX = 16
const ENTRY_TTL_MS = 10 * 60_000

type QueuedFire = CronFirePayload & { receivedAt: number }

const queue: QueuedFire[] = []
let retryTimer: ReturnType<typeof setInterval> | null = null
let installed = false
let unsubscribe: (() => void) | null = null

function buildPromptText(payload: CronFirePayload): string {
  const agent = payload.agentId ? ` agent:${payload.agentId}` : ''
  return `[定时任务触发 ${payload.taskId} | cron: ${payload.cron}${agent}]\n${payload.prompt}`
}

/** A user draft in the input box must never be clobbered by an auto-send. */
function hasUserDraft(): boolean {
  const state = useChatStore.getState()
  return Boolean(state.inputText.trim()) || state.pendingAttachments.length > 0
}

function submit(payload: CronFirePayload): void {
  useChatStore.setState({ inputText: buildPromptText(payload) })
  void Promise.resolve(useChatStore.getState().sendMessage()).catch((err) => {
    console.warn('[cronFireController] cron prompt send failed:', err)
  })
}

function drainQueue(): void {
  const now = Date.now()
  while (queue.length > 0) {
    if (now - queue[0].receivedAt > ENTRY_TTL_MS) {
      const dropped = queue.shift()!
      console.warn(
        `[cronFireController] dropped expired cron fire (taskId=${dropped.taskId}, queued ${Math.round((now - dropped.receivedAt) / 1000)}s ago)`,
      )
      continue
    }
    if (hasUserDraft()) return // keep waiting; timer stays armed
    submit(queue.shift()!)
  }
  if (queue.length === 0 && retryTimer) {
    clearInterval(retryTimer)
    retryTimer = null
  }
}

function enqueue(payload: CronFirePayload): void {
  queue.push({ ...payload, receivedAt: Date.now() })
  if (queue.length > QUEUE_MAX) queue.shift()
  if (!retryTimer) retryTimer = setInterval(drainQueue, RETRY_MS)
}

function handleFire(payload: CronFirePayload): void {
  // Preserve fire order: if earlier fires are still queued behind a user
  // draft, this one must wait behind them too.
  if (queue.length > 0 || hasUserDraft()) {
    enqueue(payload)
    return
  }
  submit(payload)
}

/**
 * Install the once-per-process `ai:cron-fire` subscription. Mirrors
 * `ensureAutoResumeBackgroundTaskController`: multiple mounts share a single
 * listener. Mounted from the App root (NOT ChatPanel) so cron fires are
 * consumed even while the chat surface is closed — the send pipeline and
 * stream routers are store-level and work without a mounted panel.
 */
export function ensureCronFireController(): void {
  if (installed) return
  installed = true
  try {
    const off = onCronFire(handleFire)
    unsubscribe = typeof off === 'function' ? off : null
  } catch (err) {
    console.warn('[cronFireController] install failed:', err)
    installed = false
    unsubscribe = null
  }
}

/** Test / HMR teardown counterpart. */
export function disposeCronFireController(): void {
  if (retryTimer) {
    clearInterval(retryTimer)
    retryTimer = null
  }
  queue.length = 0
  if (unsubscribe) {
    try { unsubscribe() } catch { /* noop */ }
    unsubscribe = null
  }
  installed = false
}
