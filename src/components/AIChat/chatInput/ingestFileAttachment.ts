import type { Attachment, AttachmentKind } from '../../../types/tool'
import { indexAttachmentAsync } from '../../../services/rag'
import { IMAGE_EXTS, type ElectronFile } from './constants'
import { readFileAsBase64 } from './fileUtils'

type IngestDeps = {
  addAttachment: (attachment: Attachment) => void
  updateAttachment: (
    matchPath: string,
    patch: Partial<Extract<Attachment, { type: 'file' }>>,
  ) => void
}

/**
 * 2026-07 审计修复:ChatInput 的 ingest 此前没有超时(FilePreview 有 90s),
 * 一次卡死的解析会让气泡永远停在"正在解析…"。与 FilePreview 对齐取 90s。
 */
const INGEST_TIMEOUT_MS = 90_000

function withIngestTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('解析超时(90 秒),请重试或检查文件是否损坏')), INGEST_TIMEOUT_MS),
    ),
  ])
}

/**
 * 2026-07 审计修复:HTML 粘贴图 / 剪贴板 PNG 的共享入口 —— 先经
 * cacheStageImage 取得 sha256(供脱水指针 / recall / RAG 命中),再落
 * pendingAttachments。此前这两条路径不带 sha256,持久化后 recall 必 miss。
 * cacheStageImage 不可用或失败时按原样(无 sha256)添加,非致命。
 */
export async function addPastedImageAttachment(
  img: { name: string; base64: string; mediaType: string; size: number },
  addAttachment: IngestDeps['addAttachment'],
): Promise<void> {
  let sha256: string | undefined
  const api = window.electronAPI?.attachments
  if (api?.cacheStageImage) {
    try {
      const r = await api.cacheStageImage({ base64: img.base64, mediaType: img.mediaType })
      if (r.ok) sha256 = r.sha256
    } catch { /* non-fatal */ }
  }
  addAttachment({ type: 'image', ...img, sha256 })
}

/**
 * Route every drop/paste/picker file through the main-process ingest pipeline
 * (`window.electronAPI.attachments.ingest` / `ingestBuffer`). That pipeline
 * produces sha256 (so the attachment RAG namespace + dedupe cache works),
 * parses Office / PDF / CSV / ipynb into text + page-image fallbacks, and
 * keeps the UI preview strictly equal to what the serializer sends to the
 * model. We insert a `status:'processing'` placeholder synchronously so the
 * bubble appears immediately, then patch it via `updateAttachment` once the
 * async ingest resolves (or flip it to `status:'error'` on failure).
 */
export async function ingestFileAttachment(
  file: File,
  { addAttachment, updateAttachment }: IngestDeps,
): Promise<void> {
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  const looksLikeImage = IMAGE_EXTS.has(ext) || file.type.startsWith('image/')
  const api = window.electronAPI?.attachments
  const electronPath = (file as ElectronFile).path

  if (looksLikeImage) {
    // 2026-07 审计修复(P0):图片统一走主进程 ingest 管线,获得 sharp
    // 压缩(>4096px 缩放、非直传格式转 JPEG)+ sha256(供缓存/RAG/脱水
    // 指针)。此前 FileReader 快路径把 8000×6000 原图原样塞进上下文。
    // ingest 不可用(浏览器模式)或失败时,回退旧的 FileReader 直读。
    try {
      // 审计修复(第二轮复核):图片 ingest 同样带 90s 超时 —— 超时/异常
      // 一律落回下方 FileReader 直读,不会让图片静默消失。
      let ingested: unknown = null
      if (electronPath && api?.ingest) {
        try {
          ingested = await withIngestTimeout(api.ingest({ path: electronPath, name: file.name }))
        } catch { /* fall back below */ }
      } else if (api?.ingestBuffer) {
        try {
          const raw = await readFileAsBase64(file)
          if (raw) {
            ingested = await withIngestTimeout(
              api.ingestBuffer({ name: file.name, base64: raw }),
            )
          }
        } catch { /* fall back below */ }
      }
      const img = ingested as
        | { type?: string; name?: string; base64?: string; mediaType?: string; size?: number; sha256?: string }
        | null
      if (img && img.type === 'image' && img.base64 && img.mediaType) {
        addAttachment({
          type: 'image',
          name: img.name || file.name,
          base64: img.base64,
          mediaType: img.mediaType,
          size: img.size ?? file.size,
          sha256: img.sha256,
        })
        return
      }

      // Fallback:FileReader 直读(浏览器模式 / ingest 异常)。
      const base64 = await readFileAsBase64(file)
      if (!base64) {
        console.error('[ChatInput] image read returned empty base64:', file.name)
        return
      }
      const mediaType = file.type || `image/${ext === 'jpg' ? 'jpeg' : ext || 'png'}`
      addAttachment({
        type: 'image',
        name: file.name,
        base64,
        mediaType,
        size: file.size,
      })
      if (api?.cacheStageImage) {
        try { await api.cacheStageImage({ base64, mediaType }) } catch { /* non-fatal */ }
      }
    } catch (err) {
      console.error('[ChatInput] failed to read dropped image:', err)
    }
    return
  }

  // Non-image path — must go through ingest to parse text/PDF/Office.
  if (!api?.ingest && !api?.ingestBuffer) {
    console.warn('[ChatInput] attachments ingest API unavailable; file dropped in browser mode:', file.name)
    return
  }

  // Unique synthetic path so subsequent `updateAttachment` calls can target
  // this placeholder without colliding with another pending file sharing
  // the same absolute path (rare, but possible with duplicate drops).
  const placeholderPath = electronPath
    ? `pending:${electronPath}:${Date.now().toString(36)}`
    : `pending:${file.name}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`

  addAttachment({
    type: 'file',
    name: file.name,
    path: placeholderPath,
    size: file.size,
    status: 'processing',
  })

  try {
    const result = electronPath && api.ingest
      ? await withIngestTimeout(api.ingest({ path: electronPath, name: file.name }))
      : api.ingestBuffer
        ? await withIngestTimeout(
            api.ingestBuffer({ name: file.name, base64: await readFileAsBase64(file) }),
          )
        : null

    if (!result) {
      updateAttachment(placeholderPath, {
        status: 'error',
        error: '当前环境不支持文件解析',
      })
      return
    }

    if (result.type === 'image') {
      // Ingest reclassified as image — surface a hint; the user can re-drop
      // the same bytes which will take the image fast-path above.
      updateAttachment(placeholderPath, {
        status: 'error',
        error: '检测到图片内容，请直接以图片形式拖入/粘贴',
      })
      return
    }

    updateAttachment(placeholderPath, {
      name: result.name,
      path: result.path,
      size: result.size,
      kind: result.kind as AttachmentKind,
      mimeType: result.mimeType,
      sha256: result.sha256,
      status: result.status,
      error: result.error,
      pdf: result.pdf,
      text: result.text,
      pageImages: result.pageImages,
      sheets: result.sheets,
      inlineImages: result.inlineImages,
      // 2026-07 审计修复:此前 notes 丢失,poppler 缺失 / xlsx 截断等
      // 警告在 UI 与模型 preamble 均不可见。
      notes: result.notes,
    })
    // Fire the RAG indexer so long attachments enter the vector store and the
    // attachment-RAG retrieval path (`retrieveAttachmentChunks`) starts
    // surfacing "相关片段" pills under user bubbles. Fire-and-forget: failures
    // only disable the retrieval for this attachment, they don't block send.
    if (result.status === 'ready') {
      const fullAtt: Extract<Attachment, { type: 'file' }> = {
        type: 'file',
        name: result.name,
        path: result.path,
        size: result.size,
        kind: result.kind as AttachmentKind,
        mimeType: result.mimeType,
        sha256: result.sha256,
        status: 'ready',
        pdf: result.pdf,
        text: result.text,
        pageImages: result.pageImages,
        sheets: result.sheets,
        inlineImages: result.inlineImages,
        notes: result.notes,
      }
      void indexAttachmentAsync(fullAtt).catch((err) => {
        console.warn('[ChatInput] attachment RAG indexing failed:', err)
      })
    }
  } catch (err) {
    updateAttachment(placeholderPath, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
