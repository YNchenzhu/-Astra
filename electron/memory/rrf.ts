/**
 * Reciprocal Rank Fusion — the Microsoft-paper / Elasticsearch-recommended
 * default for merging heterogeneous retrieval result lists.
 *
 *   score(doc) = Σ over lists L:  1 / (k + rank_in_L)
 *
 * Key property: the formula depends only on rank positions, not on raw
 * scores — so we can safely merge BM25 (TF-IDF), cosine similarity, freshness
 * decay and structured-match counts without score calibration.
 *
 * We also apply per-list weights. Structured matches get 2x weight so an
 * explicit `#tag` directive always wins over soft matches; freshness gets
 * 0.7x because it's a signal about *candidacy*, not *relevance*.
 */

export interface RankedList<ID = string> {
  name: string
  weight?: number
  items: Array<{ id: ID; score?: number }>
}

export interface FusedHit<ID = string> {
  id: ID
  score: number
  contributions: Record<string, number>
}

const DEFAULT_K = 60

export function reciprocalRankFusion<ID extends string>(
  lists: RankedList<ID>[],
  opts: { k?: number; topK?: number } = {},
): FusedHit<ID>[] {
  const k = opts.k ?? DEFAULT_K
  const topK = opts.topK ?? 30
  const agg = new Map<ID, FusedHit<ID>>()

  for (const list of lists) {
    const w = list.weight ?? 1
    for (let rank = 0; rank < list.items.length; rank++) {
      const it = list.items[rank]
      const contribution = w / (k + rank + 1)
      const cur = agg.get(it.id)
      if (cur) {
        cur.score += contribution
        cur.contributions[list.name] = (cur.contributions[list.name] || 0) + contribution
      } else {
        agg.set(it.id, {
          id: it.id,
          score: contribution,
          contributions: { [list.name]: contribution },
        })
      }
    }
  }

  const out = [...agg.values()]
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, topK)
}
