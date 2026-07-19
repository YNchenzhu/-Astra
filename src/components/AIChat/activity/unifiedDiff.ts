/**
 * Line-level unified diff for the IDE-style single-card view.
 *
 * The algorithm is the same prefix/suffix shrink that powers the
 * legacy `buildUnifiedDiffLines` in `ToolUseCard.tsx`, restated here
 * as a structured output so the renderer can attach per-line Monaco
 * tokenization HTML, +/-/context badges, and a streaming caret on
 * the last `added` line without re-parsing string markers.
 *
 * Trade-off vs a full LCS / Myers diff:
 *   - LLM Edit calls almost always touch ONE contiguous span (the
 *     `oldString` → `newString` semantics force this — a single
 *     `Edit` tool call replaces exactly one occurrence of the old
 *     text). For that pattern the shrink algorithm produces the
 *     identical output as an LCS, with O(N+M) work instead of O(N*M).
 *   - For pathological inputs (interleaved keep/change) the shrink
 *     collapses them into one big change block. Acceptable — the
 *     fallback is still readable as "everything here changed".
 *
 * Output indices: each entry carries the source-array index (oldIdx
 * for context/removed, newIdx for context/added) so the renderer can
 * look up per-line Monaco-colorized HTML from arrays produced by
 * splitting `monaco.editor.colorize(text)` on `<br/>`.
 */

export type DiffLine =
  | {
      kind: 'context'
      text: string
      /** Index in `oldText.split('\\n')`. */
      oldIdx: number
      /** Index in `newText.split('\\n')`. */
      newIdx: number
    }
  | {
      kind: 'removed'
      text: string
      oldIdx: number
    }
  | {
      kind: 'added'
      text: string
      newIdx: number
    }

/**
 * @param contextLines How many unchanged lines to show above + below
 *   the changed region. 2 mirrors `git diff -U2`, sufficient to
 *   anchor edits visually without expanding the card vertically.
 *   For empty old/new or all-changed cases the function returns
 *   just the +/- lines (no context to show).
 */
export function computeUnifiedDiff(
  oldText: string,
  newText: string,
  contextLines: number = 2,
): DiffLine[] {
  // Normalise: treat empty strings as "no lines" (not [""]). Without
  // this, an edit that adds N lines to a fresh file would emit one
  // spurious `removed` entry for the empty string.
  const oldLines = oldText.length === 0 ? [] : oldText.split('\n')
  const newLines = newText.length === 0 ? [] : newText.split('\n')

  // Identical inputs: emit pure context (capped). Mostly happens
  // during a same-content edit (rare; LLMs sometimes re-emit the
  // same code wholesale).
  if (oldText === newText) {
    const out: DiffLine[] = []
    const limit = Math.min(oldLines.length, contextLines * 2 + 2)
    for (let i = 0; i < limit; i++) {
      out.push({ kind: 'context', text: oldLines[i], oldIdx: i, newIdx: i })
    }
    return out
  }

  // Shared prefix length.
  let pre = 0
  while (
    pre < oldLines.length &&
    pre < newLines.length &&
    oldLines[pre] === newLines[pre]
  ) {
    pre++
  }

  // Shared suffix length, bounded by what prefix already claimed.
  let suf = 0
  while (
    suf < oldLines.length - pre &&
    suf < newLines.length - pre &&
    oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
  ) {
    suf++
  }

  const out: DiffLine[] = []

  // Context before the change.
  const ctxStart = Math.max(0, pre - contextLines)
  for (let i = ctxStart; i < pre; i++) {
    out.push({ kind: 'context', text: oldLines[i], oldIdx: i, newIdx: i })
  }

  // Removed lines (in oldText only).
  for (let i = pre; i < oldLines.length - suf; i++) {
    out.push({ kind: 'removed', text: oldLines[i], oldIdx: i })
  }

  // Added lines (in newText only). Streaming attaches the caret on
  // the last `added` entry — caller decides whether to do that based
  // on whether more deltas are still expected.
  const addedEnd = newLines.length - suf
  for (let i = pre; i < addedEnd; i++) {
    out.push({ kind: 'added', text: newLines[i], newIdx: i })
  }

  // Context after the change.
  const ctxAfterOldStart = oldLines.length - suf
  const ctxAfterOldEnd = Math.min(oldLines.length, ctxAfterOldStart + contextLines)
  const ctxAfterNewStart = newLines.length - suf
  for (let k = 0; k < ctxAfterOldEnd - ctxAfterOldStart; k++) {
    out.push({
      kind: 'context',
      text: oldLines[ctxAfterOldStart + k],
      oldIdx: ctxAfterOldStart + k,
      newIdx: ctxAfterNewStart + k,
    })
  }

  return out
}

/**
 * Find the index of the last `added` entry in a diff. Used by the
 * renderer to know which line should carry the streaming caret. -1
 * when the diff has no `added` entries (e.g. pure removal).
 */
export function indexOfLastAdded(diff: DiffLine[]): number {
  for (let i = diff.length - 1; i >= 0; i--) {
    if (diff[i].kind === 'added') return i
  }
  return -1
}
