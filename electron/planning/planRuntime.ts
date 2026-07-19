import fs from 'node:fs'
import path from 'node:path'
import { taskManager, type Task } from '../tools/TaskManager'

type PlanTodo = {
  content: string
  status?: 'pending' | 'in_progress' | 'completed'
  /**
   * 2026-07 uplift #4 — optional per-step file scope declared in the
   * plan-json block (paths or simple globs). Stored on the seeded task's
   * metadata (`planStepFiles`) and consumed by the plan-step scope
   * collector to flag out-of-scope edits.
   */
  files?: string[]
}

/** Caps for the declared per-step file scope so a runaway plan stays cheap. */
const MAX_STEP_FILES = 8
const MAX_STEP_FILE_CHARS = 200

function sanitizeStepFiles(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const files = raw
    .map((f) => String(f ?? '').trim())
    .filter((f) => f.length > 0 && f.length <= MAX_STEP_FILE_CHARS)
    .slice(0, MAX_STEP_FILES)
  return files.length > 0 ? files : undefined
}

type ParsedPlan = {
  name: string
  overview: string
  planMarkdown: string
  todos: PlanTodo[]
}

type ActivePlanState = {
  workspacePath: string
  planFilePath: string
  taskIds: string[]
  statusByTaskId: Record<string, Task['status']>
}

let activePlan: ActivePlanState | null = null
let listenerBound = false
/** Reentrancy guard: auto-advance calls `taskManager.update`, which re-fires
 *  the lifecycle listener — without this it could attempt to advance again. */
let autoAdvancing = false

function isPlanAutoAdvanceEnabled(): boolean {
  const raw = process.env.POLE_PLAN_AUTO_ADVANCE?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

/**
 * Host step driver (auto-advance). When a plan step finishes (completed /
 * failed / cancelled) and NO plan step is left `in_progress`, promote the
 * earliest remaining `pending` step to `in_progress` so the plan flows one
 * step at a time without relying on the model to remember to open the next
 * step. Domain-neutral (a "step" is any `source: 'plan'` task). Opt out via
 * `POLE_PLAN_AUTO_ADVANCE=0`.
 */
function maybeAutoAdvancePlanStep(): void {
  if (!activePlan || !isPlanAutoAdvanceEnabled()) return
  const tasks = activePlan.taskIds
    .map((id) => taskManager.getTask(id))
    .filter((t): t is Task => Boolean(t))
  if (tasks.some((t) => t.status === 'in_progress')) return
  const nextPending = tasks.find((t) => t.status === 'pending')
  if (!nextPending) return
  taskManager.update(nextPending.taskId, { status: 'in_progress' })
}

function ensurePlansDir(workspacePath: string): string {
  const dir = path.join(workspacePath, '.cursor', 'plans')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function toSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'plan'
}

function yamlQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

function parsePlanJsonBlock(raw: string): ParsedPlan | null {
  const fenced = raw.match(/```(?:plan-json|json)\s*([\s\S]*?)```/i)?.[1]
  if (!fenced) return null
  try {
    const obj = JSON.parse(fenced) as {
      name?: string
      overview?: string
      plan?: string
      todos?: Array<{ content?: string; status?: string; files?: unknown }>
    }
    const todos = Array.isArray(obj.todos)
      ? obj.todos
        .map((t) => {
          const files = sanitizeStepFiles(t.files)
          return {
            content: String(t.content || '').trim(),
            status: t.status as PlanTodo['status'] | undefined,
            ...(files ? { files } : {}),
          }
        })
        .filter((t) => t.content.length > 0)
      : []
    return {
      name: (obj.name || '').trim() || 'Plan',
      overview: (obj.overview || '').trim() || 'Auto-generated implementation plan.',
      planMarkdown: (obj.plan || '').trim() || raw.trim(),
      todos,
    }
  } catch {
    return null
  }
}

function parsePlanMarkdownFallback(raw: string): ParsedPlan {
  const lines = raw.split('\n')
  const title = (lines.find((l) => /^#\s+/.test(l)) || '').replace(/^#\s+/, '').trim() || 'Plan'
  const overview = lines.map((l) => l.trim()).find((l) =>
    l.length > 0 && !l.startsWith('#') && !l.startsWith('- ') && !/^\d+[).\s]/.test(l),
  ) || 'Auto-generated implementation plan.'

  const todos: PlanTodo[] = []
  for (const line of lines) {
    const m1 = line.trim().match(/^[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/)
    const m2 = line.trim().match(/^\d+[).\s]+(.+)$/)
    const content = (m1?.[1] || m2?.[1] || '').trim()
    if (content) todos.push({ content, status: 'pending' })
  }
  const deduped: PlanTodo[] = []
  const seen = new Set<string>()
  for (const t of todos) {
    if (seen.has(t.content)) continue
    seen.add(t.content)
    deduped.push(t)
  }

  return {
    name: title,
    overview,
    planMarkdown: raw.trim(),
    todos: deduped.slice(0, 12),
  }
}

function parsePlan(raw: string): ParsedPlan | null {
  const parsed = parsePlanJsonBlock(raw) || parsePlanMarkdownFallback(raw)
  if (!parsed || parsed.todos.length === 0) return null
  return parsed
}

function buildFrontmatter(name: string, overview: string, tasks: Task[]): string {
  const todoLines = tasks.map((t) => [
    `  - id: ${t.taskId}`,
    `    content: ${yamlQuote(t.subject)}`,
    `    status: ${t.status}`,
  ].join('\n')).join('\n')
  return [
    '---',
    `name: ${yamlQuote(name)}`,
    `overview: ${yamlQuote(overview)}`,
    'todos:',
    todoLines || '  []',
    'isProject: true',
    '---',
    '',
  ].join('\n')
}

function buildProgressBlock(tasks: Task[]): string {
  if (tasks.length === 0) return '- 暂无任务。'
  const done = tasks.filter((t) => t.status === 'completed').length
  const current = tasks.find((t) => t.status === 'in_progress')
  const header = current
    ? `当前进行：${current.subject}（${done}/${tasks.length} 已完成）`
    : `进度：${done}/${tasks.length} 已完成`
  const lines = tasks.map((t) => {
    const box = t.status === 'completed' ? '[x]' : '[ ]'
    const mark =
      t.status === 'in_progress' ? ' ⟳ 进行中'
        : t.status === 'failed' ? ' ✗ 失败'
          : t.status === 'cancelled' ? ' — 已取消'
            : ''
    return `- ${box} ${t.subject}${mark}`
  })
  return [header, '', ...lines].join('\n')
}

/**
 * Push a plan tab lifecycle event to the renderer over the same
 * `ai:stream-event` channel the rest of the app uses. Lazy-require keeps
 * `electron/window/mainWindow` (and thus `electron`) out of planRuntime's
 * import graph so unit tests importing this module don't need an Electron
 * stub. Best-effort: a missing window / read failure never blocks plan flow.
 */
function emitPlanEvent(type: 'plan:active' | 'plan:updated'): void {
  if (!activePlan) return
  try {
    const content = fs.existsSync(activePlan.planFilePath)
      ? fs.readFileSync(activePlan.planFilePath, 'utf-8')
      : ''
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy to avoid electron in test graph
    const { sendToMainWindow } = require('../window/mainWindow')
    sendToMainWindow('ai:stream-event', {
      type,
      planFilePath: activePlan.planFilePath,
      planContent: content,
    })
  } catch {
    /* best-effort; renderer falls back to the in-memory preview */
  }
}

function writePlanFile(planFilePath: string, name: string, overview: string, planMarkdown: string, tasks: Task[]): void {
  const content = [
    buildFrontmatter(name, overview, tasks),
    `# ${name}`,
    '',
    '## Plan',
    planMarkdown,
    '',
    '## Execution Progress',
    '<!-- PLAN_PROGRESS_START -->',
    buildProgressBlock(tasks),
    '<!-- PLAN_PROGRESS_END -->',
    '',
    '## Execution Log',
    '<!-- PLAN_EXEC_LOG_START -->',
    '<!-- PLAN_EXEC_LOG_END -->',
    '',
  ].join('\n')
  fs.writeFileSync(planFilePath, content, 'utf-8')
}

function replaceBetween(raw: string, startMarker: string, endMarker: string, replacement: string): string {
  const start = raw.indexOf(startMarker)
  const end = raw.indexOf(endMarker)
  if (start < 0 || end < 0 || end <= start) return raw
  const before = raw.slice(0, start + startMarker.length)
  const after = raw.slice(end)
  return `${before}\n${replacement}\n${after}`
}

function rewriteFrontmatterTodos(raw: string, tasks: Task[]): string {
  const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n/)
  if (!fmMatch) return raw
  const oldFm = fmMatch[0]
  const newTodos = [
    'todos:',
    ...tasks.map((t) => `  - id: ${t.taskId}\n    content: ${yamlQuote(t.subject)}\n    status: ${t.status}`),
  ].join('\n')
  const newFm = oldFm.replace(/todos:\n(?: {2}- id:[\s\S]*?)(?=\n[a-zA-Z_]+:|\n---)/m, `${newTodos}\n`)
  return raw.replace(oldFm, newFm)
}

function appendExecutionLog(planFilePath: string, line: string): void {
  if (!fs.existsSync(planFilePath)) return
  const raw = fs.readFileSync(planFilePath, 'utf-8')
  const startMarker = '<!-- PLAN_EXEC_LOG_START -->'
  const endMarker = '<!-- PLAN_EXEC_LOG_END -->'
  const start = raw.indexOf(startMarker)
  const end = raw.indexOf(endMarker)
  if (start < 0 || end < 0 || end <= start) return
  const current = raw.slice(start + startMarker.length, end).trim()
  const merged = current ? `${current}\n- ${line}` : `- ${line}`
  const next = replaceBetween(raw, startMarker, endMarker, merged)
  fs.writeFileSync(planFilePath, next, 'utf-8')
}

function syncFileFromTasks(): void {
  if (!activePlan) return
  if (!fs.existsSync(activePlan.planFilePath)) return
  const tasks = activePlan.taskIds
    .map((id) => taskManager.getTask(id))
    .filter((t): t is Task => Boolean(t))
  let raw = fs.readFileSync(activePlan.planFilePath, 'utf-8')
  raw = rewriteFrontmatterTodos(raw, tasks)
  raw = replaceBetween(raw, '<!-- PLAN_PROGRESS_START -->', '<!-- PLAN_PROGRESS_END -->', buildProgressBlock(tasks))
  fs.writeFileSync(activePlan.planFilePath, raw, 'utf-8')
  // Push the refreshed content so any open plan tab live-updates without
  // depending on a filesystem watcher firing for the `.cursor/` dotfolder.
  emitPlanEvent('plan:updated')
}

export function initPlanRuntime(): void {
  if (listenerBound) return
  listenerBound = true
  taskManager.subscribe((event) => {
    if (!activePlan) return

    // Audit Bug O1: the previous behavior appended **every** new task
    // to the active plan's task list, so any unrelated bash / skill /
    // TodoWrite task got absorbed into the plan file — progress counts
    // and front-matter were silently corrupted. Now a task only joins
    // the active plan if it was explicitly created with `source: 'plan'`
    // (e.g. by `persistPlanFromOutput` / ExitPlanMode) OR if its id was
    // pre-seeded when the plan was persisted.
    const alreadyInPlan = activePlan.taskIds.includes(event.task.taskId)
    if (!alreadyInPlan) {
      if (event.type === 'created' && event.task.source === 'plan') {
        activePlan.taskIds.push(event.task.taskId)
      } else {
        // Not ours — ignore.
        return
      }
    }

    const prevStatus = activePlan.statusByTaskId[event.task.taskId]
    if (prevStatus && prevStatus !== event.task.status) {
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
      appendExecutionLog(
        activePlan.planFilePath,
        `${ts} ${event.task.taskId}: ${prevStatus} -> ${event.task.status} (${event.task.subject})`,
      )
    }
    activePlan.statusByTaskId[event.task.taskId] = event.task.status

    // Host step driver: when a step just finished, open the next one.
    // Guarded against reentrancy (the promote re-fires this listener).
    if (
      !autoAdvancing &&
      (event.task.status === 'completed' ||
        event.task.status === 'failed' ||
        event.task.status === 'cancelled')
    ) {
      autoAdvancing = true
      try {
        maybeAutoAdvancePlanStep()
      } catch (e) {
        console.warn('[planRuntime] auto-advance failed:', e)
      } finally {
        autoAdvancing = false
      }
    }

    syncFileFromTasks()
  })
}

export function persistPlanFromOutput(params: {
  workspacePath: string
  rawOutput: string
  fallbackName: string
}): { planFilePath: string; seededTaskIds: string[] } | null {
  const parsed = parsePlan(params.rawOutput)
  if (!parsed) return null

  const plansDir = ensurePlansDir(params.workspacePath)
  const name = parsed.name || params.fallbackName || 'Plan'
  const file = `${toSlug(name)}_${Date.now().toString(36)}.plan.md`
  const planFilePath = path.join(plansDir, file)

  // Only nuke *plan-owned* todos, NOT the entire TaskManager (which is shared
  // with bash / skill / subagent / todo_sync tasks). The original code called
  // `taskManager.clear()` which would wipe every in-flight task the moment
  // the model entered plan mode — a serious regression risk that blocked
  // this module from being wired up historically.
  taskManager.deleteTasksBySource('plan')
  const createdTasks = parsed.todos.map((todo, index) => {
    const task = taskManager.create({
      subject: todo.content,
      activeForm: todo.content,
      description: index === 0 ? 'Seeded from plan output' : undefined,
      source: 'plan',
    })
    if (index === 0) {
      taskManager.update(task.taskId, { status: 'in_progress' })
    }
    // 2026-07 uplift #4 — persist the declared per-step file scope so the
    // plan-step scope collector can flag out-of-scope edits.
    if (todo.files && todo.files.length > 0) {
      taskManager.update(task.taskId, { metadata: { planStepFiles: todo.files } })
    }
    return taskManager.getTask(task.taskId)!
  })

  writePlanFile(planFilePath, name, parsed.overview, parsed.planMarkdown, createdTasks)
  activePlan = {
    workspacePath: params.workspacePath,
    planFilePath,
    taskIds: createdTasks.map((t) => t.taskId),
    statusByTaskId: Object.fromEntries(createdTasks.map((t) => [t.taskId, t.status])),
  }
  // Approval landed + file persisted: tell the renderer to open the real
  // plan tab (replacing the in-memory preview) and start live updates.
  emitPlanEvent('plan:active')
  return { planFilePath, seededTaskIds: activePlan.taskIds }
}

function parseFrontmatterTodos(raw: string): Array<{ content: string; status: Task['status'] }> {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/)?.[1]
  if (!fm) return []
  const lines = fm.split('\n')
  const todos: Array<{ content: string; status: Task['status'] }> = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('- id:')) continue
    const contentLine = lines[i + 1] || ''
    const statusLine = lines[i + 2] || ''
    // Mirror of `yamlQuote`: strip outer single quotes *and* unescape the
    // doubled-single-quote (`''` → `'`) sequence that `yamlQuote` introduces
    // for subjects containing apostrophes. Previously only the outer quotes
    // were stripped, which corrupted round-trips for content like
    // `don''t` → `don''t` instead of `don't`.
    const content = contentLine
      .replace(/^\s*content:\s*/, '')
      .trim()
      .replace(/^'([\s\S]*)'$/, '$1')
      .replace(/''/g, "'")
    const statusRaw = statusLine.replace(/^\s*status:\s*/, '').trim()
    const status: Task['status'] =
      statusRaw === 'completed' ? 'completed'
        : statusRaw === 'failed' ? 'failed'
          : statusRaw === 'in_progress' ? 'in_progress'
            : 'pending'
    if (content) todos.push({ content, status })
  }
  return todos
}

export function restoreLatestPlan(workspacePath: string): boolean {
  const plansDir = path.join(workspacePath, '.cursor', 'plans')
  if (!fs.existsSync(plansDir)) return false
  const mdFiles = fs.readdirSync(plansDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(plansDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  if (mdFiles.length === 0) return false

  const planFilePath = mdFiles[0]
  const raw = fs.readFileSync(planFilePath, 'utf-8')
  const todos = parseFrontmatterTodos(raw)
  if (todos.length === 0) return false

  // Same rationale as `persistPlanFromOutput`: only clear plan-scoped tasks
  // so we don't destroy bash / skill / subagent tasks the user may be
  // actively running when the workspace is restored.
  taskManager.deleteTasksBySource('plan')
  const recreated: Task[] = todos.map((t) => {
    const task = taskManager.create({
      subject: t.content,
      activeForm: t.content,
      source: 'plan',
    })
    // Preserve the persisted status verbatim, INCLUDING `in_progress`.
    // (Audit F-18: the previous code downgraded `in_progress` → `pending` on
    // restore, which lost the "this is the current step" marker — exactly the
    // signal the plan-step driver and goal recitation key on. A plan restored
    // after a restart should resume its current step, not forget where it was.)
    if (t.status !== 'pending') {
      taskManager.update(task.taskId, { status: t.status })
    }
    return taskManager.getTask(task.taskId)!
  })

  const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Plan'
  activePlan = {
    workspacePath,
    planFilePath,
    taskIds: recreated.map((t) => t.taskId),
    statusByTaskId: Object.fromEntries(recreated.map((t) => [t.taskId, t.status])),
  }
  appendExecutionLog(
    planFilePath,
    `${new Date().toISOString().replace('T', ' ').slice(0, 19)} resumed from latest plan (${title})`,
  )
  syncFileFromTasks()
  return true
}

/**
 * Drop the in-memory active plan. Production seam — called on work-package
 * (bundle) switch so the previous bundle's plan path / progress does not
 * leak into the new work package's UI or post-compact rehydration. The
 * persisted `.plan.md` file is left on disk untouched; only the live pointer
 * is cleared (a later ExitPlanMode or restore re-binds it).
 */
export function clearActivePlan(): void {
  activePlan = null
}

export interface ActivePlanStep {
  taskId: string
  subject: string
  status: Task['status']
  /** Declared per-step file scope (paths / simple globs), when present. */
  files?: string[]
}

function stepFilesFromTask(task: Task): string[] | undefined {
  return sanitizeStepFiles(task.metadata?.planStepFiles)
}

/**
 * Ordered snapshot of the active plan's steps (in plan order). Returns `null`
 * when there is no active plan. Used by the plan-step driver
 * (`electron/ai/agenticLoop/planStepGuard.ts`) to surface the current step and
 * intercept a premature "done" while open steps remain. Domain-neutral: a
 * "step" is just a tracked plan task, valid for any work package.
 */
export function getActivePlanStepsSnapshot(): {
  planFilePath: string
  steps: ActivePlanStep[]
} | null {
  if (!activePlan) return null
  const steps: ActivePlanStep[] = activePlan.taskIds
    .map((id) => taskManager.getTask(id))
    .filter((t): t is Task => Boolean(t))
    .map((t) => {
      const files = stepFilesFromTask(t)
      return {
        taskId: t.taskId,
        subject: t.subject,
        status: t.status,
        ...(files ? { files } : {}),
      }
    })
  return { planFilePath: activePlan.planFilePath, steps }
}

export function getActivePlanStatus(): {
  planFilePath: string
  total: number
  pending: number
  inProgress: number
  completed: number
} | null {
  if (!activePlan) return null
  const tasks = activePlan.taskIds
    .map((id) => taskManager.getTask(id))
    .filter((t): t is Task => Boolean(t))
  return {
    planFilePath: activePlan.planFilePath,
    total: tasks.length,
    pending: tasks.filter((t) => t.status === 'pending').length,
    inProgress: tasks.filter((t) => t.status === 'in_progress').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
  }
}
