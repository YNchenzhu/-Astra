import { taskManager } from '../tools/TaskManager'
import { extractMemoryPostTask } from '../memory/autoExtract'
import {
  lifecycleEventBus,
  type TaskCompletedPayload,
  type TaskFailedPayload,
} from './lifecycleEventBus'

/**
 * Append a line to the renderer Output panel (injected from main to avoid circular imports).
 */
export type OutputAppender = (
  channelId: string,
  message: string,
  type?: 'info' | 'warning' | 'error',
) => void

export { lifecycleEventBus } from './lifecycleEventBus'
export type {
  LifecycleEventName,
  TaskCompletedPayload,
  TaskFailedPayload,
} from './lifecycleEventBus'

/**
 * Audit fix R4 (2026-05) — single-init guard.
 *
 * Without this, a stray second {@link initEventDrivenNetwork} call (hot reload,
 * double `app.whenReady`, tests that forget teardown) would silently install a
 * SECOND `taskManager.subscribe` listener and TWO `'TaskCompleted'` /
 * `'TaskFailed'` handlers — every terminal task would fire `extractMemoryPostTask`
 * twice (real LLM calls, real tokens) and `appendOutput` would echo each task
 * line twice in the system channel.
 *
 * The guard stores the `dispose` returned by the first call so re-callers get
 * the same disposer back; nothing rewires. Tests that need a fresh wiring must
 * call the returned dispose (or {@link __resetEventDrivenNetworkForTests}) first.
 */
let activeDispose: (() => void) | null = null

/**
 * 阶段三：TaskManager → 统一生命周期总线 → 订阅方（记忆提取、审计日志等）
 *
 * Returns a `dispose` that unwires every subscription installed by this call.
 * Idempotent: subsequent invocations log a warn and return the previous dispose
 * without reinstalling listeners — see {@link activeDispose}.
 */
export function initEventDrivenNetwork(appendOutput: OutputAppender): () => void {
  if (activeDispose) {
    console.warn(
      '[EventDrivenNetwork] initEventDrivenNetwork called more than once — ' +
        'returning previous dispose without re-wiring. Call the returned dispose ' +
        'first if you intended to rewire (test teardown, hot reload).',
    )
    return activeDispose
  }

  console.log('[EventDrivenNetwork] Initializing lifecycle bus + subscribers')

  const unsubscribeTaskManager = taskManager.subscribe((event) => {
    // Audit fix R5 (2026-05) — explicit `cancelled` branch.
    //
    // `TaskManager.update` emits a distinct `cancelled` event for user-initiated
    // TaskStop (see `TaskManager.ts` P1-20 note). Previously the early-return
    // below silently swallowed it; the user got zero feedback that their stop
    // was acknowledged at this layer. We deliberately do NOT trigger memory
    // extraction on cancel: a user-aborted task is not "completed work" and
    // its half-finished output shouldn't seed long-term memory.
    if (event.type === 'cancelled') {
      appendOutput(
        'system',
        `[EventDrivenNetwork] Task cancelled by user: ${event.task.subject}`,
        'info',
      )
      return
    }

    // Ignore `created` / `started` / `output` / `removed`: they are not terminal
    // transitions and would either double-fire memory extraction or trigger it
    // on rows the user never authored.
    if (event.type !== 'completed' && event.type !== 'failed') return

    const snapshot = event.task
    const fullTask = taskManager.getTask(snapshot.taskId) ?? snapshot

    if (event.type === 'completed') {
      lifecycleEventBus.emitTaskCompleted({ snapshot, fullTask })
    } else {
      // Best-effort: surface the last stderr line (if the task captured any)
      // so `TaskFailed` subscribers have a human-readable reason rather than
      // a bare "Task failed". `outputChunks[].channel` is 'stderr' for
      // std-error output (see TaskManager.appendOutputChunk).
      const lastStderr = (fullTask.outputChunks || [])
        .slice()
        .reverse()
        .find((c) => c && c.channel === 'stderr' && typeof c.text === 'string' && c.text.trim())
      lifecycleEventBus.emitTaskFailed({
        snapshot,
        fullTask,
        error: lastStderr?.text?.trim().slice(-300) || undefined,
      })
    }
  })

  const completedHandler = ({ fullTask }: TaskCompletedPayload): void => {
    const task = fullTask
    if (task.owner !== 'Coordinator' && task.source !== 'user') return

    void (async () => {
      appendOutput(
        'system',
        `[EventDrivenNetwork] Background memory extraction started for task: ${task.subject}`,
      )

      try {
        const result = await extractMemoryPostTask(task)
        if (result.created > 0 || result.updated > 0) {
          appendOutput(
            'system',
            `[EventDrivenNetwork] Extracted ${result.created} new memories, updated ${result.updated}.`,
          )
        } else {
          appendOutput('system', '[EventDrivenNetwork] No new memories extracted for task.')
        }
      } catch (err) {
        console.error(`[EventDrivenNetwork] Failed to extract memory for task ${task.taskId}:`, err)
        const msg = err instanceof Error ? err.message : String(err)
        appendOutput('system', `[EventDrivenNetwork] Failed memory extraction: ${msg}`, 'error')
      }
    })()
  }
  lifecycleEventBus.on('TaskCompleted', completedHandler)

  const failedHandler = ({ fullTask, error }: TaskFailedPayload): void => {
    appendOutput(
      'system',
      `[EventDrivenNetwork] Task failed: ${fullTask.subject}${error ? ` — ${error}` : ''}`,
      'warning',
    )
  }
  lifecycleEventBus.on('TaskFailed', failedHandler)

  const dispose = (): void => {
    // Guard against double-dispose: only the latest installed dispose can
    // clear `activeDispose`. A stale dispose (e.g. a leaked test reference)
    // becomes a no-op.
    if (activeDispose !== dispose) return
    activeDispose = null
    try {
      unsubscribeTaskManager()
    } catch (err) {
      console.warn('[EventDrivenNetwork] taskManager unsubscribe threw on dispose:', err)
    }
    lifecycleEventBus.off('TaskCompleted', completedHandler)
    lifecycleEventBus.off('TaskFailed', failedHandler)
  }

  activeDispose = dispose
  return dispose
}

/**
 * @internal Test-only — tear down whatever the active init installed.
 * Tests that exercise `initEventDrivenNetwork` should call this in `afterEach`
 * to avoid leaking subscribers into the next test file.
 */
export function __resetEventDrivenNetworkForTests(): void {
  if (activeDispose) {
    try {
      activeDispose()
    } catch {
      /* ignore */
    }
  }
  activeDispose = null
}

export function disposeEventDrivenNetwork(): void {
  activeDispose?.()
}

/** @internal Test-only — peek whether the network is currently wired. */
export function __isEventDrivenNetworkInitializedForTests(): boolean {
  return activeDispose !== null
}
