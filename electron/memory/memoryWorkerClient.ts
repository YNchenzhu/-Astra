/**
 * Memory worker thread client — main-process shim over worker_thread.
 *
 * Spawns memoryWorker.ts for consolidation operations, keeping the main
 * process event loop free during 5-pass pipeline scans.
 */

import path from 'node:path'
import { Worker } from 'node:worker_threads'

interface PendingReq {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  onProgress?: (msg: Record<string, unknown>) => void
}

let memoryWorker: Worker | null = null
let memoryWorkerError: Error | null = null
let reqSeq = 0
const pending = new Map<number, PendingReq>()

function resolveWorkerPath(): string {
  return path.join(__dirname, 'memoryWorker.js')
}

function ensureWorker(): Worker {
  if (memoryWorker) return memoryWorker
  const workerPath = resolveWorkerPath()
  console.log(`[memoryWorkerClient] spawning worker at ${workerPath}`)
  memoryWorker = new Worker(workerPath)

  memoryWorker.on('message', (msg: Record<string, unknown>) => {
    const reqId = typeof msg.reqId === 'number' ? msg.reqId : -1
    const p = pending.get(reqId)
    if (!p) return
    // Progress messages don't delete from pending
    if (msg.type === 'consolidate-progress') {
      try {
        p.onProgress?.(msg)
      } catch { /* noop */ }
      return
    }
    pending.delete(reqId)
    if (msg.type === 'error') {
      p.reject(new Error(String(msg.error ?? 'unknown memory worker error')))
    } else {
      p.resolve(msg)
    }
  })

  memoryWorker.on('error', (err) => {
    console.error('[memoryWorkerClient] worker error:', err)
    memoryWorkerError = err
    for (const [, p] of pending) {
      try { p.reject(err) } catch { /* noop */ }
    }
    pending.clear()
    memoryWorker = null
  })

  memoryWorker.on('exit', (code) => {
    console.warn(`[memoryWorkerClient] worker exited with code ${code}`)
    // Reject any in-flight requests; without this `pending` retains every
    // PendingReq closure (and its resolve/reject handles) forever after a
    // worker crash. Mirrors the `error` handler above.
    const exitErr = new Error(`memory worker exited (code=${code})`)
    for (const [, p] of pending) {
      try { p.reject(exitErr) } catch { /* noop */ }
    }
    pending.clear()
    memoryWorker = null
    // Clear stale error so the next caller can spawn a fresh worker via
    // ensureWorker(); otherwise memoryWorkerAvailable() stays false until
    // the app restarts and consolidation is silently skipped.
    memoryWorkerError = null
  })

  return memoryWorker
}

function sendToWorker<T>(
  msg: { type: string; reqId?: number; absDir?: string; opts?: unknown },
  onProgress?: (msg: Record<string, unknown>) => void,
): Promise<T> {
  const w = ensureWorker()
  const reqId = ++reqSeq
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, onProgress })
    try {
      w.postMessage({ ...msg, reqId })
    } catch (err) {
      pending.delete(reqId)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

export interface ConsolidationResult {
  merged: number
  pruned: number
  compressed: number
  unchanged: number
  errors: string[]
  plan?: unknown
}

export interface ConsolidateOpts {
  dryRun?: boolean
  fullSweep?: boolean
  embedAvailable?: boolean
  onProgress?: (msg: Record<string, unknown>) => void
}

/**
 * Run consolidation in the worker thread.
 */
export async function consolidateInWorker(
  absDir: string,
  opts: ConsolidateOpts = {},
): Promise<ConsolidationResult> {
  const { onProgress, ...workerOpts } = opts
  const res = await sendToWorker<{ type: string; result: ConsolidationResult }>(
    { type: 'consolidate', absDir, opts: workerOpts },
    onProgress,
  )
  return res.result
}

/** Terminate the memory worker. */
export function terminateMemoryWorker(): void {
  const w = memoryWorker
  memoryWorker = null
  memoryWorkerError = null
  for (const [, p] of pending) {
    try { p.reject(new Error('memory worker terminated')) } catch { /* noop */ }
  }
  pending.clear()
  if (w) {
    w.terminate().catch(() => { /* noop */ })
  }
}

export function memoryWorkerAvailable(): boolean {
  return memoryWorker !== null && memoryWorkerError === null
}
