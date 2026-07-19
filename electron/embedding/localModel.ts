/**
 * Local ONNX embedding — main-process shim over the worker_thread.
 *
 * All the heavy lifting (transformers.js + ONNX Runtime) runs inside
 * {@link ./embeddingWorker.ts}. This file is the thin parent-side client:
 * it spawns the worker on first use, keeps it alive for the app's lifetime,
 * and translates postMessage traffic into the promise-returning API that
 * the rest of the codebase (`dispatchEmbed`, `workspaceIndex`, memory
 * recall, settings test button) already expects.
 *
 * Why a worker?
 *
 *   Running ONNX inference inline on the Electron main process starves the
 *   JS event loop. Even though `session.run()` is nominally async, the
 *   surrounding tokenization + post-processing are synchronous JS and can
 *   take a second or two per micro-batch. For a 10k-chunk workspace that
 *   means the UI is effectively frozen for 10-30 minutes during indexing.
 *   Isolating inference to a separate Node worker thread keeps the main
 *   process hot path (IPC, filesystem, renderer ACKs) on a free event loop
 *   regardless of what the embedding model is doing.
 */

import path from 'node:path'
import { Worker } from 'node:worker_threads'

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

type AnyProgress = EmbedProgress | WalkChunkProgress

interface PendingReq {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  onProgress?: (progress: AnyProgress) => void
}

export interface EmbedProgress {
  microIdx: number
  microTotal: number
  durationMs: number
  maxLen: number
}

let worker: Worker | null = null
let workerInitError: Error | null = null
let loadedKey: string | null = null
let loadingPromise: Promise<number> | null = null
let reqSeq = 0
const pending = new Map<number, PendingReq>()

function resolveWorkerPath(): string {
  // vite-plugin-electron bundles every electron entry into dist-electron/*.
  // The main-process bundle runs from `dist-electron/main.js`, so the
  // worker bundle sits right next to it.
  return path.join(__dirname, 'embeddingWorker.js')
}

function spawnWorker(): Worker {
  const workerPath = resolveWorkerPath()
  console.log(`[embedding/localModel] spawning worker at ${workerPath}`)
  const w = new Worker(workerPath)

  w.on('message', (msg: Record<string, unknown>) => {
    const reqId = typeof msg.reqId === 'number' ? msg.reqId : -1
    const p = pending.get(reqId)
    if (!p) return
    if (msg.type === 'progress') {
      try {
        p.onProgress?.({
          microIdx: Number(msg.microIdx) || 0,
          microTotal: Number(msg.microTotal) || 0,
          durationMs: Number(msg.durationMs) || 0,
          maxLen: Number(msg.maxLen) || 0,
        })
      } catch { /* noop */ }
      return
    }
    // walk-chunk-progress: forwarded as progress callback for walkChunkInWorker
    if (msg.type === 'walk-chunk-progress') {
      try {
        p.onProgress?.({
          batchIdx: Number(msg.batchIdx) || 0,
          batchTotal: Number(msg.batchTotal) || 0,
          filesScanned: Number(msg.filesScanned) || 0,
          filesIndexed: Number(msg.filesIndexed) || 0,
          chunksInBatch: Number(msg.chunksInBatch) || 0,
          totalChunks: Number(msg.totalChunks) || 0,
        } as AnyProgress)
      } catch { /* noop */ }
      return
    }
    pending.delete(reqId)
    if (msg.type === 'error') {
      p.reject(new Error(String(msg.error ?? 'unknown embedding worker error')))
    } else {
      p.resolve(msg)
    }
  })

  w.on('error', (err) => {
    console.error('[embedding/localModel] worker error:', err)
    workerInitError = err
    failAllPending(err)
    worker = null
    loadedKey = null
  })

  w.on('exit', (code) => {
    console.warn(`[embedding/localModel] worker exited with code ${code}`)
    failAllPending(new Error(`embedding worker exited (code=${code})`))
    worker = null
    loadedKey = null
  })

  return w
}

function failAllPending(err: Error) {
  for (const [, p] of pending) {
    try { p.reject(err) } catch { /* noop */ }
  }
  pending.clear()
}

function ensureWorker(): Worker {
  if (worker) return worker
  worker = spawnWorker()
  workerInitError = null
  return worker
}

function sendWorker<T>(
  w: Worker,
  msg: { type: 'load' | 'embed' | 'unload' | 'walk-chunk'; modelId?: string; modelDir?: string; texts?: string[]; root?: string; maxFiles?: number; maxBytesPerFile?: number },
  onProgress?: (p: EmbedProgress | WalkChunkProgress) => void,
): Promise<T> {
  const reqId = ++reqSeq
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, {
      resolve: resolve as (v: unknown) => void,
      reject,
      onProgress,
    })
    try {
      w.postMessage({ ...msg, reqId })
    } catch (err) {
      pending.delete(reqId)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

// ---------------------------------------------------------------------------
// Public API (unchanged external signatures)
// ---------------------------------------------------------------------------

/**
 * Quick probe for the Settings panel. We spawn the worker lazily on the
 * first real embed request, so this just reports whether the previous
 * attempt failed. Best-effort.
 */
export function localEmbeddingAvailable(): { ok: boolean; error?: string } {
  if (workerInitError) return { ok: false, error: workerInitError.message }
  return { ok: true }
}

async function ensureModelLoaded(modelId: string, modelDir: string): Promise<number> {
  const key = `${modelId}|${modelDir}`
  const w = ensureWorker()
  if (loadedKey === key) return 0
  if (loadingPromise) {
    await loadingPromise
    if (loadedKey === key) return 0
  }
  loadingPromise = (async () => {
    const res = await sendWorker<{ type: string; dim: number }>(w, {
      type: 'load',
      modelId,
      modelDir,
    })
    loadedKey = key
    return res.dim || 0
  })()
  try {
    return await loadingPromise
  } finally {
    loadingPromise = null
  }
}

/**
 * Embed a list of texts using a locally-bundled or downloaded ONNX model.
 * Output vectors are L2-normalized (cosine-similarity ready) and mean-pooled
 * over tokens using the attention mask.
 *
 * The optional `onProgress` callback fires once per micro-batch so callers
 * (workspace index builder, memory recall) can stream progress to the
 * renderer every ~4 seconds instead of every ~60 seconds.
 */
export async function embedLocal(
  modelId: string,
  modelDir: string,
  texts: string[],
  options?: { onProgress?: (p: EmbedProgress) => void },
): Promise<{ ok: true; vectors: number[][]; dim: number } | { ok: false; error: string }> {
  if (texts.length === 0) {
    return { ok: true, vectors: [], dim: 0 }
  }
  try {
    await ensureModelLoaded(modelId, modelDir)
    const w = ensureWorker()
    const t0 = Date.now()
    console.log(
      `[embedding/localModel] dispatching ${texts.length} text(s) to worker`,
    )
    const res = await sendWorker<{ type: string; vectors: number[][]; dim: number }>(
      w,
      { type: 'embed', texts },
      options?.onProgress as ((p: AnyProgress) => void) | undefined,
    )
    console.log(
      `[embedding/localModel]   worker returned ${res.vectors.length} vector(s) × ${res.dim}-dim in ${Date.now() - t0}ms`,
    )
    return { ok: true, vectors: res.vectors, dim: res.dim }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Drop the model from the worker's memory (does not terminate the worker).
 * Callers switch models via the Settings panel; the renderer triggers this
 * so the next embed call re-loads with fresh config.
 */
export function unloadLocalModel(_modelId: string): void {
  const w = worker
  if (!w) return
  sendWorker(w, { type: 'unload' }).catch(() => { /* noop */ })
  loadedKey = null
}

/** Terminate the worker entirely — used on app shutdown or model switch. */
export function unloadAllLocalModels(): void {
  const w = worker
  worker = null
  loadedKey = null
  loadingPromise = null
  failAllPending(new Error('embedding worker terminated'))
  if (w) {
    w.terminate().catch(() => { /* noop */ })
  }
}

// ---------------------------------------------------------------------------
// Walk + Chunk (delegated to worker)
// ---------------------------------------------------------------------------

export interface WalkChunkResult {
  filesScanned: number
  chunks: Array<{
    relPath: string
    absPath: string
    size: number
    chunks: Array<{ id: string; text: string; relPath: string; startLine: number; endLine: number }>
  }>
  totalChunks: number
  errors: Array<{ file: string; error: string }>
}

export interface WalkChunkProgress {
  batchIdx: number
  batchTotal: number
  filesScanned: number
  filesIndexed: number
  chunksInBatch: number
  totalChunks: number
}

/**
 * Walk a workspace root and chunk all source files inside the worker.
 * This keeps the main process event loop free during large scans.
 */
export async function walkChunkInWorker(
  root: string,
  options: {
    maxFiles?: number
    maxBytesPerFile?: number
    onProgress?: (p: WalkChunkProgress) => void
  } = {},
): Promise<WalkChunkResult> {
  const w = ensureWorker()
  // sendWorker's onProgress is the union `EmbedProgress | WalkChunkProgress`
  // (the worker dispatches both shapes on the same RPC channel).  The
  // walk-chunk request only emits the WalkChunkProgress arm, so we adapt
  // the caller's narrower callback through a wrapper that re-narrows the
  // payload at runtime.  Avoids `as any` while preserving the strict
  // public signature.
  const onProgress = options.onProgress
  const adapted = onProgress
    ? (p: EmbedProgress | WalkChunkProgress) => onProgress(p as WalkChunkProgress)
    : undefined
  return sendWorker<WalkChunkResult>(w, {
    type: 'walk-chunk',
    root,
    maxFiles: options.maxFiles ?? 5_000,
    maxBytesPerFile: options.maxBytesPerFile ?? 200_000,
  }, adapted)
}
