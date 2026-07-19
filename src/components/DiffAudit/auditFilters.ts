/**
 * Pure filter + formatter helpers for the DiffTransaction audit panel (P4e).
 *
 * Extracted into a standalone module so the UI component stays a thin render layer and
 * the interesting logic (text search, state/time filtering, humanized timestamps) is
 * unit-testable without React/Monaco in the loop.
 */

import type { RendererDiffTransaction, RendererDtState } from '../../stores/useDiffTransactionStore'

export interface AuditFilter {
  /** Case-insensitive substring match against filePath or error.message. Empty = any. */
  text: string
  /** If non-empty, only transactions whose state is in this set. Empty = any. */
  states: ReadonlySet<RendererDtState>
  /** Only include transactions whose updatedAt is AT or AFTER this epoch-ms. 0 = any. */
  sinceMs: number
}

export const EMPTY_FILTER: AuditFilter = {
  text: '',
  states: new Set(),
  sinceMs: 0,
}

/** Basename only for display; we don't want long absolute paths dominating the list. */
export function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

/**
 * Human-friendly relative time. Keeps the audit list readable — exact timestamps are
 * still shown in the detail view on the right.
 */
export function humanizeRelative(epochMs: number, now: number = Date.now()): string {
  const deltaS = Math.max(0, Math.floor((now - epochMs) / 1000))
  if (deltaS < 5) return 'just now'
  if (deltaS < 60) return `${deltaS}s ago`
  const deltaMin = Math.floor(deltaS / 60)
  if (deltaMin < 60) return `${deltaMin}m ago`
  const deltaHr = Math.floor(deltaMin / 60)
  if (deltaHr < 24) return `${deltaHr}h ago`
  const deltaDay = Math.floor(deltaHr / 24)
  return `${deltaDay}d ago`
}

/**
 * Filter + sort the DT list for display. Terminal DTs sink to the bottom; non-terminal
 * rise (user wants to see active work first). Within each group, newest-first by
 * `updatedAt`.
 */
export function filterAndSort(
  transactions: readonly RendererDiffTransaction[],
  filter: AuditFilter,
): RendererDiffTransaction[] {
  const needle = filter.text.trim().toLowerCase()
  const wantStates = filter.states.size > 0
  const filtered = transactions.filter((tx) => {
    if (filter.sinceMs > 0 && tx.updatedAt < filter.sinceMs) return false
    if (wantStates && !filter.states.has(tx.state)) return false
    if (needle !== '') {
      const hay = (
        tx.filePath.toLowerCase() +
        ' ' +
        (tx.error?.message ?? '').toLowerCase() +
        ' ' +
        (tx.proposed?.toolName ?? '').toLowerCase()
      )
      if (!hay.includes(needle)) return false
    }
    return true
  })

  const isTerminal = (s: RendererDtState): boolean => s === 'Applied' || s === 'Rejected'
  return filtered.sort((a, b) => {
    const at = isTerminal(a.state) ? 1 : 0
    const bt = isTerminal(b.state) ? 1 : 0
    if (at !== bt) return at - bt
    return b.updatedAt - a.updatedAt
  })
}

/** Cheap summary used by the row view: "+N / −M lines" from baseSnapshot vs proposed. */
export function summarizeLineDelta(tx: RendererDiffTransaction): { added: number; removed: number } {
  const base = tx.baseSnapshot?.content ?? ''
  const prop = tx.proposed?.content ?? ''
  const baseLines = base === '' ? [] : base.split(/\r?\n/)
  const propLines = prop === '' ? [] : prop.split(/\r?\n/)
  // Crude: compare lengths. For row-level summary that's plenty; detail pane can show
  // hunk-accurate stats via `computeHunks` if the user wants to drill in.
  const added = Math.max(0, propLines.length - baseLines.length)
  const removed = Math.max(0, baseLines.length - propLines.length)
  return { added, removed }
}

/** Canonical state labels + UI colour tokens. */
export const STATE_META: Record<RendererDtState, { label: string; color: string }> = {
  Pending: { label: 'Pending', color: '#f59e0b' },
  Approved: { label: 'Approved', color: '#38bdf8' },
  Writing: { label: 'Writing', color: '#3b82f6' },
  Applied: { label: 'Applied', color: '#22c55e' },
  Rejected: { label: 'Rejected', color: '#94a3b8' },
  Failed: { label: 'Failed', color: '#ef4444' },
  Stale: { label: 'Stale', color: '#a855f7' },
}
