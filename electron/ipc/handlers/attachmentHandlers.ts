/**
 * Attachment ingestion + content-addressed cache IPC handlers.
 *
 *   - `attachment:ingest`            hash + parse a file at path
 *   - `attachment:ingest-buffer`     same, but for an in-memory base64 payload
 *   - `attachment:cache-get`         fetch a previously-ingested entry by sha256
 *   - `attachment:cache-stats`       file count + byte size of the cache dir
 *   - `attachment:cache-clear`       nuke the cache dir
 *   - `attachment:cache-stage-image` stash a renderer-generated PNG so later
 *                                    recall can surface it like a user paste
 *
 * All parsers / the cache module are loaded lazily via dynamic `import()` so
 * PDF.js and friends (~3 MB total) don't inflate the cold-start bundle.
 *
 * 2026-07 富文件审计修复:全部换用 validatedHandle + Zod(此前是仓库中
 * 仅存的手写 `params as Record<string, unknown>` 形状检查);ingest-buffer
 * 的临时文件名取 basename,阻断 `name: "..\\..\\x"` 形式的路径逃逸。
 */
import path from 'node:path'
import { z } from 'zod'
import { app, type IpcMain } from 'electron'
import { validatedHandle } from '../validatedHandle'
import {
  attachmentCacheGetArgs,
  attachmentCacheStageImageArgs,
  attachmentIngestArgs,
  attachmentIngestBufferArgs,
} from '../schemas'

const noArgs = z.tuple([])

/** 临时文件名只保留 basename,并剔除 NUL(路径逃逸防护)。 */
function safeTempName(name: string): string {
  const base = path.basename(name.replace(/\0/g, ''))
  return base && base !== '.' && base !== '..' ? base : 'attachment.bin'
}

export function registerAttachmentHandlers(_ipcMain: IpcMain): void {
  validatedHandle('attachment:ingest', attachmentIngestArgs, async (_e, [params]) => {
    const { path: filePath, name } = params
    try {
      const { ingestAttachment } = await import('../../attachments/index')
      return await ingestAttachment({ path: filePath, name })
    } catch (err) {
      return {
        type: 'file' as const,
        name: name || (filePath ? filePath.split(/[\\/]/).pop() : 'unknown') || 'unknown',
        path: filePath || '',
        size: 0,
        kind: 'unknown' as const,
        mimeType: 'application/octet-stream',
        sha256: '',
        status: 'error' as const,
        error: `ingest failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  })

  validatedHandle('attachment:ingest-buffer', attachmentIngestBufferArgs, async (_e, [params]) => {
    const { name, base64 } = params
    try {
      const { writeFile: wf, mkdtemp, rm } = await import('node:fs/promises')
      const os = await import('node:os')
      const tmp = path.join(
        await mkdtemp(path.join(os.tmpdir(), 'astra-att-')),
        safeTempName(name),
      )
      await wf(tmp, Buffer.from(base64, 'base64'))
      try {
        const { ingestAttachment } = await import('../../attachments/index')
        return await ingestAttachment({ path: tmp, name })
      } finally {
        try { await rm(path.dirname(tmp), { recursive: true, force: true }) } catch { /* noop */ }
      }
    } catch (err) {
      return { type: 'file', name, path: '', size: 0, kind: 'unknown', mimeType: 'application/octet-stream', sha256: '', status: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  })

  validatedHandle('attachment:cache-get', attachmentCacheGetArgs, async (_e, [params]) => {
    const { sha256: sha, kind } = params
    if (!sha) return null
    try {
      const { cacheGet } = await import('../../attachments/cache')
      return await cacheGet(sha, kind ?? 'unknown')
    } catch { return null }
  })

  validatedHandle('attachment:cache-stats', noArgs, async () => {
    try {
      const { readdir, stat } = await import('node:fs/promises')
      const dir = path.join(app.getPath('userData'), 'attachment-cache')
      let files = 0, bytes = 0
      try {
        for (const e of await readdir(dir)) {
          try { const s = await stat(path.join(dir, e)); if (s.isFile()) { files++; bytes += s.size } } catch { /* skip */ }
        }
      } catch { /* dir missing */ }
      return { files, bytes }
    } catch { return { files: 0, bytes: 0 } }
  })

  validatedHandle('attachment:cache-clear', noArgs, async () => {
    try {
      const { readdir, unlink } = await import('node:fs/promises')
      const dir = path.join(app.getPath('userData'), 'attachment-cache')
      let removed = 0
      try {
        for (const e of await readdir(dir)) {
          try { await unlink(path.join(dir, e)); removed++ } catch { /* skip */ }
        }
      } catch { /* noop */ }
      return { removed }
    } catch { return { removed: 0 } }
  })

  validatedHandle('attachment:cache-stage-image', attachmentCacheStageImageArgs, async (_e, [params]) => {
    const { base64, mediaType } = params
    try {
      const { createHash } = await import('node:crypto')
      const buf = Buffer.from(base64, 'base64')
      const sha = createHash('sha256').update(buf).digest('hex')
      const { cachePut } = await import('../../attachments/cache')
      await cachePut(sha, 'image', {
        type: 'image', name: `staged-${sha.slice(0, 12)}`, base64, mediaType: mediaType ?? 'image/png', size: buf.length, sha256: sha,
      })
      return { ok: true, sha256: sha }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
