/**
 * Adapter from the P4a hunk engine (`electron/diff/hunkSelection`) to the shape the
 * existing `InlineDiffDecorator` uses for Monaco view zones.
 *
 * Why an adapter instead of rewriting the decorator's data model:
 *   • The view-zone rendering code (~200 lines of DOM + Monaco glue) uses 0-based
 *     line offsets and exclusive end indices. P4a uses 1-based inclusive ranges.
 *     Converting once at the edge lets the renderer stay untouched.
 *   • `type: 'add' | 'delete' | 'modify'` is used to pick between the three rendering
 *     branches. We classify here from (removedLines, addedLines) lengths.
 *   • Hunk ids are stable across re-applies because P4a uses `hunk-0`, `hunk-1`, ...
 *     sequentially. The old inline LCS used `hunk-<n>-<Date.now()>` which meant any
 *     re-apply lost all user-level accept/reject bookkeeping.
 *
 * Kept as a separate file so unit tests can drive it without Monaco in the loop.
 */

// Re-exports from the engine. We bring `computeHunks` and `applyAcceptedHunks` through
// so the decorator has a single import (`from './decoratorHunkAdapter'`) regardless of
// where the underlying module actually lives.
export { applyAcceptedHunks, computeHunks } from '../../../electron/diff/hunkSelection'
export type { Hunk, HunkDiff } from '../../../electron/diff/hunkSelection'

import type { HunkDiff } from '../../../electron/diff/hunkSelection'

/**
 * Shape the decorator's view-zone renderer already uses. We keep it identical to the
 * original inline definition so the 200-line renderer below it doesn't need to change.
 */
export interface DecoratorHunk {
  id: string
  /** 0-indexed start line in ORIGINAL content (inclusive). */
  origStartLine: number
  /** 0-indexed end line in ORIGINAL content (exclusive). */
  origEndLine: number
  /** 0-indexed start line in MODIFIED content (inclusive). */
  modStartLine: number
  /** 0-indexed end line in MODIFIED content (exclusive). */
  modEndLine: number
  type: 'add' | 'delete' | 'modify'
  originalLines: string[]
  modifiedLines: string[]
}

/**
 * Convert P4a's 1-based-inclusive range into 0-based-exclusive-end that the decorator
 * uses. Edge cases:
 *   • Pure insertion (removedLines.length === 0): P4a encodes the anchor as
 *     `baseEndLine = baseStartLine - 1`. Decorator wants a zero-length range, so both
 *     ends sit at `baseStartLine - 1`.
 *   • Pure deletion: mirror on the modified side.
 */
export function p4aHunksToDecoratorHunks(diff: HunkDiff): DecoratorHunk[] {
  const out: DecoratorHunk[] = []
  for (const h of diff.hunks) {
    const isInsert = h.removedLines.length === 0
    const isDelete = h.addedLines.length === 0
    const type: DecoratorHunk['type'] = isInsert ? 'add' : isDelete ? 'delete' : 'modify'

    const origStartLine = isInsert ? h.baseStartLine - 1 : h.baseStartLine - 1
    const origEndLine = isInsert ? h.baseStartLine - 1 : h.baseEndLine
    const modStartLine = isDelete ? h.modifiedStartLine - 1 : h.modifiedStartLine - 1
    const modEndLine = isDelete ? h.modifiedStartLine - 1 : h.modifiedEndLine

    out.push({
      id: h.id,
      origStartLine,
      origEndLine,
      modStartLine,
      modEndLine,
      type,
      originalLines: [...h.removedLines],
      modifiedLines: [...h.addedLines],
    })
  }
  return out
}

/**
 * Compute added / removed line totals across the whole diff. Used by the toolbar to
 * render "+N / −M" stats. Kept as a tiny pure helper for test visibility.
 */
export function hunkStats(diff: HunkDiff): { added: number; removed: number; hunks: number } {
  let added = 0
  let removed = 0
  for (const h of diff.hunks) {
    added += h.addedLines.length
    removed += h.removedLines.length
  }
  return { added, removed, hunks: diff.hunks.length }
}
