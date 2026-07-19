/**
 * Cron worker thread client — main-process shim over worker_thread.
 *
 * Spawns cronWorker.ts for 1-second poll loop + cron parsing + storage,
 * keeping the Electron main process event loop free.
 */

import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { CronTask } from './cronScheduler'

interface PendingReq {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

let cronWorker: Worker | null = null
let cronWorkerError: Error | null = null
let reqSeq = 0
const pending = new Map<number, PendingReq>()

/** Set when a cron fires in the worker — mirror of `setCronFireHandler`. */
let onCronFire: ((task: CronTask) => void) | null = null

function resolveWorkerPath(): string {
  return path.join(__dirname, 'cronWorker.js')
}

function ensureWorker(): Worker {
  if (cronWorker) return cronWorker
  const workerPath = resolveWorkerPath()
  console.log(`[cronWorkerClient] spawning worker at ${workerPath}`)
  cronWorker = new Worker(workerPath)

  cronWorker.on('message', (msg: Record<string, unknown>) => {
    const reqId = typeof msg.reqId === 'number' ? msg.reqId : -1
    // cron-fire events are not tied to a reqId
    if (msg.type === 'cron-fire') {
      try {
        onCronFire?.(msg.task as CronTask)
      } catch { /* noop */ }
      return
    }
    const p = pending.get(reqId)
    if (!p) return
    pending.delete(reqId)
    if (msg.type === 'error') {
      p.reject(new Error(String(msg.error ?? 'unknown cron worker error')))
    } else {
      p.resolve(msg)
    }
  })

  cronWorker.on('error', (err) => {
    console.error('[cronWorkerClient] worker error:', err)
    cronWorkerError = err
    for (const [, p] of pending) {
      try { p.reject(err) } catch { /* noop */ }
    }
    pending.clear()
    cronWorker = null
  })

  cronWorker.on('exit', (code) => {
    console.warn(`[cronWorkerClient] worker exited with code ${code}`)
    cronWorker = null
  })

  return cronWorker
}

function sendToWorker<T>(
  msg: { type: string; reqId?: number; dataDir?: string; input?: unknown; id?: string },
): Promise<T> {
  const w = ensureWorker()
  const reqId = ++reqSeq
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject })
    try {
      w.postMessage({ ...msg, reqId })
    } catch (err) {
      pending.delete(reqId)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

// ─── Public API (mirrors cronScheduler.ts exports) ───

export async function initCronSchedulerInWorker(dataDir: string): Promise<void> {
  await sendToWorker({ type: 'init', dataDir })
}

export async function setCronSchedulerDataDirInWorker(dataDir: string): Promise<void> {
  await sendToWorker({ type: 'set-data-dir', dataDir })
}

export async function shutdownCronSchedulerInWorker(): Promise<void> {
  await sendToWorker({ type: 'shutdown' })
  const w = cronWorker
  cronWorker = null
  cronWorkerError = null
  if (w) {
    w.terminate().catch(() => { /* noop */ })
  }
}

export function setCronFireHandlerInWorker(handler: ((task: CronTask) => void) | null): void {
  onCronFire = handler
}

/** Apply any handler that was set via globalThis before the client loaded. */
export function applyDeferredCronFireHandler(): void {
  // Narrow type instead of `any` cast — the deferred-handler bridge is the
  // only place this property exists, so a single shape declared inline keeps
  // the global type pollution local to this function.
  type CronGlobal = { __cronFireHandler?: (task: CronTask) => void }
  const g = globalThis as CronGlobal
  const h = g.__cronFireHandler
  if (h && !onCronFire) {
    onCronFire = h
    delete g.__cronFireHandler
  }
}

export async function cronCreateInWorker(input: {
  cron: string
  prompt: string
  recurring?: boolean
  durable?: boolean
  permanent?: boolean
  agentId?: string
  id?: string
  label?: string
}): Promise<CronTask | { error: string }> {
  const res = await sendToWorker<{ payload: CronTask | { error: string } }>({ type: 'create', input })
  return res.payload
}

export async function cronDeleteInWorker(id: string): Promise<boolean> {
  const res = await sendToWorker<{ payload: { deleted: boolean } }>({ type: 'delete', id })
  return res.payload.deleted
}

export async function cronListInWorker(): Promise<CronTask[]> {
  const res = await sendToWorker<{ payload: { tasks: CronTask[] } }>({ type: 'list' })
  return res.payload.tasks
}

export async function cronGetInWorker(id: string): Promise<CronTask | null> {
  const res = await sendToWorker<{ payload: { task: CronTask | null } }>({ type: 'get', id })
  return res.payload.task
}

export function cronWorkerAvailable(): boolean {
  return cronWorker !== null && cronWorkerError === null
}
