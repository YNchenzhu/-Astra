// Shared diff computation engine used by all three Diff modes.
//
// As of the "unify inline-UI with P4a engine" refactor, the public API (`computeDiff`,
// `computeLineDiff`, `groupIntoHunks`, `computeCharDiff`, `MAX_DIFF_COMBINED_LINES`) is
// preserved for backward compatibility, but the primary path (`computeDiff`) now
// delegates to the P4a Myers-based engine in `electron/diff/hunkSelection`. This gives
// the renderer-side diff the same CRLF/BOM correctness, stable hunk ids, and line-count
// performance profile that the DiffTransaction subsystem already enjoys.
//
// Consumers that pull `computeLineDiff` / `groupIntoHunks` as building blocks still get
// the original LCS implementation (kept below for reference + zero regression surface),
// but nobody inside the repo currently does — verified via grep at migration time.

import type { DiffLine, DiffOp, DiffHunk, DiffResult, DiffStats, CharRange } from './DiffModel'
import {
  applyAcceptedHunks as p4aApplyAcceptedHunks,
  computeHunks as p4aComputeHunks,
  type Hunk as P4aHunk,
  type HunkDiff as P4aHunkDiff,
} from '../../../electron/diff/hunkSelection'

/** Same budget as InlineDiffController: LCS is O(m×n) on the core region — cap combined line count. */
export const MAX_DIFF_COMBINED_LINES = 16_000

const EMPTY_DIFF_RESULT: DiffResult = {
  diffLines: [],
  hunks: [],
  stats: { added: 0, removed: 0, hunks: 0 },
}

// ── Line-level diff (LCS with prefix/suffix optimization) ──────

export function computeLineDiff(orig: string[], mod: string[]): DiffLine[] {
  let prefixLen = 0
  const minLen = Math.min(orig.length, mod.length)
  while (prefixLen < minLen && orig[prefixLen] === mod[prefixLen]) {
    prefixLen++
  }

  let suffixLen = 0
  while (
    suffixLen < minLen - prefixLen &&
    orig[orig.length - 1 - suffixLen] === mod[mod.length - 1 - suffixLen]
  ) {
    suffixLen++
  }

  const origCore = orig.slice(prefixLen, orig.length - suffixLen)
  const modCore = mod.slice(prefixLen, mod.length - suffixLen)
  const coreResult = lcsLineDiff(origCore, modCore)

  const result: DiffLine[] = []
  for (let i = 0; i < prefixLen; i++) {
    result.push({ op: 'equal', text: orig[i] })
  }
  result.push(...coreResult)
  for (let i = orig.length - suffixLen; i < orig.length; i++) {
    result.push({ op: 'equal', text: orig[i] })
  }
  return result
}

function lcsLineDiff(orig: string[], mod: string[]): DiffLine[] {
  const m = orig.length
  const n = mod.length

  if (m === 0) return mod.map((t) => ({ op: 'add' as DiffOp, text: t }))
  if (n === 0) return orig.map((t) => ({ op: 'delete' as DiffOp, text: t }))

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from<number>({ length: n + 1 }).fill(0),
  )
  for (let ii = 1; ii <= m; ii++) {
    for (let jj = 1; jj <= n; jj++) {
      if (orig[ii - 1] === mod[jj - 1]) {
        dp[ii][jj] = dp[ii - 1][jj - 1] + 1
      } else {
        dp[ii][jj] = Math.max(dp[ii - 1][jj], dp[ii][jj - 1])
      }
    }
  }

  const result: DiffLine[] = []
  let i = m
  let j = n

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && orig[i - 1] === mod[j - 1]) {
      result.push({ op: 'equal', text: orig[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ op: 'add', text: mod[j - 1] })
      j--
    } else {
      result.push({ op: 'delete', text: orig[i - 1] })
      i--
    }
  }

  result.reverse()
  return result
}

// ── Character-level diff for highlighting within lines ──────

export function computeCharDiff(
  oldLine: string,
  newLine: string,
): { oldRanges: CharRange[]; newRanges: CharRange[] } {
  let prefixLen = 0
  const minLen = Math.min(oldLine.length, newLine.length)
  while (prefixLen < minLen && oldLine[prefixLen] === newLine[prefixLen]) {
    prefixLen++
  }

  let suffixLen = 0
  while (
    suffixLen < minLen - prefixLen &&
    oldLine[oldLine.length - 1 - suffixLen] === newLine[newLine.length - 1 - suffixLen]
  ) {
    suffixLen++
  }

  const oldMid = oldLine.length - prefixLen - suffixLen
  const newMid = newLine.length - prefixLen - suffixLen

  const oldRanges: CharRange[] = []
  const newRanges: CharRange[] = []

  if (oldMid > 0) {
    oldRanges.push({ startCol: prefixLen + 1, endCol: prefixLen + oldMid + 1 })
  }
  if (newMid > 0) {
    newRanges.push({ startCol: prefixLen + 1, endCol: prefixLen + newMid + 1 })
  }

  return { oldRanges, newRanges }
}

// ── Hunk grouping ──────────────────────────────────────────

export function groupIntoHunks(diffLines: DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let origLine = 0
  let modLine = 0
  let index = 0

  while (index < diffLines.length) {
    if (diffLines[index].op === 'equal') {
      origLine++
      modLine++
      index++
      continue
    }

    const hunkOrigStart = origLine
    const hunkModStart = modLine
    const originalLines: string[] = []
    const modifiedLines: string[] = []

    while (index < diffLines.length && diffLines[index].op !== 'equal') {
      const op = diffLines[index]
      if (op.op === 'delete') {
        originalLines.push(op.text)
        origLine++
      } else if (op.op === 'add') {
        modifiedLines.push(op.text)
        modLine++
      }
      index++
    }

    const hasDelete = originalLines.length > 0
    const hasAdd = modifiedLines.length > 0
    const type: DiffHunk['type'] = hasDelete && hasAdd ? 'modify' : hasAdd ? 'add' : 'delete'

    hunks.push({
      id: `hunk-${hunks.length}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      origStartLine: hunkOrigStart,
      origEndLine: hunkOrigStart + originalLines.length,
      modStartLine: hunkModStart,
      modEndLine: hunkModStart + modifiedLines.length,
      type,
      originalLines,
      modifiedLines,
    })
  }

  return hunks
}

// ── High-level API: compute full DiffResult from two strings ──
//
// Implementation note: delegates to the P4a engine for the actual diff computation,
// then converts the result into the services/diff public shape. `diffLines` is
// synthesised from (baseLines + hunks) so `ComposerPanel`'s line-by-line renderer
// (the only consumer of `diffLines`) keeps working unchanged.

export function computeDiff(original: string, modified: string): DiffResult {
  // Preserve the legacy budget check — Myers is faster than LCS but we still cap to
  // avoid pathological inputs (e.g. megabyte JSON files that users wouldn't diff-review
  // anyway). Use split('\n') for the line-count estimate to keep behaviour identical
  // to the pre-refactor version.
  const origLineCountForBudget = original === '' ? 0 : original.split('\n').length
  const modLineCountForBudget = modified === '' ? 0 : modified.split('\n').length
  if (origLineCountForBudget + modLineCountForBudget > MAX_DIFF_COMBINED_LINES) {
    return EMPTY_DIFF_RESULT
  }
  const hunkDiff = p4aComputeHunks(original, modified)
  return hunkDiffToDiffResult(hunkDiff, original, modified)
}

// ── Internal: P4a HunkDiff → services/diff DiffResult ──────

/**
 * Convert P4a's 1-based-inclusive hunk ranges into the 0-based-inclusive-start,
 * 0-based-exclusive-end shape the rest of the app uses. Type is derived from
 * `removedLines` / `addedLines` lengths.
 *
 * Pure-insertion / pure-deletion hunks collapse to a zero-length range on the opposite
 * side, anchored at `baseStartLine - 1` (insertion) or `modifiedStartLine - 1`
 * (deletion). This matches the representation the old LCS path produced.
 */
function p4aHunkToServicesHunk(h: P4aHunk): DiffHunk {
  const isInsert = h.removedLines.length === 0
  const isDelete = h.addedLines.length === 0
  const type: DiffHunk['type'] = isInsert ? 'add' : isDelete ? 'delete' : 'modify'
  // baseStartLine (1-based inclusive) → origStartLine (0-based inclusive start)
  const origStart = h.baseStartLine - 1
  // baseEndLine (1-based inclusive) → origEndLine (0-based exclusive end).
  // Pure inserts encode baseEndLine = baseStartLine - 1 in P4a, so both ends collapse.
  const origEnd = isInsert ? origStart : h.baseEndLine
  const modStart = h.modifiedStartLine - 1
  const modEnd = isDelete ? modStart : h.modifiedEndLine
  return {
    id: h.id,
    origStartLine: origStart,
    origEndLine: origEnd,
    modStartLine: modStart,
    modEndLine: modEnd,
    type,
    originalLines: [...h.removedLines],
    modifiedLines: [...h.addedLines],
  }
}

/**
 * Synthesise the flat `DiffLine[]` (equal/add/delete in source order) that
 * `ComposerPanel` uses for its line-level rendering. We walk the base lines and emit
 * an `equal` op per unchanged line, inserting each hunk's add/delete block at its
 * anchor.
 *
 * Tail-empty-line parity: the pre-refactor implementation used `split('\n')` which
 * yields a trailing `''` for files ending in a newline. P4a strips that empty tail and
 * records it as `hasTrailingNewline`. To keep ComposerPanel rendering identical we
 * append a single `equal ''` line when BOTH sides had trailing newlines and the
 * existing synthesis hasn't already emitted one for that anchor.
 */
function synthesiseDiffLines(
  hunkDiff: P4aHunkDiff,
  original: string,
  modified: string,
): DiffLine[] {
  const baseLines = hunkDiff.baseLines
  const hunksByBaseStart1Based = new Map<number, P4aHunk[]>()
  for (const h of hunkDiff.hunks) {
    const k = h.baseStartLine
    const arr = hunksByBaseStart1Based.get(k)
    if (arr) arr.push(h)
    else hunksByBaseStart1Based.set(k, [h])
  }

  const result: DiffLine[] = []
  let i = 0 // 0-based index into baseLines

  // Pure-insertion hunks that anchor BEFORE line 1 (baseStartLine = 1, baseEndLine = 0).
  // Emit their adds before we start walking baseLines so the order matches LCS output.
  const preludeHunks = (hunksByBaseStart1Based.get(1) ?? []).filter((h) => h.removedLines.length === 0)
  for (const h of preludeHunks) {
    for (const l of h.addedLines) result.push({ op: 'add', text: l })
  }

  while (i < baseLines.length) {
    const line1 = i + 1 // 1-based
    const candidates = hunksByBaseStart1Based.get(line1) ?? []
    // Hunks that ACTUALLY cover this line (not the pure-insertion-at-start handled above).
    const realHunk = candidates.find((h) => h.removedLines.length > 0 && h.baseStartLine === line1)
    const insertionHere = candidates.find(
      (h) => h.removedLines.length === 0 && h.baseStartLine === line1 && line1 > 1,
    )

    if (insertionHere) {
      for (const l of insertionHere.addedLines) result.push({ op: 'add', text: l })
    }

    if (realHunk) {
      for (const rem of realHunk.removedLines) result.push({ op: 'delete', text: rem })
      for (const add of realHunk.addedLines) result.push({ op: 'add', text: add })
      // Skip the removed range in base (baseEndLine is 1-based inclusive).
      i = realHunk.baseEndLine
      continue
    }

    result.push({ op: 'equal', text: baseLines[i] })
    i++
  }

  // Tail-appended pure-insertion hunks (baseStartLine = baseLines.length + 1).
  const tailAnchor = baseLines.length + 1
  for (const h of hunksByBaseStart1Based.get(tailAnchor) ?? []) {
    if (h.removedLines.length === 0) {
      for (const l of h.addedLines) result.push({ op: 'add', text: l })
    }
  }

  // Tail-newline parity: old LCS saw `"a\n".split('\n')` = `['a', '']` and thus could
  // emit a trailing `{op:'equal', text:''}`. Recreate that for files where both sides
  // end with a newline, to keep ComposerPanel's rendering identical byte-for-byte.
  const origEndsWithNl = original.endsWith('\n') || original.endsWith('\r\n') || original.endsWith('\r')
  const modEndsWithNl = modified.endsWith('\n') || modified.endsWith('\r\n') || modified.endsWith('\r')
  if (origEndsWithNl && modEndsWithNl && original !== '' && modified !== '') {
    result.push({ op: 'equal', text: '' })
  } else if (origEndsWithNl && !modEndsWithNl && original !== '') {
    // Old LCS would have emitted {delete, ''} for the stray empty tail in origin.
    result.push({ op: 'delete', text: '' })
  } else if (!origEndsWithNl && modEndsWithNl && modified !== '') {
    result.push({ op: 'add', text: '' })
  }

  return result
}

function hunkDiffToDiffResult(
  hunkDiff: P4aHunkDiff,
  original: string,
  modified: string,
): DiffResult {
  const hunks = hunkDiff.hunks.map(p4aHunkToServicesHunk)
  const diffLines = synthesiseDiffLines(hunkDiff, original, modified)
  const stats: DiffStats = { added: 0, removed: 0, hunks: hunks.length }
  for (const h of hunks) {
    stats.added += h.modifiedLines.length
    stats.removed += h.originalLines.length
  }
  return { diffLines, hunks, stats }
}

// ── Re-export the P4a composer so callers that want to apply a subset of hunks don't
// need to reach across the electron/ boundary themselves ─────────────────────────

/**
 * Given the hunks produced by {@link computeDiff} and a set of accepted ids, return
 * the resulting content. Powered by the P4a engine — CRLF/BOM/trailing-newline safe.
 */
export function applyAcceptedHunks(
  original: string,
  modified: string,
  acceptedHunkIds: ReadonlySet<string>,
): string {
  const diff = p4aComputeHunks(original, modified)
  return p4aApplyAcceptedHunks(diff, new Set(acceptedHunkIds))
}
