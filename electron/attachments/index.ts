/**
 * Attachment ingestion pipeline.
 *
 * Entry point: `ingestAttachment(filePath | { name, bytes })` → IngestedAttachment
 * suitable to be stored in renderer `pendingAttachments` and later serialized
 * into Claude-style content blocks (image / document / text) by
 * `src/services/contextBuilder.ts`.
 *
 * Guarantees:
 *  - Deterministic, idempotent (sha256 in output)
 *  - Never throws — returns `{ type:'file', status:'error' }` on failure
 *  - Size-capped to LIMITS.MAX_FILE_BYTES
 */

import { createHash } from 'crypto'
import { readFile, stat } from 'fs/promises'
import path from 'path'

import { cacheGet, cachePut } from './cache'
import { detectKind } from './detect'
import { loadImageForModel } from './image'
import { extractOffice } from './office'
import {
  extractPdfText,
  loadPdfBase64,
  looksLikeScannedText,
  renderPdfPagesAsImages,
} from './pdf'
import { readIpynbFile, readTableFile, readTextFile } from './text'
import {
  LIMITS,
  type IngestedAttachment,
  type IngestedFile,
  type IngestedImage,
} from './types'

export interface IngestRequest {
  path?: string
  /** For dropped/in-memory buffers (e.g. browser-origin files without a path). */
  name?: string
  bytesBase64?: string
}

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function errorFile(name: string, filePath: string, size: number, msg: string): IngestedFile {
  return {
    type: 'file',
    name,
    path: filePath,
    size,
    kind: 'unknown',
    mimeType: 'application/octet-stream',
    sha256: '',
    status: 'error',
    error: msg,
  }
}

export async function ingestAttachment(req: IngestRequest): Promise<IngestedAttachment> {
  // 2026-07 审计修复:用户可见的错误信息中文化(此前英文错误直接透传到
  // 输入区 chip 的 title 与预览模态)。底层异常 message 仍原样附带。
  if (!req.path) {
    return errorFile(req.name || 'unknown', '', 0, '仅支持磁盘路径附件(buffer 路径由 IPC 层落盘后转入)。')
  }
  const filePath = req.path
  const displayName = req.name || path.basename(filePath)

  let size: number
  try {
    const s = await stat(filePath)
    if (!s.isFile()) return errorFile(displayName, filePath, 0, '不是常规文件(可能是目录或特殊文件)。')
    size = s.size
  } catch (err) {
    return errorFile(displayName, filePath, 0, `无法读取文件信息:${err instanceof Error ? err.message : String(err)}`)
  }
  if (size > LIMITS.MAX_FILE_BYTES) {
    return errorFile(displayName, filePath, size, `文件过大(${(size / 1024 / 1024).toFixed(1)}MB,上限 ${(LIMITS.MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB)。`)
  }

  // Read once: need both magic bytes and sha256 up front.
  let fullBuf: Buffer
  try {
    fullBuf = await readFile(filePath)
  } catch (err) {
    return errorFile(displayName, filePath, size, `读取文件失败:${err instanceof Error ? err.message : String(err)}`)
  }
  const head = fullBuf.subarray(0, Math.min(16, fullBuf.length))
  const fileSha = sha256Of(fullBuf)

  const { kind, mimeType } = detectKind(filePath, head)

  // Cache hit — rewrite path/name to current upload (user may have renamed the
  // file on disk), but keep all parsed payload verbatim.
  try {
    const cached = await cacheGet(fileSha, kind)
    if (cached) {
      if (cached.type === 'file') {
        return { ...cached, name: displayName, path: filePath, size }
      }
      if (cached.type === 'image') {
        return { ...cached, name: displayName }
      }
    }
  } catch { /* miss — continue */ }

  const baseFile = {
    type: 'file' as const,
    name: displayName,
    path: filePath,
    size,
    kind,
    mimeType,
    sha256: fileSha,
  }

  let result: IngestedAttachment

  try {
    // --- Image ---
    if (kind === 'image') {
      const { base64, mediaType } = await loadImageForModel(filePath, mimeType, size)
      const img: IngestedImage = {
        type: 'image',
        name: displayName,
        base64,
        mediaType,
        size,
        sha256: fileSha,
      }
      result = img

    // --- PDF (text + optional raw base64 + optional OCR page images) ---
    } else if (kind === 'pdf') {
      const [textResult, base64] = await Promise.all([
        extractPdfText(filePath),
        loadPdfBase64(filePath, size),
      ])
      const notes: string[] = []
      const out: IngestedFile = {
        ...baseFile,
        status: 'ready',
        text: {
          content: textResult.text,
          truncated: textResult.text.includes('[Truncated:'),
          originalChars: textResult.text.length,
        },
        pdf: {
          pageCount: textResult.pageCount || undefined,
          sizeBytes: size,
          oversized: !base64,
          ...(base64 ? { base64 } : {}),
        },
      }
      if (!base64) {
        notes.push(
          `PDF 体积 ${(size / 1024 / 1024).toFixed(1)}MB 超出 provider 文档块上限 ` +
            `(${(LIMITS.MAX_PDF_BYTES / 1024 / 1024).toFixed(0)}MB),已改为从磁盘直接预览;` +
            '发送给 AI 时仍会附带提取出的文本,但不会包含原始 PDF 二进制。',
        )
      }
      // Scanned PDF fallback: render pages as images so vision models see them.
      //
      // IMPORTANT contract: when `pageImages` is populated (scanned PDF, no
      // meaningful text layer), we must leave `out.text` unset so downstream
      // `contextBuilder.chatMessageToAgentApiRows` can detect "no extractable
      // text" via `!f.text?.content` and actually emit image blocks to the
      // model. Earlier versions wrote a placeholder string into `text.content`
      // ("[Scanned PDF — N page image(s) rendered ...]"), which defeated the
      // guard and silently dropped every rendered page from the API payload —
      // the model then only saw the placeholder sentence and acted like no
      // images were ever attached. The UI-side `renderFileAttachmentText`
      // already has a "no body + pageImages present" branch that produces a
      // natural-language preamble, so stripping `text` here loses nothing for
      // the preview.
      if (looksLikeScannedText(textResult.text)) {
        const outcome = await renderPdfPagesAsImages(filePath, 10)
        if (outcome.images.length > 0) {
          out.pageImages = outcome.images
          // Drop the placeholder text so the downstream guard can fire.
          // `delete` (vs. `= undefined`) avoids leaving an enumerable
          // `text: undefined` key that IPC JSON-serializes to `text: null` —
          // the renderer side then mistakes it for "empty text object" and
          // hits a different code path.
          delete out.text
        }
        for (const n of outcome.notes) notes.push(n)
      }
      if (notes.length > 0) out.notes = notes
      result = out

    // --- Office ---
    } else if (
      kind === 'docx' || kind === 'xlsx' || kind === 'pptx' ||
      kind === 'doc'  || kind === 'xls'  || kind === 'ppt'
    ) {
      const r = await extractOffice(filePath, kind)
      if (!r.ok) {
        result = {
          ...baseFile,
          status: 'error',
          error: r.hint ? `${r.error}\n\n${r.hint}` : r.error,
        }
      } else {
        result = {
          ...baseFile,
          status: 'ready',
          text: {
            content: r.text,
            truncated: r.truncated,
            originalChars: r.originalChars,
          },
          sheets: r.sheets,
          inlineImages: r.inlineImages,
          notes: r.notes,
        }
      }

    // --- Table files ---
    } else if (kind === 'csv' || kind === 'tsv') {
      const t = await readTableFile(filePath, kind)
      result = { ...baseFile, status: 'ready', text: t }

    // --- Notebook ---
    } else if (kind === 'ipynb') {
      const t = await readIpynbFile(filePath)
      result = { ...baseFile, status: 'ready', text: t }

    // --- Text-like ---
    } else if (
      kind === 'text' || kind === 'markdown' || kind === 'code' ||
      kind === 'json' || kind === 'yaml' || kind === 'xml' ||
      kind === 'html' || kind === 'rtf'
    ) {
      const t = await readTextFile(filePath)
      const content = kind === 'rtf' ? stripRtf(t.content) : t.content
      result = { ...baseFile, status: 'ready', text: { ...t, content } }

    // --- Unknown small file: best-effort text ---
    } else if (kind === 'unknown' && size <= 1 * 1024 * 1024) {
      const t = await readTextFile(filePath)
      result = { ...baseFile, status: 'ready', text: t }

    // --- Totally unknown binary ---
    } else {
      result = {
        ...baseFile,
        status: 'ready',
        text: {
          content: `[Binary file "${displayName}" (${(size / 1024).toFixed(1)} KB, ${mimeType}) — content not extracted.]`,
          truncated: false,
          originalChars: 0,
        },
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return errorFile(displayName, filePath, size, `ingest failed: ${msg}`)
  }

  // Persist to cache (advisory, never blocks). Only cache successful "ready"
  // results — error entries would freeze a bad parse forever.
  if (
    (result.type === 'image') ||
    (result.type === 'file' && result.status === 'ready')
  ) {
    void cachePut(fileSha, kind, result)
  }
  return result
}

function stripRtf(s: string): string {
  // Drop control words, groups, and escapes. Good enough for common RTF notes.
  return s
    .replace(/\\[a-z]+-?\d*\s?/gi, ' ')
    .replace(/[{}]/g, '')
    .replace(/\\'[0-9a-f]{2}/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export type { IngestedAttachment, IngestedFile, IngestedImage } from './types'
