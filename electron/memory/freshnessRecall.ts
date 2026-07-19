/**
 * Freshness recall — a cheap, zero-configuration signal that keeps recent
 * memories eligible for fusion no matter what the query looks like.
 *
 * Rationale: when a user says "that bug I hit yesterday", no embedding or
 * BM25 signal will catch it — but a freshness pass that surfaces everything
 * updated in the last N days will.
 *
 * Scoring:
 *   rank_score = exp(-ageDays / halfLife)       (decays smoothly)
 * Half-life defaults to 14 days so something created ~2 weeks ago still has
 * half the weight of something from today. Callers can override.
 */

import type { MemoryEntry } from './types'

export interface FreshnessHit {
  filename: string
  score: number
  ageDays: number
}

function parseDate(s: unknown): number | null {
  if (!s) return null
  const t = new Date(String(s)).getTime()
  return Number.isFinite(t) ? t : null
}

function memoryMtime(m: MemoryEntry): number {
  const fm = m.frontmatter
  const updated = parseDate(fm.updated)
  if (updated) return updated
  const created = parseDate(fm.created)
  if (created) return created
  return 0
}

export function freshnessRank(
  memories: MemoryEntry[],
  opts: { halfLifeDays?: number; now?: number; topK?: number } = {},
): FreshnessHit[] {
  const halfLife = opts.halfLifeDays ?? 14
  const now = opts.now ?? Date.now()
  const topK = opts.topK ?? 10
  const DAY = 86_400_000

  const hits: FreshnessHit[] = []
  for (const m of memories) {
    const mtime = memoryMtime(m)
    if (!mtime) continue
    const ageDays = Math.max(0, (now - mtime) / DAY)
    const score = Math.exp(-ageDays / halfLife)
    // Drop near-zero signals so they don't eat candidate slots.
    if (score < 0.05) continue
    hits.push({ filename: m.filename, score, ageDays })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, topK)
}
