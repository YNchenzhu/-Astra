/**
 * TaskManager — shared in-memory task store for V2 task tools.
 *
 * Provides CRUD operations on tasks with status tracking, dependencies,
 * and metadata. Used by TaskListTool, TaskUpdateTool, and TaskStopTool.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AgentId } from '../tools/ids'
import { writeJsonFileAtomic } from '../fs/atomicWrite'

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

export interface Task {
  taskId: string
  subject: string
  description?: string
  activeForm?: string
  status: TaskStatus
  owner?: string
  /** When `'user'`, lifecycle hooks may treat the task as user-originated (e.g. memory extraction). */
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
  agentId?: AgentId
  conversationId?: string
  parentTaskId?: string
  outputChunks: Array<{ channel: string; text: string; ts: number }>
  outputCursor: number
  /** P1-22: lifetime count of chunks dropped from the front of `outputChunks` once the per-task cap was exceeded. */
  outputDroppedCount?: number
}

/**
 * P1-22 — per-task chunk cap. Without this `outputChunks` was unbounded:
 * a long-running bash/skill task could OOM the main process AND every
 * 280ms the entire task list (incl. all chunks) was rewritten to disk.
 *
 * Tunable via `POLE_TASK_OUTPUT_MAX_CHUNKS`.
 */
const MAX_OUTPUT_CHUNKS_PER_TASK = Math.max(
  64,
  Math.min(50_000, Number(process.env.POLE_TASK_OUTPUT_MAX_CHUNKS ?? '2000')),
)

export type TaskLifecycleEvent =
  | { type: 'created'; task: Task }
  | { type: 'started'; task: Task }
  | { type: 'completed'; task: Task }
  | { type: 'failed'; task: Task }
  /** P1-20: emitted on user-cancellation / TaskStop. Distinct from 'failed'. */
  | { type: 'cancelled'; task: Task }
  | { type: 'output'; task: Task }
  | { type: 'removed'; task: Task }

let scheduleTaskManagerPersist: () => void = () => {}

class TaskManager {
  private tasks = new Map<string, Task>()
  private counter = 0
  private lifecycleListeners: Array<(e: TaskLifecycleEvent) => void> = []
  private stopHandlers = new Map<string, (task: Task) => void>()

  /** For JSON snapshot only. */
  counterSnapshot(): number {
    return this.counter
  }

  private nextId(): string {
    this.counter++
    return `task-${Date.now()}-${this.counter}`
  }

  listTasks(): Task[] {
    return [...this.tasks.values()]
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  subscribe(listener: (e: TaskLifecycleEvent) => void): () => void {
    this.lifecycleListeners.push(listener)
    return () => {
      const i = this.lifecycleListeners.indexOf(listener)
      if (i >= 0) this.lifecycleListeners.splice(i, 1)
    }
  }

  private emitLifecycle(event: TaskLifecycleEvent): void {
    for (const fn of this.lifecycleListeners) {
      try {
        fn(event)
      } catch (err) {
        console.warn('[TaskManager] lifecycle listener error:', err)
      }
    }
  }

  create(params: {
    subject: string
    description?: string
    activeForm?: string
    owner?: string
    source?: string
    /** Initial status (default `pending`). `in_progress` sets `startedAt`. */
    status?: TaskStatus
    addBlocks?: string[]
    addBlockedBy?: string[]
    summary?: string
    runtimeKind?: string
    agentId?: AgentId
    conversationId?: string
    parentTaskId?: string
    metadata?: Record<string, unknown>
  }): Task {
    const taskId = this.nextId()
    const now = Date.now()
    const allowedStatus: TaskStatus[] = [
      'pending',
      'in_progress',
      'completed',
      'failed',
      'cancelled',
    ]
    const initialStatus: TaskStatus =
      params.status && allowedStatus.includes(params.status) ? params.status : 'pending'

    let startedAt: number | undefined
    let finishedAt: number | undefined
    if (initialStatus === 'in_progress') {
      startedAt = now
    }
    if (
      initialStatus === 'completed' ||
      initialStatus === 'failed' ||
      initialStatus === 'cancelled'
    ) {
      startedAt = now
      finishedAt = now
    }

    const task: Task = {
      taskId,
      subject: params.subject,
      description: params.description,
      activeForm: params.activeForm,
      status: initialStatus,
      owner: params.owner,
      source: params.source ?? 'system',
      blockedBy: params.addBlockedBy || [],
      metadata: params.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      startedAt,
      finishedAt,
      summary: params.summary,
      runtimeKind: params.runtimeKind,
      agentId: params.agentId,
      conversationId: params.conversationId,
      parentTaskId: params.parentTaskId,
      outputChunks: [],
      outputCursor: 0,
    }
    this.tasks.set(taskId, task)
    if (params.addBlocks?.length) {
      for (const oid of params.addBlocks) {
        if (typeof oid !== 'string' || !oid.trim()) continue
        const other = this.tasks.get(oid.trim())
        if (other && !other.blockedBy.includes(taskId)) {
          other.blockedBy.push(taskId)
          other.updatedAt = Date.now()
        }
      }
    }
    this.emitLifecycle({ type: 'created', task: { ...task } })
    if (initialStatus === 'in_progress') {
      this.emitLifecycle({ type: 'started', task: { ...task } })
    }
    scheduleTaskManagerPersist()
    return task
  }

  update(taskId: string, updates: {
    subject?: string
    description?: string
    activeForm?: string
    status?: TaskStatus | 'deleted'
    owner?: string
    source?: string
    addBlocks?: string[]
    addBlockedBy?: string[]
    metadata?: Record<string, unknown>
  }): { task: Task | null; updatedFields: string[]; statusChange?: { from: string; to: string } } {
    const task = this.tasks.get(taskId)
    if (!task) return { task: null, updatedFields: [] }

    // Handle deletion
    if (updates.status === 'deleted') {
      const removed = { ...task }
      this.tasks.delete(taskId)
      // P1-21: emit `removed` so subscribers (UI panels, lifecycle hooks)
      // can drop the row instead of leaving a stale entry on screen.
      this.emitLifecycle({ type: 'removed', task: removed })
      scheduleTaskManagerPersist()
      return { task: null, updatedFields: ['status'] }
    }

    const updatedFields: string[] = []
    const statusChange = updates.status && updates.status !== task.status
      ? { from: task.status, to: updates.status }
      : undefined

    if (updates.subject !== undefined) { task.subject = updates.subject; updatedFields.push('subject') }
    if (updates.description !== undefined) { task.description = updates.description; updatedFields.push('description') }
    if (updates.activeForm !== undefined) { task.activeForm = updates.activeForm; updatedFields.push('activeForm') }
    if (updates.status !== undefined) {
      task.status = updates.status
      if (updates.status === 'in_progress' && !task.startedAt) {
        task.startedAt = Date.now()
      }
      updatedFields.push('status')
    }
    if (updates.owner !== undefined) { task.owner = updates.owner; updatedFields.push('owner') }
    if (updates.source !== undefined) { task.source = updates.source; updatedFields.push('source') }
    if (updates.addBlockedBy) {
      for (const id of updates.addBlockedBy) {
        if (!task.blockedBy.includes(id)) task.blockedBy.push(id)
      }
      updatedFields.push('blockedBy')
    }
    if (updates.addBlocks?.length) {
      for (const oid of updates.addBlocks) {
        if (typeof oid !== 'string' || !oid.trim()) continue
        const other = this.tasks.get(oid.trim())
        if (other && !other.blockedBy.includes(taskId)) {
          other.blockedBy.push(taskId)
          other.updatedAt = Date.now()
        }
      }
      updatedFields.push('blockedBy')
    }
    if (updates.metadata) {
      task.metadata = { ...task.metadata, ...updates.metadata }
      updatedFields.push('metadata')
    }

    task.updatedAt = Date.now()

    if (statusChange?.to === 'completed' || statusChange?.to === 'failed' || statusChange?.to === 'cancelled') {
      task.finishedAt = Date.now()
    }
    if (statusChange?.to === 'completed') {
      this.emitLifecycle({ type: 'completed', task: { ...task } })
    }
    if (statusChange?.to === 'failed') {
      this.emitLifecycle({ type: 'failed', task: { ...task } })
    }

    scheduleTaskManagerPersist()
    return { task, updatedFields, statusChange }
  }

  findByStatus(status: TaskStatus): Task[] {
    return [...this.tasks.values()].filter(t => t.status === status)
  }

  /**
   * `true` when any managed task is still open (`pending` / `in_progress`).
   * Used by goal recitation (audit P2-V2) to decide whether to re-surface a
   * captured objective in V2 / `v2-only` flows where there is no V1 todo
   * list to anchor the recitation.
   */
  hasOpenTasks(): boolean {
    for (const t of this.tasks.values()) {
      if (t.status === 'pending' || t.status === 'in_progress') return true
    }
    return false
  }

  stop(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task) return Promise.resolve(false)
    // TaskStop / user cancel: allow pending (TaskUpdate default) and in_progress.
    if (task.status !== 'in_progress' && task.status !== 'pending') {
      return Promise.resolve(false)
    }
    const wasInProgress = task.status === 'in_progress'
    task.status = 'cancelled'
    task.finishedAt = Date.now()
    task.updatedAt = Date.now()
    // P1-20: emit `cancelled` so subscribers can distinguish a user-initiated
    // stop from a real failure. Previously this fired `{ type: 'failed' }`
    // with `task.status === 'cancelled'` — the UI treated stops as errors.
    this.emitLifecycle({ type: 'cancelled', task: { ...task } })
    const handler = this.stopHandlers.get(taskId)
    this.stopHandlers.delete(taskId)
    if (wasInProgress && handler) handler(task)
    scheduleTaskManagerPersist()
    return Promise.resolve(true)
  }

  clear(): void {
    this.tasks.clear()
    this.counter = 0
    scheduleTaskManagerPersist()
  }

  /**
   * Delete all tasks whose {@link Task.source} matches `source`.
   * Used by plan-runtime reseed so plan tasks get rewritten without
   * nuking bash / skill / subagent / todo_sync tasks.
   */
  deleteTasksBySource(source: string): number {
    let removed = 0
    for (const [id, task] of this.tasks) {
      if (task.source === source) {
        this.tasks.delete(id)
        this.emitLifecycle({ type: 'removed', task })
        removed++
      }
    }
    if (removed > 0) scheduleTaskManagerPersist()
    return removed
  }

  /**
   * Start a pending task, moving it to `in_progress`.
   *
   * Audit fix R8 (2026-05) — strict behaviour: returns `null` and logs a
   * warning for unknown `taskId`. Previously this silently created a
   * phantom row (`subject: taskId`, `source: 'system'`) which broadcast a
   * spurious `created` lifecycle event, occupied a renderer list slot,
   * and triggered a disk persist — all from a single mistyped id.
   *
   * Callers that genuinely want create-or-start semantics should call
   * {@link ensureTask} first, then `start`:
   *
   * ```ts
   * taskManager.ensureTask('worker-7', { subject: 'background job' })
   * taskManager.start('worker-7', 'bash')
   * ```
   */
  start(taskId: string, runtimeKind?: string): Task | null {
    const task = this.tasks.get(taskId)
    if (!task) {
      console.warn(
        `[TaskManager] start("${taskId}") refused — unknown task id. ` +
          `Use taskManager.ensureTask() first if a placeholder is intended, ` +
          `or taskManager.create({ subject, ... }) for a tracked task.`,
      )
      return null
    }
    if (task.status !== 'pending') return task
    task.status = 'in_progress'
    task.startedAt = Date.now()
    task.runtimeKind = runtimeKind ?? task.runtimeKind
    task.updatedAt = Date.now()
    this.emitLifecycle({ type: 'started', task: { ...task } })
    scheduleTaskManagerPersist()
    return task
  }

  /**
   * Audit fix R8 (2026-05) — explicit create-or-return helper.
   *
   * Idempotent: returns the existing task if `taskId` is already known,
   * otherwise creates a `pending` placeholder with the supplied defaults
   * (or `subject: taskId, source: 'system'` to match the legacy
   * `start()` / `appendOutput()` auto-create fallback).
   *
   * Use this when a caller legitimately wants the "create if missing"
   * semantics that `start()` and `appendOutput()` no longer provide.
   */
  ensureTask(
    taskId: string,
    defaults?: { subject?: string; runtimeKind?: string; source?: string },
  ): Task {
    const existing = this.tasks.get(taskId)
    if (existing) return existing
    const now = Date.now()
    const task: Task = {
      taskId,
      subject: defaults?.subject ?? taskId,
      status: 'pending',
      source: defaults?.source ?? 'system',
      runtimeKind: defaults?.runtimeKind,
      blockedBy: [],
      metadata: {},
      createdAt: now,
      updatedAt: now,
      outputChunks: [],
      outputCursor: 0,
    }
    this.tasks.set(taskId, task)
    this.emitLifecycle({ type: 'created', task: { ...task } })
    scheduleTaskManagerPersist()
    return task
  }

  /** Mark a running task as completed with an optional summary. */
  markCompleted(taskId: string, opts?: { summary?: string } | string): Task | null {
    const task = this.tasks.get(taskId)
    if (!task) return null
    if (task.status !== 'in_progress') return task
    task.status = 'completed'
    task.finishedAt = Date.now()
    const summary = typeof opts === 'string' ? opts : opts?.summary
    if (summary) task.summary = summary
    task.updatedAt = Date.now()
    this.emitLifecycle({ type: 'completed', task: { ...task } })
    scheduleTaskManagerPersist()
    return task
  }

  /** Mark a running task as failed with an optional error message. */
  markFailed(taskId: string, error?: string): Task | null {
    const task = this.tasks.get(taskId)
    if (!task) return null
    if (task.status !== 'in_progress') return task
    task.status = 'failed'
    task.finishedAt = Date.now()
    if (error) task.error = error
    task.updatedAt = Date.now()
    this.emitLifecycle({ type: 'failed', task: { ...task } })
    scheduleTaskManagerPersist()
    return task
  }

  /**
   * Append output (stdout/stderr) to a task's buffer.
   *
   * Audit fix R8 (2026-05) — strict behaviour: drops the output and warns
   * for unknown `taskId`. The previous silent auto-create produced
   * phantom rows whenever a caller had a typo or stale id; the drop here
   * makes that regression loud instead. Callers that need create-or-append
   * should call {@link ensureTask} first.
   */
  appendOutput(taskId: string, channel: string, text: string): void {
    const task = this.tasks.get(taskId)
    if (!task) {
      console.warn(
        `[TaskManager] appendOutput("${taskId}", "${channel}") dropping output — ` +
          `unknown task id. Call taskManager.ensureTask("${taskId}") first if this is intended.`,
      )
      return
    }
    task.outputChunks.push({ channel, text, ts: Date.now() })
    // P1-22: enforce per-task chunk cap. FIFO drop from the head — the
    // tail (most recent output) is what TaskOutputTool tails surface and
    // what users care about. The lifetime drop count is reported back so
    // consumers can flag truncation.
    if (task.outputChunks.length > MAX_OUTPUT_CHUNKS_PER_TASK) {
      const drop = task.outputChunks.length - MAX_OUTPUT_CHUNKS_PER_TASK
      task.outputChunks.splice(0, drop)
      task.outputDroppedCount = (task.outputDroppedCount ?? 0) + drop
    }
    task.outputCursor = task.outputChunks.length
    task.updatedAt = Date.now()
    this.emitLifecycle({ type: 'output', task: { ...task } })
    scheduleTaskManagerPersist()
  }

  /** Get a slice of output chunks starting from `after`. Returns { items, hasMore, nextOffset }. */
  getOutputSlice(taskId: string, after: number = 0, limit?: number): { items: Task['outputChunks']; hasMore: boolean; nextOffset: number } | null {
    const task = this.tasks.get(taskId)
    if (!task) return null
    const all = task.outputChunks
    const slice = all.slice(after)
    if (limit !== undefined && limit > 0 && slice.length > limit) {
      return { items: slice.slice(0, limit), hasMore: true, nextOffset: after + limit }
    }
    return { items: slice, hasMore: false, nextOffset: after + slice.length }
  }

  /** Find tasks by conversation ID. */
  findByConversation(conversationId: string): Task[] {
    return [...this.tasks.values()].filter(t => t.conversationId === conversationId)
  }

  /** Find tasks by agent ID. */
  findByAgent(agentId: AgentId): Task[] {
    return [...this.tasks.values()].filter(t => t.agentId === agentId)
  }

  /**
   * upstream parity (`unassignTeammateTasks`): when an agent terminates,
   * clear `owner` on any still-OPEN task structurally bound to that
   * agent. The task itself is preserved (V2 task list is persistent
   * across agent deaths by design); only the ownership label is
   * released so a future agent / auto-claim path can pick the work
   * back up.
   *
   * Closed tasks (`completed` / `failed` / `cancelled`) keep their
   * `owner` for historical attribution.
   *
   * Returns the number of tasks whose `owner` was cleared.
   */
  unassignTasksForAgent(agentId: AgentId): number {
    let cleared = 0
    for (const task of this.tasks.values()) {
      if (task.agentId !== agentId) continue
      if (task.status !== 'pending' && task.status !== 'in_progress') continue
      if (task.owner === undefined) continue
      task.owner = undefined
      task.updatedAt = Date.now()
      // Emit a synthetic `output` event (chosen because it doesn't
      // alter status semantics) so subscribers — particularly the
      // renderer's `useTaskListV2Store` — refresh the row.
      this.emitLifecycle({ type: 'output', task: { ...task } })
      cleared++
    }
    if (cleared > 0) scheduleTaskManagerPersist()
    return cleared
  }

  /** Find child tasks of a given parent. */
  findChildren(parentTaskId: string): Task[] {
    return [...this.tasks.values()].filter(t => t.parentTaskId === parentTaskId)
  }

  /** Clear all tasks for a specific conversation. */
  clearConversation(conversationId: string): void {
    let removed = 0
    for (const [id, task] of this.tasks) {
      if (task.conversationId === conversationId) {
        this.tasks.delete(id)
        // P1-21: emit `removed` per task so panels scoped to this
        // conversation drop the rows in real time.
        this.emitLifecycle({ type: 'removed', task: { ...task } })
        removed++
      }
    }
    if (removed > 0) scheduleTaskManagerPersist()
  }

  /** Register a handler called when a task is stopped via stop(). */
  setStopHandler(taskId: string, handler: (task: Task) => void): void {
    this.stopHandlers.set(taskId, handler)
  }

  /** Restore from disk after restart (best-effort validation). */
  loadPersistedSnapshot(tasks: Task[], nextCounter: number): void {
    this.tasks.clear()
    const recoveryNow = Date.now()
    for (const t of tasks) {
      if (!t || typeof t.taskId !== 'string' || !t.subject) continue
      // P1-23: previously any `in_progress` task was silently downgraded to
      // `pending`. But this snapshot is loaded exactly once at app startup
      // (see `initTaskManagerPersistence`) — by that point the bash / skill
      // / subagent / cron process that was driving the task is already dead.
      // Downgrading to 'pending' detached the row from any producer and
      // left it stuck forever; the UI showed it as "queued, will start
      // soon" while nothing was scheduled.
      // Resolve them as 'failed' with an explicit recovery error so the
      // user sees what happened and can manually retry.
      let status: TaskStatus
      let error = t.error
      let finishedAt = t.finishedAt
      if (t.status === 'in_progress') {
        status = 'failed'
        error =
          error ??
          'Task was running when the app shut down — runtime process no longer attached. Re-run the task to continue.'
        finishedAt = finishedAt ?? recoveryNow
      } else if (
        t.status === 'pending' ||
        t.status === 'completed' ||
        t.status === 'failed' ||
        t.status === 'cancelled'
      ) {
        status = t.status
      } else {
        status = 'pending'
      }
      this.tasks.set(t.taskId, {
        ...t,
        status,
        ...(error !== undefined ? { error } : {}),
        ...(finishedAt !== undefined ? { finishedAt } : {}),
        outputChunks: t.outputChunks || [],
        outputCursor: t.outputCursor || 0,
        blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy : [],
        metadata: t.metadata && typeof t.metadata === 'object' ? t.metadata : {},
      })
    }
    this.counter = Math.max(this.counter, nextCounter, 0)
  }
}

export const taskManager = new TaskManager()

let persistUserData: string | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null

function taskManagerPersistPath(): string {
  return path.join(persistUserData!, 'v2-task-manager.json')
}

function runScheduleTaskManagerPersist(): void {
  if (!persistUserData) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      writeJsonFileAtomic(taskManagerPersistPath(), {
        v: 1,
        counter: taskManager.counterSnapshot(),
        tasks: taskManager.listTasks(),
      })
    } catch (e) {
      console.warn('[TaskManager] persist failed:', e)
    }
  }, 280)
}

scheduleTaskManagerPersist = runScheduleTaskManagerPersist

/** Call once at app startup; restores tasks from userData and enables debounced saves. */
export function initTaskManagerPersistence(userDataPath: string): void {
  persistUserData = userDataPath
  const p = taskManagerPersistPath()
  if (fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
        tasks?: Task[]
        counter?: number
      }
      if (Array.isArray(raw.tasks)) {
        taskManager.loadPersistedSnapshot(
          raw.tasks,
          typeof raw.counter === 'number' ? raw.counter : 0,
        )
      }
    } catch {
      /* ignore corrupt snapshot */
    }
  }
}
