/**
 * Hybrid memory-recall pipeline.
 *
 *   query → [ ① vector ② BM25 ③ freshness ④ structured ] → RRF fusion
 *         → [ optional rerank ] → [ optional LLM selector ] → final top-N
 *
 * Every retrieval source is optional. Each can fail or be disabled
 * independently without collapsing the pipeline — we simply drop that list
 * from the RRF input. This is how we get graceful degradation:
 *
 *   - no embedding configured?      → ①, ⑥ skipped, still have BM25 +
 *                                      freshness + structured + ⑦
 *   - no reranker configured?       → ⑥ skipped
 *   - LLM selector disabled?        → ⑦ skipped, RRF output wins
 *   - brand-new memory, not yet     → ② + ③ + ④ still find it
 *     embedded?
 *
 * Scoring details + weights live in this file so tuning happens in one place.
 */

import type { MemoryEntry } from './types'
import { bm25Rank } from './bm25'
import { freshnessRank } from './freshnessRecall'
import { parseStructuredQuery, structuredMatch } from './structuredQuery'
import { reciprocalRankFusion, type RankedList } from './rrf'
import { readDiskSettings } from '../settings/settingsAccess'
import {
  isEmbeddingRecallConfigured,
  rankMemoriesByEmbedding,
} from './embeddingRecall'
import { rerank as rerankCall } from '../embedding/client'
import type { SharedQueryEmbedding } from '../embedding/sharedQueryVector'

const CAND_POOL_SIZE = 30
/**
 * Final number of recalled memories surfaced per turn. Exported so tests
 * and observability code reference a single source of truth instead of
 * re-grepping the file for the literal `5`. This is the single cap shared by
 * the hybrid pipeline, the AI re-selector (`findRelevantMemories`), and the
 * sync keyword path (`recallForPrompt`) — keep them aligned via this constant.
 */
export const RECALL_FINAL_TOP_K = 5
const FINAL_TOP = RECALL_FINAL_TOP_K

interface Settings {
  memoryHybridRecallEnabled?: boolean
  memoryFreshnessWeight?: number
  memoryAiRecallEnabled?: boolean
  // rerank config (reused from embedding subsystem)
  rerankProviderId?: string
  rerankModel?: string
  rerankApiKey?: string
  rerankBaseUrl?: string
}

export interface RecallDebugTrace {
  sources: string[]
  candidateCount: number
  rerankUsed: boolean
  llmSelectorUsed: boolean
  structuredFilters?: {
    tags: string[]
    type?: string
    scope?: string
    since?: number
  }
}

export interface RecallResult {
  entries: MemoryEntry[]
  trace: RecallDebugTrace
}

/**
 * Main entry — runs all retrieval sources in parallel where possible, fuses
 * with RRF, optionally reranks and LLM-selects, returns the final entries.
 *
 * `opts.shared` is an upstream-computed query embedding reused by the
 * vector source. When provided it skips the per-call `dispatchEmbed` on
 * the query side of memory-vector recall, and the prefetch pipeline can
 * fan the same vector out to workspace code + attachment retrieval at no
 * extra embedding cost.
 */
export async function hybridRecall(
  query: string,
  memories: MemoryEntry[],
  opts: {
    shared?: SharedQueryEmbedding
    /**
     * Cosine floor for the vector source — passed straight to
     * rankMemoriesByEmbedding, so sub-floor candidates never enter the
     * RRF input. BM25 / freshness / structured ranks are unaffected.
     */
    minScore?: number
    /**
     * Final candidate count to return. Defaults to {@link FINAL_TOP}
     * ({@link RECALL_FINAL_TOP_K}) — the per-turn surfaced cap. Callers that
     * feed the result into a downstream LLM re-selector (see
     * `findRelevantMemories`) pass a wider value so the selector has real
     * choice instead of being starved to the surfaced top-N (audit M2).
     */
    topK?: number
  } = {},
): Promise<RecallResult> {
  const settings = readDiskSettings() as Settings
  const hybridEnabled = settings.memoryHybridRecallEnabled !== false
  const finalTop = Math.max(1, opts.topK ?? FINAL_TOP)

  const trace: RecallDebugTrace = {
    sources: [],
    candidateCount: 0,
    rerankUsed: false,
    llmSelectorUsed: false,
  }

  const filters = parseStructuredQuery(query)
  if (filters.hasAny) {
    trace.structuredFilters = {
      tags: filters.tags,
      type: filters.type,
      scope: filters.scope,
      since: filters.sinceMs,
    }
  }
  const effectiveQuery = filters.residual || query

  // Pre-filter pool by structured directives if any were present, so downstream
  // sources only rank within the allowed set.
  const pool = filters.hasAny
    ? applyStructuredFilter(memories, filters)
    : memories

  if (!hybridEnabled) {
    // Hybrid disabled → fall back to the simplest thing that used to work:
    // BM25 on the residual, then freshness as a tiny tiebreaker.
    const bm = bm25Rank(effectiveQuery, pool, finalTop)
    const byName = new Map(pool.map((m) => [m.filename, m]))
    return {
      entries: bm.map((h) => byName.get(h.filename)!).filter(Boolean),
      trace: { ...trace, sources: ['bm25'], candidateCount: bm.length },
    }
  }

  // -------- Parallel retrieval --------
  // BM25 / freshness / structured never need an embedding, so they run
  // synchronously regardless of what the shared-vector branch is doing.
  // The vector branch reuses `opts.shared` when the retrieval prefetch
  // pipeline already computed the query vector upstream.
  const embedCfg = isEmbeddingRecallConfigured()
  const [vectorRes, bmRes, freshRes] = await Promise.all([
    embedCfg
      ? rankMemoriesByEmbedding(effectiveQuery, pool, {
          shared: opts.shared,
          minScore: opts.minScore,
        }).catch(() => [] as MemoryEntry[])
      : Promise.resolve([]),
    Promise.resolve(bm25Rank(effectiveQuery, pool, 50)),
    Promise.resolve(freshnessRank(pool, { topK: 10 })),
  ])
  const structuredHits = filters.hasAny ? structuredMatch(filters, pool) : []

  const lists: RankedList<string>[] = []
  if (vectorRes.length > 0) {
    trace.sources.push('vector')
    lists.push({
      name: 'vector',
      weight: 1.0,
      items: vectorRes.map((m) => ({ id: m.filename })),
    })
  }
  if (bmRes.length > 0) {
    trace.sources.push('bm25')
    lists.push({
      name: 'bm25',
      weight: 1.0,
      items: bmRes.map((h) => ({ id: h.filename })),
    })
  }
  if (freshRes.length > 0) {
    const fw = typeof settings.memoryFreshnessWeight === 'number'
      ? settings.memoryFreshnessWeight
      : 0.5
    if (fw > 0) {
      trace.sources.push('freshness')
      // Map user-facing weight (0..1) to RRF list weight (0..1.5).
      lists.push({
        name: 'freshness',
        weight: 0.3 + fw * 1.2,
        items: freshRes.map((h) => ({ id: h.filename })),
      })
    }
  }
  if (structuredHits.length > 0) {
    trace.sources.push('structured')
    // Structured directives are explicit user intent → dominant weight.
    lists.push({
      name: 'structured',
      weight: 2.0,
      items: structuredHits.map((h) => ({ id: h.filename })),
    })
  }

  // If no source produced anything (all disabled / empty corpus), bail cleanly.
  if (lists.length === 0) {
    // CTX-01: warn so operators can distinguish 'no memories found' from
    // 'everything is broken and we silently returned nothing'.
    console.warn(
      '[hybridRecall] all retrieval sources returned empty — no results for query:',
      effectiveQuery.slice(0, 120),
    )
    return { entries: [], trace }
  }

  const fused = reciprocalRankFusion(lists, { topK: CAND_POOL_SIZE })
  trace.candidateCount = fused.length

  // Map back to entries.
  const byName = new Map(pool.map((m) => [m.filename, m]))
  let candidates = fused
    .map((h) => byName.get(h.id))
    .filter((m): m is MemoryEntry => !!m)

  // -------- Optional rerank --------
  if (candidates.length > 1 && settings.rerankModel && settings.rerankProviderId) {
    try {
      const docs = candidates.map((m, idx) => ({
        id: String(idx),
        text: memoryRerankText(m),
      }))
      const r = await rerankCall(
        {
          providerId: settings.rerankProviderId,
          model: settings.rerankModel,
          apiKey: settings.rerankApiKey,
          baseUrl: settings.rerankBaseUrl,
        },
        effectiveQuery,
        docs,
      )
      if (r.ok) {
        trace.rerankUsed = true
        // The id we passed to rerank was the original candidate index.
        // Build an O(n) index → score table so we can sort without doing an
        // O(n) `indexOf` inside the comparator (which would also race with
        // the in-progress sort, see embeddingRecall.ts for the same fix).
        const scoreByIndex = new Array<number>(candidates.length).fill(0)
        for (const it of r.results) {
          const idx = Number(it.id)
          if (Number.isFinite(idx) && idx >= 0 && idx < candidates.length) {
            scoreByIndex[idx] = it.score
          }
        }
        const annotated = candidates.map((item, idx) => ({ item, score: scoreByIndex[idx] }))
        annotated.sort((a, b) => b.score - a.score)
        candidates = annotated.map((a) => a.item)
      }
    } catch {
      // Advisory — keep RRF order.
    }
  }

  // Truncate to final size. LLM selector (caller's concern) decides further.
  candidates = candidates.slice(0, finalTop)
  return { entries: candidates, trace }
}

function memoryRerankText(m: MemoryEntry): string {
  const fm = m.frontmatter
  const head = [fm.name, fm.description].filter(Boolean).join(' · ')
  const body = (m.content || '').slice(0, 1500)
  return head ? `${head}\n${body}` : body
}

function applyStructuredFilter(
  memories: MemoryEntry[],
  filters: ReturnType<typeof parseStructuredQuery>,
): MemoryEntry[] {
  return memories.filter((m) => {
    const fm = m.frontmatter
    if (filters.tags.length > 0) {
      const tagLower = (fm.tags || []).map((t: string) => t.toLowerCase())
      for (const t of filters.tags) {
        if (!tagLower.includes(t)) return false
      }
    }
    if (filters.type && (fm.type || '').toLowerCase() !== filters.type) return false
    if (filters.scope && (fm.scope || '').toLowerCase() !== filters.scope) return false
    if (filters.sinceMs) {
      const t = new Date(String(fm.updated || fm.created || 0)).getTime()
      if (!Number.isFinite(t) || t < filters.sinceMs) return false
    }
    return true
  })
}
