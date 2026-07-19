/**
 * High-level embedding APIs that own namespace construction.
 *
 * The renderer never needs to know how a namespace is named or which
 * fingerprint is in play — it passes logical inputs (attachment sha, query,
 * memory ids) and these helpers route to the right namespace internally.
 *
 * Why this layer exists:
 *
 *   - Pre-v2 the renderer constructed namespaces with `att-${kind}-${sha32}`
 *     by hand. That coupling broke whenever someone wanted to add fp-awareness
 *     or per-conversation isolation, and silently mis-routed when models
 *     changed (the same name was reused across models, see Bug #1 in the
 *     namespace-unification analysis).
 *   - Centralizing here means main process is the single owner of "what
 *     vectors live under what name", with renderer-side code reduced to
 *     `await api.indexAttachment({sha, kind, chunks})`.
 */

import { readDiskSettings } from '../settings/settingsAccess'
import { dispatchEmbed, type EmbeddingMode, type DispatchEmbeddingConfig } from './dispatch'
import { wrapWithFingerprint } from './resolved'
import { buildNamespace, type SourceKey } from './namespaces'
import {
  hasNamespace,
  patchNamespace,
  queryTopK,
  type Chunk,
  type ScoredChunk,
} from './vectorStore'
import type { EmbeddingProviderConfig } from './types'
import type { SharedQueryEmbedding } from './sharedQueryVector'

// ---------------------------------------------------------------------------
// Settings → DispatchEmbeddingConfig
// ---------------------------------------------------------------------------

interface EmbedSettings {
  embeddingProviderId?: string
  embeddingModel?: string
  embeddingApiKey?: string
  embeddingBaseUrl?: string
  embeddingDimensions?: number
  embeddingMode?: EmbeddingMode
  embeddingLocalModelId?: string
}

function buildDispatchConfig(): DispatchEmbeddingConfig {
  const s = readDiskSettings() as EmbedSettings
  const cloud: EmbeddingProviderConfig | undefined =
    s.embeddingProviderId && s.embeddingModel
      ? {
          providerId: s.embeddingProviderId,
          model: s.embeddingModel,
          apiKey: s.embeddingApiKey,
          baseUrl: s.embeddingBaseUrl,
          dimensions: s.embeddingDimensions,
        }
      : undefined
  return {
    mode: s.embeddingMode || 'auto',
    localModelId: s.embeddingLocalModelId || undefined,
    cloud,
  }
}

// ---------------------------------------------------------------------------
// Ad-hoc embedding (no namespace) — used by the drift monitor
// ---------------------------------------------------------------------------

/**
 * Embed a small batch of texts using whatever embedding backend the user's
 * settings resolve to (local bge-m3 / cloud). No namespace, no persistence —
 * pure "texts in, vectors out" for lightweight similarity checks (e.g. the
 * goal-drift monitor). Callers must treat failure as a soft no-op: embedding
 * may be unconfigured or the local model not yet downloaded.
 */
export async function embedTextsViaSettings(
  texts: string[],
): Promise<{ ok: boolean; vectors: number[][]; error?: string }> {
  if (texts.length === 0) return { ok: true, vectors: [] }
  const cfg = buildDispatchConfig()
  if (cfg.mode === 'cloud' && !cfg.cloud) {
    return { ok: false, vectors: [], error: 'cloud embedding not configured' }
  }
  const r = await dispatchEmbed(cfg, texts)
  if (!r.ok) return { ok: false, vectors: [], error: r.error }
  return { ok: true, vectors: r.vectors }
}

// ---------------------------------------------------------------------------
// Attachment indexing & query
// ---------------------------------------------------------------------------

export interface AttachmentIndexInput {
  sha256: string
  /** PDF / Excel / etc. — extraction kind, used to keep different parses of
   *  the same bytes in distinct namespaces. */
  kind: string
  /** Optional human-readable label for the registry / Settings UI. */
  sourceLabel?: string
  /** Pre-chunked text. Chunk shape mirrors what `chunkText` produces. */
  chunks: Array<{
    id?: string
    index: number
    text: string
    meta?: Record<string, unknown>
  }>
}

export interface IndexAttachmentResult {
  ok: boolean
  /** New or pre-existing namespace; useful for debugging. */
  namespace?: string
  /** True when the namespace was already populated and we skipped embedding. */
  skipped?: boolean
  error?: string
}

/** Source key for a (sha, kind) attachment pair. */
function attachmentSourceKey(sha256: string, kind: string): SourceKey {
  return { kind: 'attachment', id: `${kind}:${sha256.toLowerCase()}` }
}

export async function indexAttachment(
  input: AttachmentIndexInput,
): Promise<IndexAttachmentResult> {
  if (!input.sha256 || input.chunks.length === 0) {
    return { ok: true, skipped: true }
  }
  const cfg = buildDispatchConfig()
  if (cfg.mode === 'cloud' && !cfg.cloud) {
    return { ok: false, error: 'cloud embedding not configured' }
  }

  // Probe with a single embed call to learn fp + dim. Cheap (1 vector) and
  // necessary because fp depends on the model that actually runs.
  const probeText = input.chunks[0].text
  const probe = await dispatchEmbed(cfg, [probeText])
  if (!probe.ok) return { ok: false, error: probe.error }
  const wrapped = wrapWithFingerprint(cfg, probe)
  const ns = buildNamespace(attachmentSourceKey(input.sha256, input.kind), wrapped.fp)

  // Idempotent: if this exact (attachment × model) combo is already indexed,
  // reuse it. The probe vector we just paid for is discarded — that's fine,
  // the steady state is "user opens same PDF twice → 1 wasted probe call".
  if (await hasNamespace(ns)) {
    return { ok: true, namespace: ns, skipped: true }
  }

  // Embed the rest in batches, then upsert as one atomic write.
  const remaining = input.chunks.slice(1).map((c) => c.text)
  const allVectors: number[][] = [...probe.vectors]
  const BATCH = 32
  for (let off = 0; off < remaining.length; off += BATCH) {
    const batch = remaining.slice(off, off + BATCH)
    const r = await dispatchEmbed(cfg, batch)
    if (!r.ok) return { ok: false, error: r.error }
    if (r.dim !== wrapped.dim) {
      return {
        ok: false,
        error: `dim drift mid-index (${wrapped.dim} → ${r.dim}); aborting`,
      }
    }
    allVectors.push(...r.vectors)
  }

  const storedChunks: Chunk[] = input.chunks.map((c, i) => ({
    id: c.id ?? `${ns}-${c.index ?? i}`,
    index: c.index ?? i,
    text: c.text,
    meta: c.meta,
  }))

  await patchNamespace(
    ns,
    {
      model: wrapped.modelLabel,
      replaceAll: { chunks: storedChunks, vectors: allVectors },
    },
    {
      kind: 'attachment',
      sourceLabel: input.sourceLabel || `attachment:${input.kind}`,
    },
  )

  return { ok: true, namespace: ns }
}

export interface AttachmentQueryInput {
  query: string
  /** Logical attachments to search across — main process maps to namespaces. */
  attachments: Array<{ sha256: string; kind: string }>
  topK?: number
  /**
   * Optional upstream-computed query embedding. When the retrieval prefetch
   * pipeline has already embedded the query for memory + workspace, it
   * passes the same vector+fp here so the attachment RAG reuses it instead
   * of paying for a duplicate forward pass.
   */
  shared?: SharedQueryEmbedding
  /** Cosine floor passed straight to vectorStore.queryTopK. Default 0 (no floor). */
  minScore?: number
}

export interface AttachmentHit {
  text: string
  score: number
  namespace: string
  meta?: Record<string, unknown>
}

export interface QueryAttachmentsResult {
  ok: boolean
  hits: AttachmentHit[]
  /** Total number of namespaces consulted (matches were 0 if hits.length=0). */
  searched: number
  error?: string
}

export async function queryAttachments(
  input: AttachmentQueryInput,
): Promise<QueryAttachmentsResult> {
  if (!input.query.trim() || input.attachments.length === 0) {
    return { ok: true, hits: [], searched: 0 }
  }

  // When the retrieval prefetch pipeline has already embedded the query,
  // reuse that vector + fp so attachment RAG doesn't issue a second embed.
  let qVec: number[]
  let qFp: string
  if (input.shared) {
    qVec = input.shared.vector
    qFp = input.shared.fp
  } else {
    const cfg = buildDispatchConfig()
    if (cfg.mode === 'cloud' && !cfg.cloud) {
      return { ok: false, hits: [], searched: 0, error: 'cloud embedding not configured' }
    }
    const qr = await dispatchEmbed(cfg, [input.query])
    if (!qr.ok || qr.vectors.length === 0) {
      return qr.ok
        ? { ok: true, hits: [], searched: 0 }
        : { ok: false, hits: [], searched: 0, error: qr.error }
    }
    const wrapped = wrapWithFingerprint(cfg, qr)
    qVec = qr.vectors[0]
    qFp = wrapped.fp
  }

  // Compute the candidate namespace for each attachment under THIS fp; only
  // include those that actually exist on disk so we don't waste IO on misses.
  const namespaces: string[] = []
  for (const a of input.attachments) {
    if (!a.sha256) continue
    const ns = buildNamespace(attachmentSourceKey(a.sha256, a.kind), qFp)
    if (await hasNamespace(ns)) namespaces.push(ns)
  }
  if (namespaces.length === 0) {
    return { ok: true, hits: [], searched: 0 }
  }

  const topK = Math.max(1, input.topK ?? 6)
  const scored: ScoredChunk[] = await queryTopK(qVec, {
    topK,
    namespaces,
    minScore: input.minScore,
  })
  return {
    ok: true,
    searched: namespaces.length,
    hits: scored.map((s) => ({
      text: s.text,
      score: s.score,
      namespace: s.namespace,
      meta: s.meta,
    })),
  }
}
