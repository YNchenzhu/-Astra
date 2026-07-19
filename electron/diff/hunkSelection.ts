/**
 * Per-hunk approval engine (P4a).
 *
 * Turns a (baseContent, proposedContent) pair into a sequence of independent hunks and
 * lets callers cherry-pick which ones to apply. Pure functions — no I/O, no DT store
 * coupling — so the same engine powers:
 *   • InlineDiff's hunk toolbar ("accept this hunk, skip that one")
 *   • The Rebase preview ("apply my accepted hunks onto current disk")
 *   • The Applied-audit replay ("show me exactly which hunks landed")
 *
 * Design notes:
 *   • We emit **line-based** hunks with surrounding unchanged context lines. Character-
 *     level hunks would be technically more precise but useless for a user who wants to
 *     read the change. Line granularity also plays well with Monaco's inline decoration.
 *   • The diff algorithm is a classic Myers O(ND) LCS traversal implemented locally.
 *     We don't depend on `diff` npm package here to keep the main-process footprint
 *     small and to avoid its "change" callback shape which would force extra adapters.
 *   • Hunks are **non-overlapping** and **ordered by original line number**. This is the
 *     invariant that makes cherry-picking sound: applying a subset of hunks to `base`
 *     in order always produces a valid, unambiguous content.
 *   • `applyAcceptedHunks` preserves the original line endings of the base content — if
 *     the base used CRLF we stitch CRLF back in between segments. Needed because the
 *     diff stage works on line arrays stripped of their terminators.
 */

export interface Hunk {
  /** Stable id per computeHunks() call. Used by UI as React key and by apply() for selection. */
  id: string
  /** 1-based inclusive line range in the BASE content that this hunk replaces. */
  baseStartLine: number
  baseEndLine: number
  /** 1-based inclusive line range in the MODIFIED content that this hunk produces. */
  modifiedStartLine: number
  modifiedEndLine: number
  /** Lines removed from the base (length may be 0 for pure insertions). */
  removedLines: string[]
  /** Lines inserted in the modified (length may be 0 for pure deletions). */
  addedLines: string[]
  /** Context lines (unchanged) immediately BEFORE the change. For UI display only. */
  leadingContext: string[]
  /** Context lines immediately AFTER the change. For UI display only. */
  trailingContext: string[]
}

export interface HunkDiff {
  hunks: Hunk[]
  /** The base content split into lines (cached so apply() doesn't re-split). */
  baseLines: string[]
  /** Line terminator of the base content: '\n', '\r\n', or '\r' (inferred). */
  baseLineEnding: string
  /** True if the base content ended with a trailing line terminator. */
  baseHasTrailingNewline: boolean
}

/** How many surrounding unchanged lines to include as context per hunk (per side). */
const DEFAULT_CONTEXT_LINES = 3

/**
 * Infer the dominant line ending style of a blob. Rough heuristic: count occurrences of
 * each terminator and pick the most common; tie-break in favour of LF which is the
 * safer default for new content.
 */
function detectLineEnding(content: string): string {
  const crlf = (content.match(/\r\n/g) ?? []).length
  const cr = (content.match(/\r(?!\n)/g) ?? []).length
  const lf = (content.match(/(?<!\r)\n/g) ?? []).length
  // Strict majority rules — ties fall through to LF below. This matters for tiny or
  // empty blobs where a 0-0-0 count would otherwise mis-round to CRLF.
  if (crlf > 0 && crlf >= lf && crlf >= cr) return '\r\n'
  if (cr > 0 && cr > lf) return '\r'
  return '\n'
}

/**
 * Split into lines WITHOUT their terminators, and remember whether the last line carried
 * a trailing newline. Needed because `split` loses that info (an empty trailing line
 * would otherwise round-trip as an extra blank line).
 */
function splitLines(content: string): { lines: string[]; hasTrailingNewline: boolean } {
  if (content === '') return { lines: [], hasTrailingNewline: false }
  const hasTrailingNewline = /\r?\n$/.test(content) || content.endsWith('\r')
  // Normalise all newline variants for splitting, but remember the original for rejoining.
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const parts = normalized.split('\n')
  // When content ends with \n, split() produces a trailing '' — drop it and encode via hasTrailingNewline.
  if (hasTrailingNewline && parts[parts.length - 1] === '') parts.pop()
  return { lines: parts, hasTrailingNewline }
}

/**
 * Classic Myers diff — produces the edit script as a sequence of "equal | insert | delete"
 * operations over line arrays. Returns ops in order.
 *
 * Complexity: O((N+M)·D) where D is the edit distance. For typical AI edits D ≪ N+M.
 */
type DiffOp =
  | { type: 'equal'; aIndex: number; bIndex: number }
  | { type: 'delete'; aIndex: number }
  | { type: 'insert'; bIndex: number }

function myersDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []

  // trace[d] stores v-array snapshot at edit distance d for backtracking.
  const trace: Map<number, number>[] = []
  const v = new Map<number, number>()
  v.set(1, 0)

  let foundD = -1
  outer: for (let d = 0; d <= max; d++) {
    const vClone = new Map(v)
    trace.push(vClone)
    for (let k = -d; k <= d; k += 2) {
      let x: number
      const down = v.get(k - 1) ?? -1
      const up = v.get(k + 1) ?? -1
      if (k === -d || (k !== d && down < up)) {
        x = up
      } else {
        x = down + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v.set(k, x)
      if (x >= n && y >= m) {
        foundD = d
        break outer
      }
    }
  }

  // Backtrack.
  const ops: DiffOp[] = []
  let x = n
  let y = m
  for (let d = foundD; d > 0; d--) {
    const vPrev = trace[d]!
    const k = x - y
    const down = vPrev.get(k - 1) ?? -1
    const up = vPrev.get(k + 1) ?? -1
    let kPrev: number
    if (k === -d || (k !== d && down < up)) {
      kPrev = k + 1
    } else {
      kPrev = k - 1
    }
    const xPrev = vPrev.get(kPrev) ?? 0
    const yPrev = xPrev - kPrev
    while (x > xPrev && y > yPrev) {
      ops.push({ type: 'equal', aIndex: x - 1, bIndex: y - 1 })
      x--
      y--
    }
    if (d > 0) {
      if (x === xPrev) {
        ops.push({ type: 'insert', bIndex: y - 1 })
        y--
      } else {
        ops.push({ type: 'delete', aIndex: x - 1 })
        x--
      }
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: 'equal', aIndex: x - 1, bIndex: y - 1 })
    x--
    y--
  }
  while (x > 0) {
    ops.push({ type: 'delete', aIndex: x - 1 })
    x--
  }
  while (y > 0) {
    ops.push({ type: 'insert', bIndex: y - 1 })
    y--
  }
  ops.reverse()
  return ops
}

/**
 * Convert the flat op list into merged hunks. Consecutive non-equal ops collapse into
 * one hunk; equal ops become context (trimmed to DEFAULT_CONTEXT_LINES per side).
 */
function opsToHunks(
  ops: DiffOp[],
  baseLines: string[],
  modifiedLines: string[],
  contextLines: number,
): Hunk[] {
  const hunks: Hunk[] = []
  let hunkIdCounter = 0

  let i = 0
  while (i < ops.length) {
    // Skip equal runs.
    while (i < ops.length && ops[i]!.type === 'equal') i++
    if (i >= ops.length) break

    // Collect a run of non-equal ops.
    const changeStart = i
    while (i < ops.length && ops[i]!.type !== 'equal') i++
    const changeEnd = i // exclusive

    const removedLines: string[] = []
    const addedLines: string[] = []
    let baseStartIdx = -1
    let baseEndIdx = -1
    let modStartIdx = -1
    let modEndIdx = -1

    for (let j = changeStart; j < changeEnd; j++) {
      const op = ops[j]!
      if (op.type === 'delete') {
        removedLines.push(baseLines[op.aIndex]!)
        if (baseStartIdx === -1) baseStartIdx = op.aIndex
        baseEndIdx = op.aIndex
      } else if (op.type === 'insert') {
        addedLines.push(modifiedLines[op.bIndex]!)
        if (modStartIdx === -1) modStartIdx = op.bIndex
        modEndIdx = op.bIndex
      }
    }

    // Normalise: pure insertion anchors at the position where it happens in the base.
    // We map that to the line just before (baseEndIdx points to "line before the insert"
    // in terms of unchanged anchor). Easier: use the equal op just before or after as anchor.
    if (removedLines.length === 0) {
      // Pure insertion — find anchor via neighbouring equal op.
      const before = changeStart > 0 ? ops[changeStart - 1] : undefined
      const after = changeEnd < ops.length ? ops[changeEnd] : undefined
      if (before && before.type === 'equal') {
        baseStartIdx = before.aIndex + 1
        baseEndIdx = before.aIndex // end < start → empty range in base
      } else if (after && after.type === 'equal') {
        baseStartIdx = after.aIndex
        baseEndIdx = after.aIndex - 1 // end < start → empty range in base
      } else {
        // Insertion at start of a file whose base is empty.
        baseStartIdx = 0
        baseEndIdx = -1
      }
    }
    if (addedLines.length === 0) {
      // Pure deletion — anchor in modified via neighbouring equal op.
      const before = changeStart > 0 ? ops[changeStart - 1] : undefined
      const after = changeEnd < ops.length ? ops[changeEnd] : undefined
      if (before && before.type === 'equal') {
        modStartIdx = before.bIndex + 1
        modEndIdx = before.bIndex
      } else if (after && after.type === 'equal') {
        modStartIdx = after.bIndex
        modEndIdx = after.bIndex - 1
      } else {
        modStartIdx = 0
        modEndIdx = -1
      }
    }

    // Gather context. We walk backwards over equal ops before changeStart and forwards
    // after changeEnd, capturing up to `contextLines` lines each.
    const leadingContext: string[] = []
    for (let j = changeStart - 1; j >= 0 && leadingContext.length < contextLines; j--) {
      const op = ops[j]!
      if (op.type !== 'equal') break
      leadingContext.unshift(baseLines[op.aIndex]!)
    }
    const trailingContext: string[] = []
    for (let j = changeEnd; j < ops.length && trailingContext.length < contextLines; j++) {
      const op = ops[j]!
      if (op.type !== 'equal') break
      trailingContext.push(baseLines[op.aIndex]!)
    }

    hunks.push({
      id: `hunk-${hunkIdCounter++}`,
      baseStartLine: baseStartIdx + 1,
      baseEndLine: baseEndIdx + 1,
      modifiedStartLine: modStartIdx + 1,
      modifiedEndLine: modEndIdx + 1,
      removedLines,
      addedLines,
      leadingContext,
      trailingContext,
    })
  }
  return hunks
}

/**
 * Public entry: compute the hunk list for (base, modified). Always includes the
 * cached line split + line-ending info so callers don't re-parse when applying later.
 */
export function computeHunks(
  baseContent: string,
  modifiedContent: string,
  opts: { contextLines?: number } = {},
): HunkDiff {
  const baseSplit = splitLines(baseContent)
  const modSplit = splitLines(modifiedContent)
  // When the base is empty we have no signal about line-ending style or trailing newline
  // preference — inherit from the modified side so accepting all hunks round-trips to
  // the exact modified bytes, including its terminator.
  const baseIsEmpty = baseContent === ''
  const baseLineEnding = baseIsEmpty
    ? detectLineEnding(modifiedContent)
    : detectLineEnding(baseContent)
  const baseHasTrailingNewline = baseIsEmpty
    ? modSplit.hasTrailingNewline
    : baseSplit.hasTrailingNewline
  const ops = myersDiff(baseSplit.lines, modSplit.lines)
  const hunks = opsToHunks(
    ops,
    baseSplit.lines,
    modSplit.lines,
    opts.contextLines ?? DEFAULT_CONTEXT_LINES,
  )
  return { hunks, baseLines: baseSplit.lines, baseLineEnding, baseHasTrailingNewline }
}

/**
 * Given the base content and a subset of accepted hunks, produce the resulting content.
 *
 * Invariant: hunks must come from the SAME `computeHunks()` call as the `diff` arg (so
 * line numbers are consistent with `diff.baseLines`). The function does not validate
 * that — callers are expected to hold onto the HunkDiff from computation time.
 *
 * Algorithm:
 *   • Walk baseLines, emitting unchanged lines as-is.
 *   • When we reach the start of a hunk:
 *       - If accepted → emit hunk.addedLines and skip to after baseEndLine.
 *       - If rejected → emit hunk.removedLines as-is (i.e. pretend the hunk wasn't there).
 *   • Stitch lines back together with the original lineEnding and trailing-newline flag.
 */
export function applyAcceptedHunks(
  diff: HunkDiff,
  acceptedHunkIds: Set<string>,
): string {
  const accepted = new Set(acceptedHunkIds)
  const hunksById = new Map(diff.hunks.map((h) => [h.id, h]))
  // Index hunks by baseStartLine for O(1) lookup during the walk.
  const hunkByBaseStartLine = new Map<number, Hunk>()
  for (const h of diff.hunks) hunkByBaseStartLine.set(h.baseStartLine, h)

  const out: string[] = []
  let i = 0 // 0-based line index into diff.baseLines
  const n = diff.baseLines.length

  // Special case: pure insertion at position 0 of an empty base.
  // Also handle pure insertions at the end of the file (baseStartLine === n + 1).
  const handledInsertionsAtStart = new Set<string>()
  for (const h of diff.hunks) {
    if (h.removedLines.length === 0 && h.baseStartLine === 1 && h.baseEndLine === 0) {
      // Insertion BEFORE first line.
      if (accepted.has(h.id)) out.push(...h.addedLines)
      handledInsertionsAtStart.add(h.id)
    }
  }

  while (i < n) {
    const lineNo = i + 1
    const hunk = hunkByBaseStartLine.get(lineNo)
    if (hunk && !handledInsertionsAtStart.has(hunk.id)) {
      if (hunk.removedLines.length === 0) {
        // Pure insertion anchored BEFORE this base line.
        if (accepted.has(hunk.id)) out.push(...hunk.addedLines)
        // Then fall through to emit the current base line normally.
        out.push(diff.baseLines[i]!)
        i++
      } else {
        if (accepted.has(hunk.id)) {
          out.push(...hunk.addedLines)
        } else {
          out.push(...hunk.removedLines)
        }
        // Skip past the removed range in base.
        i = hunk.baseEndLine // baseEndLine is 1-based inclusive → this is exclusive upper bound
      }
    } else {
      out.push(diff.baseLines[i]!)
      i++
    }
  }

  // Handle tail-appended pure insertion hunks (baseStartLine === n + 1).
  for (const h of diff.hunks) {
    if (
      h.removedLines.length === 0 &&
      h.baseStartLine === n + 1 &&
      !handledInsertionsAtStart.has(h.id) &&
      hunksById.get(h.id) === h
    ) {
      if (accepted.has(h.id)) out.push(...h.addedLines)
    }
  }

  const joined = out.join(diff.baseLineEnding)
  return diff.baseHasTrailingNewline && joined !== '' ? joined + diff.baseLineEnding : joined
}
