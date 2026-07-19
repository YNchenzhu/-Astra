/**
 * upstream 报告第十一章 §11.1-§11.3 — CronScheduler worker proxy.
 *
 * Phase 4: The 1-second poll loop, cron parsing, file store management,
 * jitter, and missed-task detection now run in a dedicated worker_threads
 * Worker (cronWorker.ts). This module is a thin async proxy.
 *
 * AC-11.1: 标准5字段cron表达式 + 50任务上限 + recurring/durable/permanent + Teammate限制
 * AC-11.2: chokidar监听 scheduled_tasks.json + 1s轮询 + jitter防雷群 + 7天自动过期 + missed task检测
 */

import type { CronTask } from './cronWorker'

// Re-export CronTask type for consumers
export type { CronTask } from './cronWorker'

// ─── Lazy-load the worker client ───

let _client: typeof import('./cronWorkerClient') | null = null

async function client(): Promise<typeof import('./cronWorkerClient')> {
  if (!_client) {
    _client = await import('./cronWorkerClient')
    // Apply any handler that was set before the client loaded.
    _client.applyDeferredCronFireHandler()
  }
  return _client
}

// ─── Public API (async proxy) ───

/** Initialize the cron scheduler in a worker thread. */
export async function initCronScheduler(dataDir: string): Promise<void> {
  const c = await client()
  await c.initCronSchedulerInWorker(dataDir)
}

/** Update the data directory at runtime (e.g. when user changes settings). */
export async function setCronSchedulerDataDir(dataDir: string): Promise<void> {
  const c = await client()
  await c.setCronSchedulerDataDirInWorker(dataDir)
}

/** Shutdown the cron scheduler and terminate the worker. */
export async function shutdownCronScheduler(): Promise<void> {
  const c = await client()
  await c.shutdownCronSchedulerInWorker()
}

/** Set the callback invoked when a cron task fires in the worker. */
export function setCronFireHandler(handler: ((task: CronTask) => void) | null): void {
  // If the client is already loaded, apply immediately.
  if (_client) {
    _client.setCronFireHandlerInWorker(handler)
    return
  }
  // Otherwise, store in global so client() can pick it up on first load.
  // The receiver in `cronWorkerClient.applyDeferredCronFireHandler` reads
  // through the same shape so we keep the cast tight here too.
  ;(globalThis as { __cronFireHandler?: ((task: CronTask) => void) | null }).__cronFireHandler = handler
}

export async function cronListJobs(): Promise<CronTask[]> {
  const c = await client()
  return c.cronListInWorker()
}

export async function cronCreate(input: {
  cron: string
  prompt: string
  recurring?: boolean
  durable?: boolean
  permanent?: boolean
  agentId?: string
  id?: string
  label?: string
}): Promise<CronTask | { error: string }> {
  const c = await client()
  return c.cronCreateInWorker(input)
}

export async function cronDelete(id: string): Promise<boolean> {
  const c = await client()
  return c.cronDeleteInWorker(id)
}

export async function cronGet(id: string): Promise<CronTask | null> {
  const c = await client()
  return c.cronGetInWorker(id)
}

// ─── Sync helpers (no worker needed) ───

// Cron expression validation is pure logic — keep it synchronous for callers
// like CronTools.ts that use it for pre-flight checks before the async CRUD.

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

export function validateCronExpression(expr: unknown): { valid: boolean; error?: string } {
  if (typeof expr !== 'string') return { valid: false, error: 'Cron expression must be a string' }
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    return { valid: false, error: `Expected 5 fields (minute hour day month weekday), got ${parts.length}` }
  }
  const parsed = parseCronExpression(expr)
  if (!parsed) return { valid: false, error: 'Invalid cron expression' }
  return { valid: true }
}

/** For back-compat with existing CronTools.ts that uses CronJobRecord */
export type CronJobRecord = CronTask
