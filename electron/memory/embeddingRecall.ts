/**
 * Embedding-based memory recall.
 *
 * When the user has configured an embedding model, we embed the query plus
 * each memory's content (cached by content hash) and return the top-N entries
 * by cosine similarity. An optional reranker pass further refines ordering
 * using a cross-encoder (Jina / Cohere / BGE rerankers).
 *
 * Results mix cleanly with the existing keyword / LLM-selector paths:
 *   - ranks more reliably than keyword matching on synonym-heavy queries
 *   - is ~100-300ms vs 1-3s for the LLM selector
 *   - degrades to silence (returns `[]`) on any failure so callers fall back
 *
 * Storage (post v2 namespace migration):
 *
 *   Vectors live in the unified vector store under namespace
 *
 *     memory-<sourceHash16>-<fp12>
 *
 *   where the source hash is derived from the active workspace path (so each
 *   workspace's memory cache is isolated from every other workspace), and
 *   the fingerprint reflects the embedding model that produced the vectors.
 *   Switching either of these produces a new namespace; old ones become GC
 *   candidates surfaced in Settings → 缓存管理.
 */

import { createHash } from 'crypto'
import { readDiskSettings } from '../settings/settingsAccess'
import type { MemoryEntry } from './types'
import { rerank } from '../embedding/client'
import { dispatchEmbed, type EmbeddingMode } from '../embedding/dispatch'
import { wrapWithFingerprint } from '../embedding/resolved'
import { buildNamespace, type SourceKey } from '../embedding/namespaces'
import type { SharedQueryEmbedding } from '../embedding/sharedQueryVector'
import {
  patchNamespace,
  readNamespaceChunks,
  type Chunk,
} from '../embedding/vectorStore'
import { entriesByKind, getNamespaceEntry } from '../embedding/registry'
import { getActiveMemoryWorkspaceId } from './activeWorkspace'
import type { EmbeddingProviderConfig, RerankProviderConfig } from '../embedding/types'

const MAX_RELEVANT = 8

interface Settings {
  embeddingProviderId?: string
  embeddingModel?: string
  embeddingApiKey?: string
  embeddingBaseUrl?: string
  embeddingDimensions?: number
  embeddingMode?: EmbeddingMode
  embeddingLocalModelId?: string
  rerankProviderId?: string
  rerankModel?: string
  rerankApiKey?: string
  rerankBaseUrl?: string
}

function getEmbeddingConfig(s: Settings): EmbeddingProviderConfig | null {
  if (!s.embeddingModel || !s.embeddingProviderId) return null
  return {
    providerId: s.embeddingProviderId,
    model: s.embeddingModel,
    apiKey: s.embeddingApiKey,
    baseUrl: s.embeddingBaseUrl,
    dimensions: s.embeddingDimensions,
  }
}

function getRerankConfig(s: Settings): RerankProviderConfig | null {
  if (!s.rerankModel || !s.rerankProviderId) return null
  return {
    providerId: s.rerankProviderId,
    model: s.rerankModel,
    apiKey: s.rerankApiKey,
    baseUrl: s.rerankBaseUrl,
  }
}

/**
 * Produce a stable identifier from a memory entry's content — lets us cache
 * embeddings keyed by content hash regardless of filename.
 */
function entryId(m: MemoryEntry): string {
  return createHash('sha1')
    .update(`${m.filename}:${m.content || ''}`)
    .digest('hex')
    .slice(0, 32)
}

function memoryText(m: MemoryEntry): string {
  const fm = m.frontmatter
  const header = [fm.name, fm.description, fm.type, (fm.tags || []).join(' ')]
    .filter(Boolean)
    .join(' · ')
  return (header ? `${header}\n` : '') + (m.content || '')
}

// ---------------------------------------------------------------------------
// Namespace resolution
// ---------------------------------------------------------------------------

/**
 * The "memory" source key is workspace-aware: each workspace's memory cache
 * is isolated from other workspaces. This avoids one workspace's project
 * memory tainting another's vector cache. Falls back to `'global'` when no
 * workspace is active (user-only memories).
 */
function memorySourceKey(): SourceKey {
  const ws = getActiveMemoryWorkspaceId() || 'global'
  return { kind: 'memory', id: ws }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rank memories by semantic similarity. Returns top-N entries (N ≤ MAX_RELEVANT),
 * or an empty array if embedding is not configured or any step fails.
 *
 * When the caller supplies `opts.shared` (a `SharedQueryEmbedding` produced
 * once upstream by the retrieval prefetch pipeline), the query embed step
 * is skipped and the same vector + fp are reused here. Any freshly-needed
 * memory chunk embeddings are still dispatched locally/cloud.
 */
export async function rankMemoriesByEmbedding(
  query: string,
  memories: MemoryEntry[],
  opts: {
    shared?: SharedQueryEmbedding
    /**
     * Cosine floor — entries scoring strictly below are dropped (not just
     * demoted). 0 preserves legacy behaviour of always returning the top
     * MAX_RELEVANT regardless of similarity. The retrieval prefetch
     * pipeline passes ~0.30 to suppress noise from unrelated queries.
     */
    minScore?: number
  } = {},
): Promise<MemoryEntry[]> {
  if (!query.trim() || memories.length === 0) return []
  const settings = readDiskSettings() as Settings
  const cfg = getEmbeddingConfig(settings)
  const mode: EmbeddingMode = settings.embeddingMode || 'auto'
  const localModelId = settings.embeddingLocalModelId || undefined

  // Hard-gate on "nothing configured at all". Auto + local installed still OK.
  if (mode === 'cloud' && !cfg) return []

  try {
    const dispatchCfg = opts.shared
      ? opts.shared.cfg
      : { mode, localModelId, cloud: cfg || undefined }

    // Embed the query first — always fresh, no cache. Its fingerprint also
    // determines which memory namespace we read/write. When the prefetch
    // pipeline already computed this, reuse its vector+fp so the retrieval
    // fan-out costs exactly one embed call across all three consumers.
    let qv: number[]
    let wrappedFp: string
    let wrappedDim: number
    let wrappedModelLabel: string
    if (opts.shared) {
      qv = opts.shared.vector
      wrappedFp = opts.shared.fp
      wrappedDim = opts.shared.dim
      wrappedModelLabel = opts.shared.modelLabel
    } else {
      const qr = await dispatchEmbed(dispatchCfg, [query])
      if (!qr.ok) return []
      const v0 = qr.vectors[0]
      if (!v0 || v0.length === 0) return []
      const wrapped = wrapWithFingerprint(dispatchCfg, qr)
      qv = v0
      wrappedFp = wrapped.fp
      wrappedDim = wrapped.dim
      wrappedModelLabel = wrapped.modelLabel
    }
    const ns = buildNamespace(memorySourceKey(), wrappedFp)

    // Pull whatever's already cached for this namespace (chunks + vectors).
    // Both are normalized at write time, so cosine == dot product against the
    // (also-normalized) query vector.
    const stored = await readNamespaceChunks(ns)
    const storedById = new Map<string, number[]>()
    if (stored && stored.dim === wrappedDim) {
      for (let i = 0; i < stored.chunks.length; i++) {
        storedById.set(stored.chunks[i].id, stored.vectors[i] || [])
      }
    }

    // Embed any memory entry whose chunk id isn't already indexed.
    const memoryIds = memories.map(entryId)
    const need: { i: number; mem: MemoryEntry }[] = []
    for (let i = 0; i < memories.length; i++) {
      if (!storedById.has(memoryIds[i])) need.push({ i, mem: memories[i] })
    }
    const qNorm = normalize(qv)
    if (need.length > 0) {
      const texts = need.map((n) => memoryText(n.mem))
      const r = await dispatchEmbed(dispatchCfg, texts)
      if (!r.ok) return []
      if (r.dim !== wrappedDim) return []
      const newChunks: Chunk[] = need.map((n, k) => ({
        id: memoryIds[n.i],
        index: n.i,
        text: texts[k],
        meta: { filename: n.mem.filename },
      }))
      await patchNamespace(
        ns,
        {
          model: wrappedModelLabel,
          upsert: { chunks: newChunks, vectors: r.vectors },
        },
        { kind: 'memory', sourceLabel: `memory:${memorySourceKey().id}` },
      )
      // Cache freshly-computed vectors so the score loop below can read them
      // without doing another disk roundtrip.
      for (let k = 0; k < newChunks.length; k++) {
        storedById.set(memoryIds[need[k].i], normalize(r.vectors[k]))
      }
    }

    // Score every memory by cosine of its (normalized) vector vs the
    // (normalized) query vector. Stored vectors are already normalized; new
    // vectors were normalized above.
    const minScore = typeof opts.minScore === 'number' ? opts.minScore : 0
    const scored = memories
      .map((m, i) => {
        const v = storedById.get(memoryIds[i])
        return { mem: m, score: v && v.length === qNorm.length ? dot(qNorm, v) : 0 }
      })
      // Drop sub-floor scores BEFORE the sort + slice so the reranker is
      // never asked to "polish" obviously-irrelevant candidates (it would
      // happily move noise around and the top-K would still be noise).
      .filter((s) => s.score >= minScore)
    scored.sort((a, b) => b.score - a.score)

    // Over-fetch for reranker input.
    const candidate = scored.slice(0, Math.max(MAX_RELEVANT * 2, 12))

    // Optional rerank pass.
    const rrCfg = getRerankConfig(settings)
    if (rrCfg && candidate.length > 1) {
      try {
        const r = await rerank(
          rrCfg,
          query,
          candidate.map((c, idx) => ({ id: String(idx), text: memoryText(c.mem) })),
        )
        if (r.ok) {
          const scoreByIndex = new Array<number>(candidate.length).fill(0)
          for (const it of r.results) {
            const idx = Number(it.id)
            if (Number.isFinite(idx) && idx >= 0 && idx < candidate.length) {
              scoreByIndex[idx] = it.score
            }
          }
          const annotated = candidate.map((item, idx) => ({ item, score: scoreByIndex[idx] }))
          annotated.sort((a, b) => b.score - a.score)
          candidate.length = 0
          for (const a of annotated) candidate.push(a.item)
        }
      } catch {
        // Rerank is advisory — fall back to embedding rank.
      }
    }

    return candidate.slice(0, MAX_RELEVANT).map((c) => c.mem)
  } catch {
    return []
  }
}

function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function normalize(v: number[]): number[] {
  let s = 0
  for (const x of v) s += x * x
  const inv = s > 0 ? 1 / Math.sqrt(s) : 0
  return v.map((x) => x * inv)
}

/** Whether embedding-based recall is configured (cheap settings check). */
export function isEmbeddingRecallConfigured(): boolean {
  const s = readDiskSettings() as Settings
  const mode: EmbeddingMode = s.embeddingMode || 'auto'
  const cloudConfigured = !!(s.embeddingModel && s.embeddingProviderId)
  if (mode === 'cloud') return cloudConfigured
  if (mode === 'local') return true
  // auto mode is optimistic; dispatch will skip if neither path works
  return true
}

/**
 * Re-export the registry entry helper so other memory modules can
 * introspect what's currently cached without re-implementing the lookup.
 * Used by the "stale memory cache" GC button in Settings → 缓存管理.
 */
export async function getMemoryNamespaceMeta(fp: string) {
  const ns = buildNamespace(memorySourceKey(), fp)
  return getNamespaceEntry(ns)
}

/**
 * Drop chunks that no longer correspond to a live memory MD file.
 *
 * The vector cache keys each chunk by `entryId(m) = sha1(filename:content)`
 * and stores `meta.filename` alongside. Whenever a memory MD file is
 * renamed, deleted, or has its content rewritten, the OLD chunk ID is
 * never referenced again — but with no GC it stays in the namespace
 * forever, bloating disk and quietly polluting the cosine top-K with
 * stale memories that no longer exist on disk (MEM2).
 *
 * Strategy:
 *   1. Take the current set of live memory entries (their filename +
 *      content).
 *   2. For every "memory"-kind namespace owned by this workspace, walk
 *      its chunks and mark a chunk orphan when:
 *        - `meta.filename` is missing or not in the live set (file
 *          deleted/renamed), OR
 *        - `meta.filename` is live but the chunk's `id` doesn't match
 *          the live entry's id (content rewritten — old version is
 *          stale).
 *   3. Issue one `patchNamespace.remove` per namespace touched.
 *
 * Returns a count for logging. Best-effort — any single namespace failure
 * is swallowed so a partial GC pass still helps.
 */
export async function pruneOrphanMemoryVectors(
  active: ReadonlyArray<{ filename: string; content: string }>,
): Promise<{ removed: number; namespaces: number }> {
  const activeFilenames = new Set<string>()
  const activeIds = new Set<string>()
  for (const a of active) {
    activeFilenames.add(a.filename)
    activeIds.add(
      createHash('sha1')
        .update(`${a.filename}:${a.content || ''}`)
        .digest('hex')
        .slice(0, 32),
    )
  }

  const wsId = getActiveMemoryWorkspaceId() || 'global'
  const wsLabel = `memory:${wsId}`
  const allMemoryNs = await entriesByKind('memory')
  // Only touch namespaces owned by this workspace. Cross-workspace caches
  // (different `sourceLabel`) are out of scope for this prune — they're
  // managed by their own active workspace.
  const ours = allMemoryNs.filter((e) => e.sourceLabel === wsLabel)

  let removed = 0
  let touched = 0
  for (const entry of ours) {
    try {
      const stored = await readNamespaceChunks(entry.ns)
      if (!stored || stored.chunks.length === 0) continue
      const orphanIds: string[] = []
      for (const c of stored.chunks) {
        const meta = c.meta as { filename?: unknown } | undefined
        const filename =
          typeof meta?.filename === 'string' ? meta.filename : undefined
        if (!filename || !activeFilenames.has(filename)) {
          orphanIds.push(c.id)
          continue
        }
        // Filename is alive — check whether THIS chunk's id matches a live
        // entry id. If not, it's a stale-content version of a still-living
        // file; safe to drop.
        if (!activeIds.has(c.id)) {
          orphanIds.push(c.id)
        }
      }
      if (orphanIds.length === 0) continue
      await patchNamespace(entry.ns, { remove: orphanIds })
      removed += orphanIds.length
      touched++
    } catch (err) {
      // Best-effort — log and continue so one bad namespace doesn't
      // poison the whole pass.
      console.warn(
        `[memory.pruneOrphanMemoryVectors] failed on ns=${entry.ns}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return { removed, namespaces: touched }
}

/**
 * Pre-embed and upsert memory entries so the next recall doesn't have to
 * pay for the embed forward pass(es) inline.
 *
 * Called from `autoExtractFromConversation` immediately after writing new
 * memory MD files: closes the embed/extract feedback loop (MEM-ARCH1).
 * Pre-audit, freshly written memories were only embedded the first time
 * `rankMemoriesByEmbedding` was called for a query that needed them — so
 * the very next user turn, that turn paid the embed cost; here we move
 * that cost off the critical path.
 *
 * Best-effort:
 *   - Returns silently when embedding isn't configured (mode=cloud + no
 *     cloud config).
 *   - Returns silently when an entry's chunk id is already in the
 *     namespace (re-extract of unchanged content is a no-op).
 *   - Any failure (network blip, ONNX miss, dim mismatch) is swallowed —
 *     the next recall path will retry.
 *
 * Returns the count for logging. Idempotent.
 */
export async function precomputeMemoryEmbeddings(
  active: ReadonlyArray<MemoryEntry>,
): Promise<{ embedded: number; cached: number }> {
  if (active.length === 0) return { embedded: 0, cached: 0 }

  const settings = readDiskSettings() as Settings
  const cfg = getEmbeddingConfig(settings)
  const mode: EmbeddingMode = settings.embeddingMode || 'auto'
  const localModelId = settings.embeddingLocalModelId || undefined
  if (mode === 'cloud' && !cfg) return { embedded: 0, cached: 0 }

  try {
    const dispatchCfg = { mode, localModelId, cloud: cfg || undefined }

    // Embed a dummy "warmup" string just to resolve the namespace fp under
    // the current model. We don't use this vector for scoring — the cost
    // is one tiny forward pass, paid once per warmup batch instead of
    // once per memory at query time.
    //
    // Could be optimised by exporting `wrapWithFingerprint` of just the
    // model config, but the fp may depend on the model's cloud reply
    // (output dim), so a real embed call is the safe path.
    const probe = await dispatchEmbed(dispatchCfg, ['__warmup__'])
    if (!probe.ok) return { embedded: 0, cached: 0 }
    const wrapped = wrapWithFingerprint(dispatchCfg, probe)
    const ns = buildNamespace(memorySourceKey(), wrapped.fp)

    const stored = await readNamespaceChunks(ns)
    const haveIds = new Set<string>()
    if (stored && stored.dim === wrapped.dim) {
      for (const c of stored.chunks) haveIds.add(c.id)
    }

    const need: { id: string; mem: MemoryEntry; index: number }[] = []
    let cached = 0
    for (let i = 0; i < active.length; i++) {
      const m = active[i]
      const id = entryId(m)
      if (haveIds.has(id)) {
        cached++
        continue
      }
      need.push({ id, mem: m, index: i })
    }
    if (need.length === 0) return { embedded: 0, cached }

    const texts = need.map((n) => memoryText(n.mem))
    const r = await dispatchEmbed(dispatchCfg, texts)
    if (!r.ok || r.dim !== wrapped.dim) return { embedded: 0, cached }

    const newChunks: Chunk[] = need.map((n, k) => ({
      id: n.id,
      index: n.index,
      text: texts[k],
      meta: { filename: n.mem.filename },
    }))
    await patchNamespace(
      ns,
      {
        model: wrapped.modelLabel,
        upsert: { chunks: newChunks, vectors: r.vectors },
      },
      { kind: 'memory', sourceLabel: `memory:${memorySourceKey().id}` },
    )
    return { embedded: newChunks.length, cached }
  } catch {
    return { embedded: 0, cached: 0 }
  }
}
