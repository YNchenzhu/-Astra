/**
 * V2 TaskManager mirror store — upstream parity for `useTasksV2`
 * (`src/hooks/useTasksV2.ts`).
 *
 * The main process owns `taskManager` (singleton in
 * `electron/tools/TaskManager.ts`). The renderer mirrors its open-task
 * snapshot here so panels can subscribe via Zustand selectors without
 * any per-component IPC traffic. Two channels feed this store:
 *
 *   1. **Snapshot** — `tasks.listV2()` IPC, called once when the
 *      consumer mounts (or on conversation change). Replaces the
 *      mirror with the authoritative current state.
 *   2. **Lifecycle deltas** — `ai:stream-event` of
 *      `{ type: 'task-v2:lifecycle', event, task }` pushed by
 *      `wireTaskManagerV2LifecycleBridge` in the main process. Each
 *      event mutates a single entry (insert / update / remove).
 *
 * No fs.watch — 星构Astra runs everything through Electron IPC so we
 * don't need upstream's filesystem signal layer.
 */

import { useCallback, useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { onStreamEvent } from '../services/electronAPI'
import type { StreamEvent } from '../types'

export type TaskV2Status =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface TaskV2 {
  taskId: string
  subject: string
  description?: string
  activeForm?: string
  status: TaskV2Status
  owner?: string
  source?: string
  blockedBy: string[]
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
  summary?: string
  runtimeKind?: string
  agentId?: string
  conversationId?: string
  parentTaskId?: string
}

interface TaskListV2StoreState {
  /** Indexed by `taskId` for O(1) lifecycle merges. */
  byId: Record<string, TaskV2>
  /** Last conversation the snapshot was scoped to (null = unfiltered). */
  scopedConversationId: string | null
  hydrate: (tasks: TaskV2[], conversationId: string | null) => void
  clear: () => void
  _apply: (event: StreamEvent) => void
}

/**
 * Sentinel scope meaning "no active conversation" (e.g. a freshly-opened chat
 * before the first message assigns a real conversationId). In this state the
 * panel must show NOTHING and accept NO lifecycle deltas — otherwise the
 * unfiltered snapshot leaks tasks from prior conversations / plan runs into
 * the new chat until the user sends a message. Distinct from `null`, which
 * historically meant "unfiltered / show all".
 */
export const NO_CONVERSATION_SCOPE = '\u0000__no_conversation__'

export const useTaskListV2Store = create<TaskListV2StoreState>()((set) => ({
  byId: {},
  scopedConversationId: null,
  hydrate: (tasks, conversationId) => {
    const byId: Record<string, TaskV2> = {}
    for (const t of tasks) byId[t.taskId] = t
    set({ byId, scopedConversationId: conversationId })
  },
  clear: () => set({ byId: {}, scopedConversationId: null }),
  _apply: (event) => {
    if (!event || event.type !== 'task-v2:lifecycle') return
    const evtKind = event.taskV2Event
    const task = event.taskV2Task as TaskV2 | undefined
    if (!task || typeof task.taskId !== 'string') return
    set((state) => {
      // No active conversation (freshly-opened chat): accept nothing so the
      // panel stays empty until a real conversationId exists.
      if (state.scopedConversationId === NO_CONVERSATION_SCOPE) return state
      // Honour the active scope: if a conversationId filter is in
      // force, drop tasks bound to other conversations. upstream's
      // `useTasksV2` does the equivalent via the fs path filter.
      if (
        state.scopedConversationId !== null &&
        task.conversationId &&
        task.conversationId !== state.scopedConversationId
      ) {
        return state
      }
      const next = { ...state.byId }
      if (evtKind === 'removed') {
        delete next[task.taskId]
      } else {
        next[task.taskId] = task
      }
      return { ...state, byId: next }
    })
  },
}))

let lifecycleStreamInstalled = false
let lifecycleStreamUnsubscribe: (() => void) | null = null

/**
 * Install the IPC subscription once per process. Matches the
 * `ensureTaskOutputStream` pattern — multiple consumers share one
 * listener so a 50-task panel doesn't fan out into 50 IPC bindings.
 */
export function ensureTaskListV2Stream(): void {
  if (lifecycleStreamInstalled) return
  lifecycleStreamInstalled = true
  try {
    const off = onStreamEvent((event) => {
      useTaskListV2Store.getState()._apply(event)
    })
    lifecycleStreamUnsubscribe = typeof off === 'function' ? off : null
  } catch {
    lifecycleStreamInstalled = false
    lifecycleStreamUnsubscribe = null
  }
}

/** Test / HMR teardown counterpart of {@link ensureTaskListV2Stream}. */
export function disposeTaskListV2Stream(): void {
  if (lifecycleStreamUnsubscribe) {
    try { lifecycleStreamUnsubscribe() } catch { /* noop */ }
    lifecycleStreamUnsubscribe = null
  }
  lifecycleStreamInstalled = false
}

/**
 * One-shot snapshot pull. Returns the number of tasks loaded (or 0
 * when the IPC channel isn't available — e.g. running outside
 * Electron).
 */
export async function refreshTaskListV2(
  conversationId?: string,
): Promise<number> {
  // No active conversation → empty panel. Without this the unscoped IPC
  // returns ALL persisted tasks (prior conversations / plan runs), which is
  // exactly the "stale task panel on a freshly-opened chat" bug. The panel
  // re-populates correctly once the first send assigns a real conversationId.
  if (!conversationId) {
    useTaskListV2Store.getState().hydrate([], NO_CONVERSATION_SCOPE)
    return 0
  }
  const api = (window as { electronAPI?: { tasks?: { listV2?: typeof window.electronAPI.tasks.listV2 } } }).electronAPI
  if (!api?.tasks?.listV2) return 0
  try {
    const { tasks } = await api.tasks.listV2({ conversationId })
    useTaskListV2Store.getState().hydrate(tasks as TaskV2[], conversationId)
    return tasks.length
  } catch (err) {
    console.warn('[useTaskListV2] refresh failed:', err)
    return 0
  }
}

/**
 * React hook: keep the store in sync with `conversationId`. Mount
 * → ensure subscription + initial snapshot pull. Change of
 * `conversationId` → re-snapshot.
 */
export function useTaskListV2Sync(conversationId: string | undefined): void {
  useEffect(() => {
    ensureTaskListV2Stream()
    void refreshTaskListV2(conversationId)
  }, [conversationId])
}

/**
 * Sorted-array view of the V2 task list (ascending by `createdAt`).
 *
 * Implementation note (audit P-1): the selector previously returned
 * `Object.values(s.byId).sort(...)` directly, which creates a brand-new
 * array reference on every store update — even unrelated updates
 * elsewhere in the store would have re-rendered every consumer.
 *
 * Fix: select the stable `byId` map first, then derive the sorted
 * array under a `useMemo` keyed on that reference. The map identity
 * only changes when `_apply` / `hydrate` / `clear` actually mutate
 * the store, so consumers only re-render on real data changes.
 */
export function useTaskListV2Snapshot(): TaskV2[] {
  const byId = useTaskListV2Store((s) => s.byId)
  return useMemo(
    () => Object.values(byId).sort((a, b) => a.createdAt - b.createdAt),
    [byId],
  )
}

/** Single-task selector — only re-renders when this id's record changes. */
export function useTaskV2(taskId: string | undefined): TaskV2 | undefined {
  return useTaskListV2Store(
    useCallback((s) => (taskId ? s.byId[taskId] : undefined), [taskId]),
  )
}
