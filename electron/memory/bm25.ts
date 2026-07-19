/**
 * BM25 (Okapi) retrieval for memories.
 *
 * Chosen over pure keyword matching because:
 *   - Properly weights rare vs common terms via IDF (prevents stopword noise).
 *   - Length-normalized so long memories don't dominate just by having more
 *     keywords.
 *   - Well understood, predictable, no external deps.
 *
 * Tokenizer is intentionally simple but CJK-aware:
 *   - ASCII words: lowercased, split on non-letter/non-digit.
 *   - CJK chars: each char becomes its own token (handles Chinese queries
 *     that users write without whitespace).
 *   - 2-gram for CJK too, so "鉴权" matches "鉴权模块" even when unigram IDF
 *     makes the single char less distinctive.
 *
 * Index is cached keyed by corpus content hash; callers get cheap re-ranks
 * across turns until a memory is added/removed.
 */

import { createHash } from 'crypto'
import type { MemoryEntry } from './types'

export interface BM25Hit {
  filename: string
  score: number
}

interface IndexShape {
  k1: number
  b: number
  avgDl: number
  N: number
  docs: Array<{
    filename: string
    dl: number
    tf: Map<string, number>
  }>
  idf: Map<string, number>
}

const K1 = 1.5
const B = 0.75

/**
 * Produce a compact deterministic hash of the corpus so we know when to invalidate.
 *
 * Audit M3: keying on content LENGTH (+ `frontmatter.updated`) still missed
 * two cases — (a) same-length edits and (b) hand-edited memdir / imported
 * files whose `updated` stamp didn't move. We now hash the EXACT text that
 * feeds the index (`memoryIndexableText`, i.e. name + description + type +
 * tags + body), so any change to anything the ranker sees busts the cache.
 * The corpus is small (curated memories), so hashing the indexable text on
 * each call is sub-millisecond and worth the correctness.
 */
function corpusHash(memories: MemoryEntry[]): string {
  const lines = memories
    .map((m) => `${m.filename}\u0000${memoryIndexableText(m)}`)
    .sort()
  return createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 16)
}

let cachedHash: string | null = null
let cachedIndex: IndexShape | null = null

function memoryIndexableText(m: MemoryEntry): string {
  const fm = m.frontmatter
  const head = [fm.name, fm.description, fm.type, (fm.tags || []).join(' ')]
    .filter(Boolean)
    .join(' ')
  return `${head}\n${m.content || ''}`
}

const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
const TOKEN_SPLIT_RE = /[^\p{L}\p{N}]+/u

export function tokenize(text: string): string[] {
  if (!text) return []
  const lower = text.toLowerCase()
  const out: string[] = []
  for (const part of lower.split(TOKEN_SPLIT_RE)) {
    if (!part) continue
    // CJK-heavy segment → unigram + bigram.
    if (CJK_RE.test(part)) {
      for (let i = 0; i < part.length; i++) {
        const ch = part[i]
        if (CJK_RE.test(ch)) out.push(ch)
      }
      for (let i = 0; i < part.length - 1; i++) {
        const a = part[i]
        const b = part[i + 1]
        if (CJK_RE.test(a) && CJK_RE.test(b)) out.push(a + b)
      }
      // Also keep ASCII runs inside (e.g. a CJK+ASCII mix "API 鉴权").
      for (const sub of part.split(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/)) {
        if (sub && sub.length >= 2) out.push(sub)
      }
    } else if (part.length >= 2) {
      out.push(part)
    }
  }
  return out
}

function buildIndex(memories: MemoryEntry[]): IndexShape {
  const docs: IndexShape['docs'] = []
  const df = new Map<string, number>()
  let totalDl = 0
  for (const m of memories) {
    const tokens = tokenize(memoryIndexableText(m))
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1)
    docs.push({ filename: m.filename, dl: tokens.length, tf })
    totalDl += tokens.length
  }
  const N = docs.length
  const idf = new Map<string, number>()
  for (const [t, n] of df) {
    // BM25-plus IDF variant (never negative). Standard formula: log((N-n+0.5)/(n+0.5) + 1).
    idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)))
  }
  return {
    k1: K1,
    b: B,
    avgDl: N > 0 ? totalDl / N : 0,
    N,
    docs,
    idf,
  }
}

function ensureIndex(memories: MemoryEntry[]): IndexShape {
  const h = corpusHash(memories)
  if (cachedHash === h && cachedIndex) return cachedIndex
  cachedIndex = buildIndex(memories)
  cachedHash = h
  return cachedIndex
}

export function bm25Rank(
  query: string,
  memories: MemoryEntry[],
  topK = 50,
): BM25Hit[] {
  if (!query.trim() || memories.length === 0) return []
  const idx = ensureIndex(memories)
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return []
  const uniq = Array.from(new Set(qTokens))

  const hits: BM25Hit[] = []
  for (const doc of idx.docs) {
    let score = 0
    for (const t of uniq) {
      const f = doc.tf.get(t)
      if (!f) continue
      const idf = idx.idf.get(t) ?? 0
      const denom = f + idx.k1 * (1 - idx.b + idx.b * (doc.dl / (idx.avgDl || 1)))
      score += idf * ((f * (idx.k1 + 1)) / (denom || 1))
    }
    if (score > 0) hits.push({ filename: doc.filename, score })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, topK)
}

/** Expose for tests / debugging. */
export function _clearBm25Cache(): void {
  cachedHash = null
  cachedIndex = null
}
