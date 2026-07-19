/**
 * Structured-query recall — when the user writes explicit filter directives
 * in their query, we respect them as hard matches and merge their hits into
 * the fusion candidate pool.
 *
 * Supported directives (all optional, case-insensitive):
 *   - #tag-name             — match `frontmatter.tags` contains this tag
 *   - type:fact             — match `frontmatter.type`
 *   - scope:project|user    — match `frontmatter.scope`
 *   - since:7d / since:2w / since:1m / since:2024-01-15
 *                           — only memories newer than that window
 *
 * The parser strips these directives from the returned `residual` string so
 * the downstream BM25 / vector search sees a clean query.
 */

import type { MemoryEntry } from './types'

export interface StructuredFilters {
  tags: string[]
  type?: string
  scope?: string
  sinceMs?: number
  residual: string
  hasAny: boolean
}

const TAG_RE = /(?:^|\s)#([\p{L}\p{N}_-]{2,})/gu
const KV_RE = /(?:^|\s)(type|scope|since):([\p{L}\p{N}_.-]+)/gu

export function parseStructuredQuery(
  query: string,
  now: number = Date.now(),
): StructuredFilters {
  const tags: string[] = []
  let type: string | undefined
  let scope: string | undefined
  let sinceMs: number | undefined

  let residual = query

  for (const m of query.matchAll(TAG_RE)) {
    tags.push(m[1].toLowerCase())
    residual = residual.replace(m[0], ' ')
  }
  for (const m of query.matchAll(KV_RE)) {
    const key = m[1].toLowerCase()
    const value = m[2]
    residual = residual.replace(m[0], ' ')
    if (key === 'type') type = value.toLowerCase()
    else if (key === 'scope') scope = value.toLowerCase()
    else if (key === 'since') {
      const parsed = parseSince(value, now)
      if (parsed) sinceMs = parsed
    }
  }

  residual = residual.replace(/\s+/g, ' ').trim()
  const hasAny = tags.length > 0 || !!type || !!scope || !!sinceMs
  return { tags, type, scope, sinceMs, residual, hasAny }
}

function parseSince(v: string, now: number): number | null {
  const m = /^(\d+)([dwmy])$/i.exec(v)
  if (m) {
    const n = Number(m[1])
    const unit = m[2].toLowerCase()
    const days = unit === 'd' ? n : unit === 'w' ? n * 7 : unit === 'm' ? n * 30 : n * 365
    return now - days * 86_400_000
  }
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

export interface StructuredHit {
  filename: string
  score: number
  reasons: string[]
}

/**
 * Apply the structured filters. Hits scored by the number of directives matched
 * (so a memory hitting tag + type + scope outranks one hitting tag alone).
 */
export function structuredMatch(
  filters: StructuredFilters,
  memories: MemoryEntry[],
): StructuredHit[] {
  if (!filters.hasAny) return []
  const hits: StructuredHit[] = []
  for (const m of memories) {
    const fm = m.frontmatter
    const reasons: string[] = []
    if (filters.tags.length > 0) {
      const tagLower = (fm.tags || []).map((t: string) => t.toLowerCase())
      for (const t of filters.tags) {
        if (tagLower.includes(t)) reasons.push(`#${t}`)
      }
      if (reasons.length < filters.tags.length) continue
    }
    if (filters.type) {
      if ((fm.type || '').toLowerCase() !== filters.type) continue
      reasons.push(`type:${filters.type}`)
    }
    if (filters.scope) {
      if ((fm.scope || '').toLowerCase() !== filters.scope) continue
      reasons.push(`scope:${filters.scope}`)
    }
    if (filters.sinceMs) {
      const t = new Date(String(fm.updated || fm.created || 0)).getTime()
      if (!Number.isFinite(t) || t < filters.sinceMs) continue
      reasons.push('since-ok')
    }
    if (reasons.length === 0) continue
    hits.push({ filename: m.filename, score: reasons.length, reasons })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits
}
