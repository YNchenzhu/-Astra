/**
 * Streaming downloader for Hugging Face model files.
 *
 * Downloads every file of a `DownloadableModelInfo` into
 * `<userData>/downloaded-models/<id>/` preserving sub-paths (so
 * `onnx/model_quantized.onnx` lands at `.../onnx/model_quantized.onnx`).
 *
 * Features:
 *   - Per-file resume via HTTP Range (atomic: writes to `.part` until done)
 *   - Live progress callback: `{ fileIndex, totalFiles, bytesDone, bytesTotal, overallBytesDone, overallBytesTotal }`
 *   - Cancel via AbortSignal
 *   - Concurrent per-file: off by default (sequential) — HF CDNs throttle too
 *     aggressively to benefit much, and sequential is easier to resume
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { DownloadableModelInfo } from './localCatalog'

const HF_HOST = 'https://huggingface.co'

export interface DownloadProgress {
  modelId: string
  fileIndex: number
  totalFiles: number
  currentFile: string
  currentBytes: number
  currentTotal: number
  overallBytes: number
  overallTotal: number
  /** `'downloading' | 'done' | 'error'`. */
  state: 'downloading' | 'done' | 'error'
  error?: string
}

export interface DownloadHandle {
  cancel: () => void
  promise: Promise<{ ok: true } | { ok: false; error: string; canceled?: boolean }>
}

const active = new Map<string, AbortController>()

/** True if a download for this model is already running. */
export function isDownloading(modelId: string): boolean {
  return active.has(modelId)
}

/** Cancel an in-flight download. Safe to call when none is running. */
export function cancelDownload(modelId: string): void {
  const ctrl = active.get(modelId)
  if (ctrl) ctrl.abort()
}

export function downloadModel(
  model: DownloadableModelInfo,
  onProgress: (p: DownloadProgress) => void,
): DownloadHandle {
  const ctrl = new AbortController()
  active.set(model.id, ctrl)
  const promise = (async () => {
    try {
      const root = path.join(app.getPath('userData'), 'downloaded-models', model.id)
      await fsp.mkdir(root, { recursive: true })

      // First pass: HEAD each file to learn its exact size for accurate total.
      const sizes: number[] = new Array(model.files.length).fill(0)
      let overallTotal = 0
      for (let i = 0; i < model.files.length; i++) {
        if (ctrl.signal.aborted) throw new DOMException('aborted', 'AbortError')
        const url = `${HF_HOST}/${model.hfRepo}/resolve/main/${model.files[i]}`
        try {
          const head = await fetch(url, { method: 'HEAD', signal: ctrl.signal })
          const len = Number(head.headers.get('content-length') || '0')
          sizes[i] = Number.isFinite(len) ? len : 0
          overallTotal += sizes[i]
        } catch {
          // If HEAD fails, fall back to catalog estimate so the progress bar
          // still shows forward motion.
          sizes[i] = 0
        }
      }
      if (overallTotal === 0) overallTotal = model.approxSizeBytes

      // Second pass: GET each file with streaming progress.
      let overallBytes = 0
      for (let i = 0; i < model.files.length; i++) {
        if (ctrl.signal.aborted) throw new DOMException('aborted', 'AbortError')
        const rel = model.files[i]
        const dest = path.join(root, rel)
        await fsp.mkdir(path.dirname(dest), { recursive: true })

        // Skip if already complete (matching size).
        try {
          const st = await fsp.stat(dest)
          if (sizes[i] > 0 && st.size === sizes[i]) {
            overallBytes += sizes[i]
            onProgress({
              modelId: model.id,
              fileIndex: i,
              totalFiles: model.files.length,
              currentFile: rel,
              currentBytes: st.size,
              currentTotal: sizes[i],
              overallBytes,
              overallTotal,
              state: 'downloading',
            })
            continue
          }
        } catch { /* no file yet */ }

        const part = `${dest}.part`
        let startFrom = 0
        try {
          const st = await fsp.stat(part)
          startFrom = st.size
        } catch { /* no partial */ }

        const url = `${HF_HOST}/${model.hfRepo}/resolve/main/${rel}`
        const headers: Record<string, string> = {}
        if (startFrom > 0) headers['Range'] = `bytes=${startFrom}-`

        const resp = await fetch(url, { signal: ctrl.signal, headers })
        if (!resp.ok && resp.status !== 206) {
          throw new Error(`HTTP ${resp.status} fetching ${rel}`)
        }
        if (!resp.body) throw new Error(`Empty body for ${rel}`)

        const ws = fs.createWriteStream(part, { flags: startFrom > 0 ? 'a' : 'w' })
        let fileBytes = startFrom
        const reader = (resp.body as ReadableStream<Uint8Array>).getReader()
        try {
          while (true) {
            if (ctrl.signal.aborted) throw new DOMException('aborted', 'AbortError')
            const { value, done } = await reader.read()
            if (done) break
            if (!value) continue
            // Backpressure respect: await the drain when the write stream is full.
            await new Promise<void>((resolve, reject) => {
              if (!ws.write(value)) ws.once('drain', resolve)
              else resolve()
              ws.once('error', reject)
            })
            fileBytes += value.byteLength
            overallBytes += value.byteLength
            onProgress({
              modelId: model.id,
              fileIndex: i,
              totalFiles: model.files.length,
              currentFile: rel,
              currentBytes: fileBytes,
              currentTotal: sizes[i] || fileBytes,
              overallBytes,
              overallTotal: Math.max(overallTotal, overallBytes),
              state: 'downloading',
            })
          }
        } finally {
          await new Promise<void>((resolve) => ws.end(() => resolve()))
        }

        await fsp.rename(part, dest)
      }

      onProgress({
        modelId: model.id,
        fileIndex: model.files.length,
        totalFiles: model.files.length,
        currentFile: '',
        currentBytes: overallTotal,
        currentTotal: overallTotal,
        overallBytes: overallTotal,
        overallTotal,
        state: 'done',
      })
      return { ok: true as const }
    } catch (err) {
      const canceled = err instanceof DOMException && err.name === 'AbortError'
      const msg = canceled ? 'canceled' : err instanceof Error ? err.message : String(err)
      onProgress({
        modelId: model.id,
        fileIndex: 0,
        totalFiles: model.files.length,
        currentFile: '',
        currentBytes: 0,
        currentTotal: 0,
        overallBytes: 0,
        overallTotal: 0,
        state: 'error',
        error: msg,
      })
      return canceled
        ? { ok: false as const, error: 'canceled', canceled: true }
        : { ok: false as const, error: msg }
    } finally {
      active.delete(model.id)
    }
  })()
  return { cancel: () => ctrl.abort(), promise }
}
