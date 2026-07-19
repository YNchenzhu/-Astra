/**
 * RAG (retrieval-augmented generation) for attachments.
 *
 * For any attachment whose extracted text exceeds {@link RAG_MIN_TEXT_CHARS},
 * we chunk it once (async), embed the chunks with the user's configured
 * embedding model, and store the vectors in {@link vector-store}. On each
 * send turn, we embed the user query and retrieve the most relevant chunks
 * across *all attachments in the current conversation*, optionally rerank
 * with a reranker model, and inject the top-N chunks as extra
 * `RetrievedSnippet`s into the prompt.
 *
 * Non-goals:
 *  - Cross-conversation retrieval (future).
 *  - Incremental re-chunking when the attachment is edited (we key by sha256,
 *    so new bytes → new namespace automatically).
 *  - Re-indexing when the embedding model changes (we early-exit on dim mismatch).
 */

import type { Attachment, ChatMessage } from '../types/tool'
import type { RetrievedSnippet } from './semanticContext'
import { useSettingsStore } from '../stores/useSettingsStore'
import { chunkText } from './ragChunker'

export const RAG_MIN_TEXT_CHARS = 6_000

interface RerankClientConfig {
  providerId: string
  model: string
  apiKey?: string
  baseUrl?: string
}

/**
 * True when either a local model is installed OR a cloud embedding config
 * is present. This is the gate that decides whether to attempt RAG indexing
 * on a newly-uploaded attachment.
 */
export function isEmbeddingAvailable(): boolean {
  const s = useSettingsStore.getState()
  const mode = s.embeddingMode || 'auto'
  const cloudOK = !!(s.embeddingModel && s.embeddingProviderId)
  if (mode === 'cloud') return cloudOK
  // mode === 'local' or 'auto' — we don't know at settings-read time whether
  // a local model is installed; assume yes and let dispatch fail gracefully.
  return true
}

export function getRerankConfig(): RerankClientConfig | null {
  const s = useSettingsStore.getState()
  if (!s.rerankModel || !s.rerankProviderId) return null
  return {
    providerId: s.rerankProviderId,
    model: s.rerankModel,
    apiKey: s.rerankApiKey || undefined,
    baseUrl: s.rerankBaseUrl || undefined,
  }
}

/**
 * Index an attachment's extracted text if eligible and not already indexed.
 * Idempotent: same (sha, kind, current-model) → no re-embed.
 */
export async function indexAttachmentAsync(att: Extract<Attachment, { type: 'file' }>): Promise<void> {
  const text = att.text?.content || ''
  if (text.length < RAG_MIN_TEXT_CHARS) return
  if (!att.sha256) return
  if (!isEmbeddingAvailable()) return

  const eapi = window.electronAPI?.embedding
  if (!eapi?.indexAttachment) return

  const chunks = chunkText(text)
  if (chunks.length === 0) return

  try {
    const r = await eapi.indexAttachment({
      sha256: att.sha256,
      kind: att.kind || 'unknown',
      sourceLabel: att.name,
      chunks: chunks.map((c) => ({
        index: c.index,
        text: c.text,
        meta: { ...c.meta, attachmentName: att.name, attachmentKind: att.kind },
      })),
    })
    if (!r.ok) {
      console.warn('[rag] indexAttachment failed:', r.error)
    }
  } catch (err) {
    console.warn('[rag] indexAttachment threw:', err)
  }
}

export interface RagHit {
  text: string
  score: number
  namespace: string
  meta?: Record<string, unknown>
}

/** Retrieve top-K chunks across all `type:'file'` attachments on the given
 *  messages.
 *
 *  `excludeShas` is used to skip attachments whose FULL text is already
 *  inlined in the user message for this turn — otherwise we'd inject the
 *  same content twice (once as inline preamble via `renderFileAttachmentText`,
 *  once again as RAG snippets), burning prompt budget and nudging the model
 *  towards repetitive responses. */
export async function retrieveAttachmentChunks(
  query: string,
  messages: ChatMessage[],
  opts: { topK?: number; excludeShas?: ReadonlySet<string> } = {},
): Promise<RagHit[]> {
  const topK = Math.max(1, opts.topK ?? 6)
  if (!query.trim()) return []
  if (!isEmbeddingAvailable()) return []
  const eapi = window.electronAPI?.embedding
  if (!eapi?.queryAttachments) return []

  const exclude = opts.excludeShas ?? new Set<string>()

  // Collect (sha, kind) pairs; main process resolves them to fp-aware namespaces.
  const seen = new Set<string>()
  const attachments: Array<{ sha256: string; kind: string }> = []
  for (const m of messages) {
    if (!m.attachments) continue
    for (const a of m.attachments) {
      if (a.type !== 'file') continue
      if (!a.sha256) continue
      if (exclude.has(a.sha256)) continue
      const key = `${a.kind || 'unknown'}:${a.sha256}`
      if (seen.has(key)) continue
      seen.add(key)
      attachments.push({ sha256: a.sha256, kind: a.kind || 'unknown' })
    }
  }
  if (attachments.length === 0) return []

  // Over-fetch when a reranker is configured so it has more to choose from.
  const rerankCfg = getRerankConfig()
  const overFetch = rerankCfg ? Math.max(topK * 3, 12) : topK

  const r = await eapi.queryAttachments({ query, attachments, topK: overFetch })
  if (!r.ok || r.hits.length === 0) return []

  let hits = r.hits
  if (rerankCfg) {
    try {
      const rr = await eapi.rerank({
        config: rerankCfg,
        query,
        documents: hits.map((h, i) => ({ id: `${i}`, text: h.text })),
      })
      const ok = (rr as { ok?: boolean }).ok === true
      if (ok) {
        const results = (rr as { results?: Array<{ id: string; score: number }> }).results || []
        const scoreByIndex = new Array<number>(hits.length).fill(0)
        for (const it of results) {
          const idx = Number(it.id)
          if (Number.isFinite(idx) && idx >= 0 && idx < hits.length) {
            scoreByIndex[idx] = it.score
          }
        }
        const annotated = hits.map((h, idx) => ({ h, score: scoreByIndex[idx] }))
        annotated.sort((a, b) => b.score - a.score)
        hits = annotated.map((a) => a.h)
      }
    } catch (err) {
      console.warn('[rag] rerank failed (falling back to embed rank):', err)
    }
  }

  return hits.slice(0, topK)
}

/** Convert RAG hits into `RetrievedSnippet`s compatible with contextBuilder. */
export function ragHitsToSnippets(hits: RagHit[]): RetrievedSnippet[] {
  return hits.map((h) => {
    const name = (h.meta?.attachmentName as string) || 'attachment'
    const heading = (h.meta?.headingPath as string) || ''
    const header = heading ? ` § ${heading}` : ''
    return {
      filePath: `attachment://${name}${header}`,
      relativePath: `${name}${header}`,
      lines: h.text,
      matchCount: 1,
    }
  })
}
