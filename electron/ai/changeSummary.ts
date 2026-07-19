/**
 * Change-summary helpers — a compact, durable "what changed" breadcrumb for
 * file mutations (edit_file / multi_edit_file / write_file).
 *
 * ## Why this exists (long-run edit-memory fix, 2026-07)
 *
 * A mutation tool_result only says `Edited <path> (N bytes)` — it carries NO
 * diff. Once micro-compact / the tool-result budget truncates that block a few
 * iterations later, the model loses even the little it had and cannot tell what
 * it changed in an earlier loop. This module produces a ONE-LINE summary
 * (`+A/-R lines, N hunk(s) @ L120, L340`) that is:
 *   1. Appended to the mutation tool_result as a `[change-summary: …]` marker.
 *   2. Preserved verbatim by the truncation layers (see
 *      `toolResultBudget.extractEditNextHint`, which greps this marker) so the
 *      breadcrumb survives even after the body is compacted away.
 *
 * `buildSimpleDiff` lives here (moved out of `toolWriteFile.ts`) so both the
 * mutation tools AND the post-compact `<modified-files>` attachment can share a
 * single diff implementation without an `ai ↔ context` import cycle.
 */

export interface SimpleDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/**
 * Build a simple line-based diff patch (structuredPatch) from old and new content.
 * Returns an array of hunk-like objects: { oldStart, oldLines, newStart, newLines, lines }
 * where lines are prefixed with '+' (added), '-' (removed), or ' ' (unchanged).
 * This is a lightweight LCS-based diff without external dependencies.
 */
export function buildSimpleDiff(oldContent: string, newContent: string): SimpleDiffHunk[] {
  const oldLines = oldContent.split(/\r?\n/)
  const newLines = newContent.split(/\r?\n/)

  // Simple LCS-based diff
  const m = oldLines.length
  const n = newLines.length
  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to get diff ops
  const ops: Array<{ type: 'equal' | 'add' | 'remove'; oldLine?: string; newLine?: string }> = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'equal', oldLine: oldLines[i - 1] })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'add', newLine: newLines[j - 1] })
      j--
    } else {
      ops.push({ type: 'remove', oldLine: oldLines[i - 1] })
      i--
    }
  }
  ops.reverse()

  // Group into hunks with context (3 lines)
  const contextSize = 3
  // First pass: mark change regions
  const changes: boolean[] = ops.map(op => op.type !== 'equal')
  // Find hunk boundaries
  const hunks: SimpleDiffHunk[] = []
  let idx = 0
  while (idx < ops.length) {
    if (!changes[idx]) { idx++; continue }
    // Find start of this hunk (with context)
    const hStart = Math.max(0, idx - contextSize)
    // Find end of this hunk (with context)
    let hEnd = idx
    while (hEnd < ops.length && hEnd - idx < contextSize) hEnd++
    // Actually expand to next change + context
    let scanEnd = idx
    while (scanEnd < ops.length && changes[scanEnd]) scanEnd++
    hEnd = Math.min(ops.length, scanEnd + contextSize)

    // Build hunk lines
    const lines: string[] = []
    let oldPos = 0, newPos = 0
    for (let k = 0; k < hStart; k++) {
      if (ops[k].type === 'equal' || ops[k].type === 'remove') oldPos++
      if (ops[k].type === 'equal' || ops[k].type === 'add') newPos++
    }
    const oldStart = oldPos + 1
    const newStart = newPos + 1

    for (let k = hStart; k < hEnd; k++) {
      const op = ops[k]
      if (op.type === 'equal') {
        lines.push(' ' + (op.oldLine ?? ''))
        oldPos++; newPos++
      } else if (op.type === 'remove') {
        lines.push('-' + (op.oldLine ?? ''))
        oldPos++
      } else {
        lines.push('+' + (op.newLine ?? ''))
        newPos++
      }
    }

    hunks.push({ oldStart, oldLines: oldPos - oldStart + 1, newStart, newLines: newPos - newStart + 1, lines })
    idx = hEnd
  }

  return hunks
}

/** How many hunk anchors to name before collapsing the rest into "+K more". */
const MAX_NAMED_ANCHORS = 3

/**
 * Render hunks into a single-line summary like
 * `+8/-3 lines, 2 hunk(s) @ L120, L340`. Returns '' when there is no net
 * line-level change (e.g. a whitespace-only or no-op edit).
 */
export function formatHunksAsChangeSummary(hunks: ReadonlyArray<SimpleDiffHunk>): string {
  if (!hunks || hunks.length === 0) return ''
  let added = 0
  let removed = 0
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  if (added === 0 && removed === 0) return ''
  const anchors = hunks.slice(0, MAX_NAMED_ANCHORS).map((h) => `L${h.newStart}`).join(', ')
  const more = hunks.length > MAX_NAMED_ANCHORS ? `, +${hunks.length - MAX_NAMED_ANCHORS} more` : ''
  return `+${added}/-${removed} lines, ${hunks.length} hunk(s) @ ${anchors}${more}`
}

/**
 * Above this line count on either side we skip the exact LCS diff. `buildSimpleDiff`
 * is O(oldLines × newLines) in BOTH time and memory (the dp table), so a large
 * file would spike memory on every edit. The summary is a breadcrumb, so for big
 * files we degrade to a cheap net-line delta instead. Tunable via env.
 */
const MAX_DIFF_LINES = Math.max(
  200,
  Number(process.env.POLE_CHANGE_SUMMARY_MAX_LINES ?? '2500'),
)

/** Count '\n' occurrences without allocating a split array. */
function countNewlines(s: string): number {
  let count = 0
  let idx = s.indexOf('\n')
  while (idx !== -1) {
    count++
    idx = s.indexOf('\n', idx + 1)
  }
  return count
}

/** Diff two contents and render the one-line summary. '' when nothing changed. */
export function summarizeContentChange(oldContent: string, newContent: string): string {
  if (oldContent === newContent) return ''
  const oldLineCount = countNewlines(oldContent) + 1
  const newLineCount = countNewlines(newContent) + 1
  // Guard the quadratic LCS: for large files fall back to a net-line delta.
  if (oldLineCount > MAX_DIFF_LINES || newLineCount > MAX_DIFF_LINES) {
    const delta = newLineCount - oldLineCount
    const sign = delta >= 0 ? `+${delta}` : `${delta}`
    return `~${sign} net lines (large file, exact diff skipped)`
  }
  return formatHunksAsChangeSummary(buildSimpleDiff(oldContent, newContent))
}

/**
 * The stable, greppable marker appended to mutation tool_results. Kept in ONE
 * place so the producer (mutation tools) and the preservers (truncation layers)
 * never drift. Capture group 1 is the inner summary text.
 */
export const CHANGE_SUMMARY_MARKER_RE = /\[change-summary:\s*([^\]]+)\]/

/** Build the `\n[change-summary: …]` trailer from a precomputed diff. '' when empty. */
export function buildChangeSummaryTrailerFromHunks(hunks: ReadonlyArray<SimpleDiffHunk>): string {
  const summary = formatHunksAsChangeSummary(hunks)
  return summary ? `\n[change-summary: ${summary}]` : ''
}

/** Build the `\n[change-summary: …]` trailer by diffing old vs new content. */
export function buildChangeSummaryTrailer(oldContent: string, newContent: string): string {
  const summary = summarizeContentChange(oldContent, newContent)
  return summary ? `\n[change-summary: ${summary}]` : ''
}
