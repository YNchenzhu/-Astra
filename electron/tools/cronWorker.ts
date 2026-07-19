/**
 * Cron scheduling worker thread.
 *
 * Runs the 1-second poll loop, cron expression parsing, file store management,
 * jitter calculation, and missed-task detection in a dedicated `worker_threads`
 * Worker so the Electron main process event loop stays free.
 *
 * Message protocol:
 *
 *   parent → worker
 *     { type: 'init', dataDir, reqId }
 *     { type: 'set-data-dir', dataDir }
 *     { type: 'shutdown' }
 *     { type: 'create', input, reqId }
 *     { type: 'delete', id, reqId }
 *     { type: 'list', reqId }
 *     { type: 'get', id, reqId }
 *
 *   worker → parent
 *     { type: 'cron-fire', task }          // task fired
 *     { type: 'result', reqId, payload }   // CRUD response
 *     { type: 'error', reqId, error }
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { parentPort } from 'node:worker_threads'

if (!parentPort) {
  throw new Error('[cronWorker] must be spawned as a worker_thread')
}
const port = parentPort

// ─── Constants ───

const MAX_CRON_TASKS = 50
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const POLL_INTERVAL_MS = 1000
const MAX_JITTER_MINUTES = 15

// ─── CronTask type ───

export type CronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  lastFiredAt?: number
  recurring?: boolean
  permanent?: boolean
  durable?: boolean
  agentId?: string
  label?: string
}

// ─── Cron parser ───

type CronField = { type: 'any' } | { type: 'values'; values: number[] }

function parseCronField(field: string, min: number, max: number): CronField {
  if (field === '*') return { type: 'any' }
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/)
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1
    const rangePart = stepMatch ? stepMatch[1] : part
    if (rangePart === '*') {
      for (let i = min; i <= max; i += step) values.add(i)
      continue
    }
    const rangeMatch = rangePart.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10)
      const end = parseInt(rangeMatch[2], 10)
      for (let i = start; i <= end; i += step) {
        if (i >= min && i <= max) values.add(i)
      }
      continue
    }
    const num = parseInt(rangePart, 10)
    if (!Number.isNaN(num) && num >= min && num <= max) values.add(num)
  }
  if (values.size === 0) return { type: 'any' }
  return { type: 'values', values: [...values].sort((a, b) => a - b) }
}

type ParsedCron = {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
}

function parseCronExpression(expr: unknown): ParsedCron | null {
  if (typeof expr !== 'string') return null
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dayOfMonth: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    dayOfWeek: parseCronField(parts[4], 0, 6),
  }
}

function fieldMatches(field: CronField, value: number): boolean {
  if (field.type === 'any') return true
  return field.values.includes(value)
}

function cronMatchesTime(parsed: ParsedCron, date: Date): boolean {
  return (
    fieldMatches(parsed.minute, date.getMinutes()) &&
    fieldMatches(parsed.hour, date.getHours()) &&
    fieldMatches(parsed.dayOfMonth, date.getDate()) &&
    fieldMatches(parsed.month, date.getMonth() + 1) &&
    fieldMatches(parsed.dayOfWeek, date.getDay())
  )
}

function validateCronExpression(expr: unknown): { valid: boolean; error?: string } {
  if (typeof expr !== 'string') return { valid: false, error: 'Cron expression must be a string' }
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    return { valid: false, error: `Expected 5 fields, got ${parts.length}` }
  }
  const parsed = parseCronExpression(expr)
  if (!parsed) return { valid: false, error: 'Invalid cron expression' }
  return { valid: true }
}

// ─── Jitter ───

function deterministicJitterMs(taskId: string, intervalMs: number): number {
  const hash = crypto.createHash('md5').update(taskId).digest()
  const frac = hash.readUInt32BE(0) / 0xFFFFFFFF
  const maxJitter = Math.min(intervalMs * 0.1, MAX_JITTER_MINUTES * 60_000)
  return Math.floor(frac * maxJitter)
}

// ─── Storage ───

const memoryTasks: CronTask[] = []
const fileTasks: CronTask[] = []
let scheduledTasksPath = ''
let pollTimer: NodeJS.Timeout | null = null
let fileWatcher: { close: () => void } | null = null
let lastFileReadMtime = 0

function allTasks(): CronTask[] {
  return [...fileTasks, ...memoryTasks]
}

function generateId(): string {
  return crypto.randomBytes(4).toString('hex')
}

function normalizeLegacyTask(raw: Record<string, unknown>): CronTask {
  const id = String(raw.id ?? generateId())
  let cron = typeof raw.cron === 'string' ? raw.cron : ''
  if (!cron && typeof raw.intervalMinutes === 'number') {
    cron = `*/${Math.max(1, Math.floor(raw.intervalMinutes as number))} * * * *`
  }
  return {
    id,
    cron: cron || '* * * * *',
    prompt: String(raw.prompt ?? raw.command ?? raw.label ?? ''),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    lastFiredAt: typeof raw.lastFiredAt === 'number' ? raw.lastFiredAt : undefined,
    recurring: raw.recurring !== false,
    permanent: raw.permanent === true,
    durable: raw.durable === true,
    agentId: typeof raw.agentId === 'string' ? raw.agentId : undefined,
    label: typeof raw.label === 'string' ? raw.label : undefined,
  }
}

function loadFileStore(): void {
  if (!scheduledTasksPath || !fs.existsSync(scheduledTasksPath)) return
  try {
    const stat = fs.statSync(scheduledTasksPath)
    lastFileReadMtime = stat.mtimeMs
    const raw = JSON.parse(fs.readFileSync(scheduledTasksPath, 'utf8'))
    const tasks = Array.isArray(raw) ? raw : (raw?.tasks ?? raw?.jobs ?? [])
    if (Array.isArray(tasks)) {
      fileTasks.splice(0, fileTasks.length)
      for (const t of tasks) {
        if (t && typeof t === 'object' && typeof t.id === 'string') {
          fileTasks.push(normalizeLegacyTask(t as Record<string, unknown>))
        }
      }
    }
  } catch { /* corrupted file */ }
}

function saveFileStore(): void {
  if (!scheduledTasksPath) return
  try {
    fs.mkdirSync(path.dirname(scheduledTasksPath), { recursive: true })
    fs.writeFileSync(scheduledTasksPath, JSON.stringify(fileTasks, null, 2), 'utf8')
    const stat = fs.statSync(scheduledTasksPath)
    lastFileReadMtime = stat.mtimeMs
  } catch (e) {
    console.warn('[cronWorker] Failed to save:', e)
  }
}

function startFileWatcher(): void {
  if (fileWatcher || !scheduledTasksPath) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chokidar = require('chokidar') as typeof import('chokidar')
    const watcher = chokidar.watch(scheduledTasksPath, {
      persistent: false,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200 },
    })
    watcher.on('change', () => {
      try {
        const stat = fs.statSync(scheduledTasksPath)
        if (stat.mtimeMs > lastFileReadMtime) loadFileStore()
      } catch { /* ignore */ }
    })
    fileWatcher = watcher
  } catch { /* chokidar not available */ }
}

function stopFileWatcher(): void {
  if (fileWatcher) {
    fileWatcher.close()
    fileWatcher = null
  }
}

function removeTaskById(id: string): void {
  const fi = fileTasks.findIndex((t) => t.id === id)
  if (fi >= 0) {
    fileTasks.splice(fi, 1)
    saveFileStore()
  }
  const mi = memoryTasks.findIndex((t) => t.id === id)
  if (mi >= 0) memoryTasks.splice(mi, 1)
}

// ─── Poll loop ───

function check(): void {
  const now = new Date()
  const nowMs = now.getTime()

  if (!fileWatcher && scheduledTasksPath) {
    try {
      if (fs.existsSync(scheduledTasksPath)) {
        const stat = fs.statSync(scheduledTasksPath)
        if (stat.mtimeMs > lastFileReadMtime) loadFileStore()
      }
    } catch { /* ignore */ }
  }

  const toRemove: string[] = []

  for (const task of allTasks()) {
    const parsed = parseCronExpression(task.cron)
    if (!parsed) continue

    if (!task.permanent && task.recurring !== false) {
      if (nowMs - task.createdAt > SEVEN_DAYS_MS) {
        toRemove.push(task.id)
        continue
      }
    }

    const shouldFire = cronMatchesTime(parsed, now)
    if (!shouldFire) continue

    if (task.lastFiredAt) {
      const lastFireDate = new Date(task.lastFiredAt)
      if (
        lastFireDate.getFullYear() === now.getFullYear() &&
        lastFireDate.getMonth() === now.getMonth() &&
        lastFireDate.getDate() === now.getDate() &&
        lastFireDate.getHours() === now.getHours() &&
        lastFireDate.getMinutes() === now.getMinutes()
      ) {
        continue
      }
    }

    if (task.recurring !== false) {
      const jitterMs = deterministicJitterMs(task.id, 60_000)
      if (now.getSeconds() * 1000 + now.getMilliseconds() < jitterMs % 60_000) {
        continue
      }
    }

    task.lastFiredAt = nowMs
    port.postMessage({ type: 'cron-fire', task })

    if (task.recurring === false) toRemove.push(task.id)
  }

  for (const id of toRemove) removeTaskById(id)
}

function detectMissedTasks(): void {
  const nowMs = Date.now()
  const missed: CronTask[] = []
  for (const task of allTasks()) {
    if (task.recurring !== false) continue
    if (task.lastFiredAt) continue
    const parsed = parseCronExpression(task.cron)
    if (!parsed) continue
    const minutesSinceCreation = (nowMs - task.createdAt) / 60_000
    if (minutesSinceCreation > 2 && minutesSinceCreation < 24 * 60) {
      missed.push(task)
    }
  }
  for (const task of missed) {
    task.lastFiredAt = nowMs
    port.postMessage({ type: 'cron-fire', task })
    removeTaskById(task.id)
  }
}

// ─── CRUD operations ───

interface HandleCreateInput {
  cron: string
  prompt: string
  recurring?: boolean
  durable?: boolean
  permanent?: boolean
  agentId?: string
  id?: string
  label?: string
}

function handleCreate(input: HandleCreateInput): CronTask | { error: string } {
  const validation = validateCronExpression(input.cron)
  if (!validation.valid) return { error: `Invalid cron expression: ${validation.error}` }
  if (allTasks().length >= MAX_CRON_TASKS) return { error: `Maximum ${MAX_CRON_TASKS} cron tasks reached.` }
  if (input.agentId && input.durable) return { error: 'Teammates cannot create durable cron tasks.' }

  const task: CronTask = {
    id: input.id?.trim() || generateId(),
    cron: input.cron.trim(),
    prompt: input.prompt,
    createdAt: Date.now(),
    recurring: input.recurring !== false,
    durable: input.durable === true,
    permanent: input.permanent === true,
    agentId: input.agentId,
    label: input.label,
  }

  if (task.durable) {
    fileTasks.push(task)
    saveFileStore()
  } else {
    memoryTasks.push(task)
  }
  return task
}

function handleDelete(id: string): boolean {
  const totalBefore = allTasks().length
  removeTaskById(id)
  return allTasks().length < totalBefore
}

// ─── Message dispatch ───

interface InMsg {
  type: string
  reqId?: number
  dataDir?: string
  input?: unknown
  id?: string
}

port.on('message', (msg: InMsg) => {
  try {
    switch (msg.type) {
      case 'init': {
        scheduledTasksPath = path.join(msg.dataDir!, 'scheduled_tasks.json')
        loadFileStore()
        startFileWatcher()
        detectMissedTasks()
        if (!pollTimer) {
          pollTimer = setInterval(check, POLL_INTERVAL_MS)
          // `unref()` exists on Node's Timeout but is absent in DOM-typed
          // setInterval return types; this worker only runs in Node so the
          // call is safe.  Keep the typeof guard purely as belt-and-braces
          // in case the worker is ever bundled for a non-Node target.
          if (typeof pollTimer.unref === 'function') pollTimer.unref()
        }
        port.postMessage({ type: 'result', reqId: msg.reqId, payload: { ok: true } })
        break
      }
      case 'set-data-dir': {
        scheduledTasksPath = path.join(msg.dataDir!, 'scheduled_tasks.json')
        loadFileStore()
        port.postMessage({ type: 'result', reqId: msg.reqId, payload: { ok: true } })
        break
      }
      case 'shutdown': {
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
        stopFileWatcher()
        port.postMessage({ type: 'result', reqId: msg.reqId, payload: { ok: true } })
        break
      }
      case 'create': {
        // `msg.input` is `unknown` because the parent->worker postMessage
        // contract is loosely typed.  Validate shape at the boundary:
        // `handleCreate` itself runs `validateCronExpression` on the cron
        // string, so callers passing a malformed payload come back with
        // `{ error: ... }` instead of crashing the worker.
        const result = handleCreate(msg.input as HandleCreateInput)
        port.postMessage({ type: 'result', reqId: msg.reqId, payload: result })
        break
      }
      case 'delete': {
        const deleted = handleDelete(msg.id!)
        port.postMessage({ type: 'result', reqId: msg.reqId, payload: { deleted } })
        break
      }
      case 'list': {
        port.postMessage({ type: 'result', reqId: msg.reqId, payload: { tasks: allTasks() } })
        break
      }
      case 'get': {
        const task = allTasks().find((t) => t.id === msg.id) ?? null
        port.postMessage({ type: 'result', reqId: msg.reqId, payload: { task } })
        break
      }
      default:
        port.postMessage({ type: 'error', reqId: msg.reqId, error: `unknown message type: ${msg.type}` })
    }
  } catch (err) {
    port.postMessage({
      type: 'error',
      reqId: msg.reqId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
})
