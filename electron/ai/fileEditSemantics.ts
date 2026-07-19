/**
 * Pure string edit + upstream FileEditTool-aligned helpers (quotes, newlines, replace_all).
 * Used by {@link toolEditFile}, permission previews, and tests.
 */

import crypto from 'node:crypto'
import { UTF8_BOM_CHAR, stripUtf8Bom } from '../utils/lineEndings'
import { canonicalizeForLlmDriftLengthPreserving } from '../utils/charDriftCanonical'

/** upstream MAX_EDIT_FILE_SIZE: 1 GiB (stat bytes) — avoids pathological memory use. */
export const MAX_EDIT_FILE_BYTES = 1024 * 1024 * 1024

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function hashReadLine(line: string): string {
  return crypto.createHash('sha256').update(line, 'utf8').digest('hex').slice(0, 2)
}

export function formatReadLineWithHash(lineNumber1: number, line: string): string {
  return `${lineNumber1}:${hashReadLine(line)}\t${line}`
}

const LEFT_SINGLE_CURLY_QUOTE = '\u2018'
const RIGHT_SINGLE_CURLY_QUOTE = '\u2019'
const LEFT_DOUBLE_CURLY_QUOTE = '\u201c'
const RIGHT_DOUBLE_CURLY_QUOTE = '\u201d'

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true
  const prev = chars[index - 1]
  return (
    prev === ' ' ||
    prev === '\t' ||
    prev === '\n' ||
    prev === '\r' ||
    prev === '(' ||
    prev === '[' ||
    prev === '{' ||
    prev === '\u2014' ||
    prev === '\u2013' ||
    // Fullwidth CJK context that precedes an OPENING quote in Chinese prose:
    // ：，、（【《 — e.g. 他说：“…”。 Deliberately excludes 。！？ (a quote
    // after sentence-final punctuation is genuinely ambiguous).
    prev === '\uFF1A' ||
    prev === '\uFF0C' ||
    prev === '\u3001' ||
    prev === '\uFF08' ||
    prev === '\u3010' ||
    prev === '\u300A'
  )
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(
        isOpeningContext(chars, i) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE,
      )
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      const prev = i > 0 ? chars[i - 1] : undefined
      const next = i < chars.length - 1 ? chars[i + 1] : undefined
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev)
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next)
      if (prevIsLetter && nextIsLetter) {
        result.push(RIGHT_SINGLE_CURLY_QUOTE)
      } else {
        result.push(
          isOpeningContext(chars, i) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE,
        )
      }
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

/**
 * When old_string matched via quote normalization, map straight quotes in new_string to the file's curly style.
 * Ported from upstream FileEditTool/utils preserveQuoteStyle.
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) {
    return newString
  }
  const hasDouble =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  const hasSingle =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)
  if (!hasDouble && !hasSingle) {
    return newString
  }
  let result = newString
  if (hasDouble) result = applyCurlyDoubleQuotes(result)
  if (hasSingle) result = applyCurlySingleQuotes(result)
  return result
}

/**
 * Halfwidth → fullwidth drift pairs handled by {@link canonicalizeForLlmDrift}.
 * Quotes are intentionally absent — {@link preserveQuoteStyle} owns those
 * (left/right selection needs the open/close heuristic; punctuation is 1:1).
 */
const HALF_TO_FULL_DRIFT_PAIRS: ReadonlyArray<readonly [half: string, full: string]> = [
  [',', '\uFF0C'],
  ['.', '\u3002'],
  ['(', '\uFF08'],
  [')', '\uFF09'],
  [':', '\uFF1A'],
  [';', '\uFF1B'],
  ['!', '\uFF01'],
  ['?', '\uFF1F'],
  ['[', '\u3010'],
  [']', '\u3011'],
  ['<', '\u300A'],
  ['>', '\u300B'],
]

const HALF_TO_FULL_DRIFT = new Map<string, string>(HALF_TO_FULL_DRIFT_PAIRS)

/**
 * When old_string matched via {@link canonicalizeForLlmDrift} (fullwidth CJK
 * punctuation on disk, halfwidth ASCII from the model), map the SAME drifted
 * punctuation in new_string back to fullwidth so inserted prose keeps the
 * file's typography (mirrors what preserveQuoteStyle does for quotes).
 *
 * Decisions are positional and conservative. The drift canonicalizer only
 * substitutes single-code-unit BMP chars, so `oldString` and the resolved
 * on-disk slice are the same length and index `i` in one corresponds to
 * index `i` in the other:
 *   - a halfwidth char is converted ONLY when every aligned occurrence in
 *     the matched region drifted (model `,` ↔ disk `，` at all positions);
 *   - if even one aligned position shows the char genuinely halfwidth on
 *     disk (model `,` ↔ disk `,`, e.g. inside a code span), that char is
 *     ambiguous and left untouched in new_string.
 */
export function preserveFullwidthPunctuationStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString || newString.length === 0) {
    return newString
  }
  // `actualOldString` may carry a trailing `\n` appended by the
  // extend/expand helpers; alignment over the shared prefix is unaffected.
  const len = Math.min(oldString.length, actualOldString.length)
  const drifted = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (let i = 0; i < len; i++) {
    const modelChar = oldString[i]!
    const full = HALF_TO_FULL_DRIFT.get(modelChar)
    if (full === undefined) continue
    const diskChar = actualOldString[i]!
    if (diskChar === full) {
      drifted.set(modelChar, full)
    } else if (diskChar === modelChar) {
      ambiguous.add(modelChar)
    }
  }
  let result = newString
  for (const [half, full] of drifted) {
    if (ambiguous.has(half)) continue
    result = result.replaceAll(half, full)
  }
  return result
}

/**
 * Combined drift-style restoration for new_string after a normalized match.
 * Punctuation runs FIRST so a drifted `:` is already `：` when the quote
 * pass classifies the following `"` as opening (他说：“…). Call sites pass
 * the model's `oldTry` and the resolved on-disk `actualOldString`.
 */
function preserveDriftCharStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  return preserveQuoteStyle(
    oldString,
    actualOldString,
    preserveFullwidthPunctuationStyle(oldString, actualOldString, newString),
  )
}

/**
 * Normalize newlines for substring matching. Models usually emit `\n` while Windows
 * files are often `\r\n`, which makes exact `indexOf` fail with "old_string not found".
 */
function normalizeNewlinesForEdit(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * If the model's `old_string` doesn't byte-match the file body, try matching
 * after applying the LLM-drift canonicalization to BOTH sides:
 *   - Curly quotes ↔ ASCII straight quotes
 *   - Fullwidth CJK punctuation (`，。（）【】《》：；！？`) ↔ halfwidth ASCII
 *
 * All target characters are single-code-unit BMP chars, so the resolved slice
 * length is identical to `oldTry.length` and the slice points at the disk
 * verbatim — caller then uses the on-disk form for the replacement so
 * surrounding context stays byte-stable.
 */
function resolveOldStringInFile(fileBody: string, oldTry: string): string | null {
  if (fileBody.includes(oldTry)) return oldTry
  // MUST use the length-preserving canonicalizer (no NFC). The full
  // `canonicalizeForLlmDrift` ends with `.normalize('NFC')`, which composes a
  // decomposed sequence (e.g. `e` + U+0301 = 2 code units → `é` = 1 code unit).
  // That shifts every canonical index AFTER such a char relative to the
  // original, so `fileBody.slice(idx, idx + oldTry.length)` would land on the
  // wrong bytes and silently corrupt the edit (see
  // fileEditSemantics.corruptionEdgeCases.test.ts BUG#1). The 1:1 variant keeps
  // canonical-space indices aligned with the original byte offsets.
  const nf = canonicalizeForLlmDriftLengthPreserving(fileBody)
  const no = canonicalizeForLlmDriftLengthPreserving(oldTry)
  const idx = nf.indexOf(no)
  if (idx === -1) return null
  return fileBody.slice(idx, idx + oldTry.length)
}

/**
 * When deleting (`new_string` empty), the line often ends with `\\n` on disk but the model omits it from `old_string`
 * (upstream `applyEditToFile`).
 */
function expandOldWhenNewStringEmpty(
  fileBody: string,
  matchIndex: number,
  oldStr: string,
  newStr: string,
): string {
  if (newStr !== '') return oldStr
  if (oldStr.endsWith('\n')) return oldStr
  if (fileBody.slice(matchIndex + oldStr.length).startsWith('\n')) {
    return `${oldStr}\n`
  }
  return oldStr
}

/**
 * Map each index in the LF-normalized form of `orig` back to the index in
 * `orig` where that normalized code unit starts. `normalizeNewlinesForEdit`
 * collapses `\r\n`→`\n` (2→1) and `\r`→`\n` (1→1) and leaves everything else
 * 1:1, so we rebuild the mapping by walking `orig` and recording the original
 * start of each emitted normalized unit. The returned array has length
 * `normalizedLength + 1`; the final entry is `orig.length` so a normalized
 * range `[a, b)` maps to the original range `[map[a], map[b])`.
 */
function buildLfToOriginalIndexMap(orig: string): number[] {
  const map: number[] = []
  let i = 0
  while (i < orig.length) {
    map.push(i)
    if (orig.charCodeAt(i) === 13 /* \r */) {
      i += orig.charCodeAt(i + 1) === 10 /* \n */ ? 2 : 1
    } else {
      i += 1
    }
  }
  map.push(orig.length)
  return map
}

/**
 * Pick the EOL style for text INSERTED by a normalized-path edit. We only ever
 * convert the inserted bytes — never untouched lines — so this choice cannot
 * corrupt surrounding content; it just keeps new lines visually consistent.
 * Prefer the EOL of the region being replaced; if that region has no newline,
 * fall back to the file's apparent style.
 */
function eolForInsertedText(replacedRegion: string, fileBody: string): '\r\n' | '\n' {
  if (replacedRegion.includes('\r\n')) return '\r\n'
  if (replacedRegion.includes('\n')) return '\n'
  return fileBody.includes('\r\n') ? '\r\n' : '\n'
}

/** Trailing banner from read_file — models often paste it into Edit oldString. */
const READ_TOOL_OUTPUT_SUFFIX_RE = /\n\n\(showing lines \d+-\d+ of \d+\)\s*$/u

function stripReadToolOutputSuffix(s: string): string {
  return s.replace(READ_TOOL_OUTPUT_SUFFIX_RE, '')
}

/**
 * Read tool formats each line as `N\\t<line text>`. Models paste that into Edit; the file on disk has no prefixes.
 */
function stripReadToolLineNumberPrefixes(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/^\d+(?::[0-9a-f]{2})?\t/, ''))
    .join('\n')
}

/** Try raw oldString first, then forms normalized from Read-tool output (OpenAI etc. copy verbatim). */
function collectEditOldStringVariants(oldBody: string): string[] {
  const seeds: string[] = []
  const pushSeed = (s: string) => {
    if (s.length === 0) return
    if (!seeds.includes(s)) seeds.push(s)
  }
  pushSeed(oldBody)
  pushSeed(stripReadToolOutputSuffix(oldBody))
  pushSeed(stripReadToolLineNumberPrefixes(oldBody))
  pushSeed(stripReadToolLineNumberPrefixes(stripReadToolOutputSuffix(oldBody)))

  const out: string[] = []
  const add = (s: string) => {
    if (s.length === 0) return
    if (!out.includes(s)) out.push(s)
  }
  for (const v of seeds) {
    add(v)
    if (!v.endsWith('\n')) add(`${v}\n`)
  }
  return out
}

/** When oldTry matches but the file has an immediate `\\n` after it and newString ends with `\\n`, include that newline in the match so we do not double the final newline (common after pasting from Read). */
function extendOldThroughFollowingNewline(
  fileBody: string,
  matchIndex: number,
  oldTry: string,
  newBody: string,
): string {
  if (oldTry.endsWith('\n')) return oldTry
  if (!newBody.endsWith('\n')) return oldTry
  if (!fileBody.slice(matchIndex + oldTry.length).startsWith('\n')) return oldTry
  return `${oldTry}\n`
}

// ---------------------------------------------------------------------------
// Whitespace-tolerant fallback tier (2026-07, drift elimination)
//
// The #1 residual cause of "old_string not found" after the exact /
// quote-drift / CRLF / escape tiers is WHITESPACE transcription drift: the
// model recomposes a block from context and loses trailing spaces, swaps
// tabs↔spaces, shifts the whole block by one indent level, or emits NBSP /
// fullwidth spaces. This tier locates old_string line-by-line with per-line
// whitespace normalization, then:
//   - requires the match to be UNIQUE in the file (ambiguity → explicit
//     error, never a guess);
//   - replaces the EXACT on-disk bytes of the matched region (surrounding
//     content stays byte-stable, same guarantee as resolveOldStringInFile);
//   - re-indents new_string from the observed old→disk indent mapping so
//     the inserted lines land at the file's real indentation;
//   - attaches an advisory warning to the success result so the model can
//     verify in the same turn.
//
// `replace_all` deliberately keeps exact-only semantics: multi-span fuzzy
// rewriting is not auditable and the blast radius of a wrong normalization
// would be the whole file.
// ---------------------------------------------------------------------------

const EXOTIC_SPACE_RE = /[\u00A0\u2007\u202F\u3000]/g

/** Per-line canonical form for whitespace-tolerant matching. Runs the
 *  LLM-drift char canonicalizer FIRST so combined drift (curly quotes +
 *  whitespace in the same payload) still locates — matching is canonical-
 *  space only; the replacement always uses the disk's verbatim bytes. */
function normalizeLineForWsMatch(line: string): string {
  return canonicalizeForLlmDriftLengthPreserving(line)
    .replace(EXOTIC_SPACE_RE, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function leadingIndentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ''
}

export type WhitespaceTolerantEditPlan =
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number; firstLines1: number[] }
  | {
      kind: 'match'
      origStart: number
      origEnd: number
      replacedRegion: string
      insert: string
      /** Advisory note describing what was normalized/adjusted. */
      note: string
    }

/**
 * Locate `oldTry` in `cBody` with per-line whitespace tolerance and build a
 * ready-to-splice plan. Pure; no I/O. See the tier comment block above.
 */
function computeWhitespaceTolerantEditPlan(
  cBody: string,
  oldTry: string,
  newBody: string,
): WhitespaceTolerantEditPlan {
  const nContent = normalizeNewlinesForEdit(cBody)
  const nOld = normalizeNewlinesForEdit(oldTry)
  const nNew = normalizeNewlinesForEdit(newBody)

  const oldLinesAll = nOld.split('\n')
  // A trailing newline in old_string yields a final '' element — drop it for
  // line matching; the trailing-newline semantics are re-applied below via
  // extendOldThroughFollowingNewline / expandOldWhenNewStringEmpty.
  const oldLines =
    oldLinesAll.length > 1 && oldLinesAll[oldLinesAll.length - 1] === ''
      ? oldLinesAll.slice(0, -1)
      : oldLinesAll
  const normOld = oldLines.map(normalizeLineForWsMatch)
  // Whitespace-only old_string carries no content signal — never fuzzy-match it.
  if (normOld.every((l) => l === '')) return { kind: 'none' }

  const fileLines = nContent.split('\n')
  if (oldLines.length > fileLines.length) return { kind: 'none' }

  const lineStart: number[] = new Array(fileLines.length)
  let off = 0
  for (let i = 0; i < fileLines.length; i++) {
    lineStart[i] = off
    off += fileLines[i]!.length + 1
  }

  const normFile = fileLines.map(normalizeLineForWsMatch)
  const starts: number[] = []
  outer: for (let j = 0; j + oldLines.length <= fileLines.length; j++) {
    for (let i = 0; i < normOld.length; i++) {
      if (normFile[j + i] !== normOld[i]) continue outer
    }
    starts.push(j)
    if (starts.length > 8) break
  }
  if (starts.length === 0) return { kind: 'none' }
  if (starts.length > 1) {
    return {
      kind: 'ambiguous',
      count: starts.length,
      firstLines1: starts.map((j) => j + 1),
    }
  }

  const j = starts[0]!
  const diskLines = fileLines.slice(j, j + oldLines.length)

  // ── Indent mapping (old → disk) ──
  // Tier 1: uniform prefix add/remove — covers "whole block shifted by one
  //         indent level" including indents the new_string introduces that
  //         the old block never used (deeper nesting).
  // Tier 2: exact dictionary oldIndent→diskIndent built from matched lines —
  //         covers tab↔space style swaps. New lines whose indent has no
  //         dictionary entry are kept verbatim and flagged in the note.
  let uniform: { mode: 'same' | 'add' | 'remove'; delta: string } | null | undefined
  const indentMap = new Map<string, string>()
  let indentMapConflict = false
  for (let i = 0; i < oldLines.length; i++) {
    if (normOld[i] === '') continue
    const di = leadingIndentOf(diskLines[i]!)
    const oi = leadingIndentOf(oldLines[i]!)

    const prev = indentMap.get(oi)
    if (prev !== undefined && prev !== di) indentMapConflict = true
    indentMap.set(oi, di)

    let cand: { mode: 'same' | 'add' | 'remove'; delta: string } | null
    if (di === oi) {
      cand = { mode: 'same', delta: '' }
    } else if (di.endsWith(oi)) {
      cand = { mode: 'add', delta: di.slice(0, di.length - oi.length) }
    } else if (oi.endsWith(di)) {
      cand = { mode: 'remove', delta: oi.slice(0, oi.length - di.length) }
    } else {
      cand = null
    }
    if (uniform === undefined) {
      uniform = cand
    } else if (
      uniform !== null &&
      (cand === null || cand.mode !== uniform.mode || cand.delta !== uniform.delta)
    ) {
      uniform = null
    }
  }

  let insertN = nNew
  let adjustDesc = ''
  let unmappedIndent = false
  if (nNew.length > 0) {
    if (uniform && uniform.mode === 'add' && uniform.delta !== '') {
      insertN = nNew
        .split('\n')
        .map((l) => (l === '' ? l : uniform!.delta + l))
        .join('\n')
      adjustDesc = `; new_string was re-indented (+${JSON.stringify(uniform.delta)} per line) to the file's actual indentation`
    } else if (uniform && uniform.mode === 'remove' && uniform.delta !== '') {
      insertN = nNew
        .split('\n')
        .map((l) => (l.startsWith(uniform!.delta) ? l.slice(uniform!.delta.length) : l))
        .join('\n')
      adjustDesc = `; new_string was re-indented (-${JSON.stringify(uniform.delta)} per line) to the file's actual indentation`
    } else if (!uniform && !indentMapConflict && indentMap.size > 0) {
      insertN = nNew
        .split('\n')
        .map((l) => {
          if (l === '') return l
          const ind = leadingIndentOf(l)
          const mapped = indentMap.get(ind)
          if (mapped === undefined) {
            if (ind !== '') unmappedIndent = true
            return l
          }
          return mapped + l.slice(ind.length)
        })
        .join('\n')
      adjustDesc = '; new_string indentation was remapped to the file\'s actual style (e.g. tabs vs spaces)'
      if (unmappedIndent) {
        adjustDesc +=
          ' — some inserted lines used an indent depth not present in old_string and were kept verbatim; VERIFY their indentation'
      }
    }
  }

  const nStart = lineStart[j]!
  const lastLineIdx = j + oldLines.length - 1
  const matchedRegionN = nContent.slice(nStart, lineStart[lastLineIdx]! + fileLines[lastLineIdx]!.length)
  let effectiveOldN = extendOldThroughFollowingNewline(nContent, nStart, matchedRegionN, insertN)
  effectiveOldN = expandOldWhenNewStringEmpty(nContent, nStart, effectiveOldN, insertN)
  const nEnd = nStart + effectiveOldN.length

  const map = buildLfToOriginalIndexMap(cBody)
  const origStart = map[nStart]!
  const origEnd = map[nEnd]!
  const replacedRegion = cBody.slice(origStart, origEnd)
  const insert = insertN.replace(/\n/g, eolForInsertedText(replacedRegion, cBody))

  const firstLine1 = j + 1
  const lastLine1 = lastLineIdx + 1
  const lineLabel = firstLine1 === lastLine1 ? `line ${firstLine1}` : `lines ${firstLine1}-${lastLine1}`
  const note =
    `old_string did not match the file byte-for-byte; it was located at ${lineLabel} via whitespace-normalized ` +
    `matching (tabs/spaces, indentation, trailing spaces, or exotic space characters differed)${adjustDesc}. ` +
    'The edit replaced the file\'s ACTUAL bytes at that location. Verify the result; if this was the wrong ' +
    'region, revert and retry with the exact on-disk text from read_file.'

  return { kind: 'match', origStart, origEnd, replacedRegion, insert, note }
}

/**
 * True when edit_file's matcher — ANY tier, including the whitespace-tolerant
 * fallback — can locate `oldString` in `content`. Shared by the
 * read-before-edit gate (readFileState) and multi_edit_file's partial-view
 * simulation so the gates never reject a payload the applier would accept.
 * Ambiguous whitespace matches count as locatable: ambiguity is judged by
 * the applier with a more actionable error.
 */
export function editOldStringLocatable(
  content: string,
  oldString: string,
  allowLiteralEscapeRetry = true,
): boolean {
  const { body: cBody } = stripUtf8Bom(content)
  const { body: oldBody } = stripUtf8Bom(oldString)
  if (oldBody === '') return true // empty-old semantics judged elsewhere
  const nContent = normalizeNewlinesForEdit(cBody)
  for (const oldTry of collectEditOldStringVariants(oldBody)) {
    if (resolveOldStringInFile(cBody, oldTry) !== null) return true
    if (resolveOldStringInFile(nContent, normalizeNewlinesForEdit(oldTry)) !== null) return true
    if (computeWhitespaceTolerantEditPlan(cBody, oldTry, '').kind !== 'none') return true
  }
  if (allowLiteralEscapeRetry) {
    const decodedOld = decodeLiteralEditOldString(oldBody)
    if (decodedOld !== null) return editOldStringLocatable(cBody, decodedOld, false)
  }
  return false
}

function line1AtCharIndexForDuplicateMessage(content: string, index: number): number {
  if (index <= 0) return 1
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

function lineRangeForMatch(content: string, start: number, end: number): { minLine1: number; maxLine1: number } {
  return {
    minLine1: line1AtCharIndexForDuplicateMessage(content, start),
    maxLine1: line1AtCharIndexForDuplicateMessage(content, Math.max(start, end - 1)),
  }
}

const DUP_SNIPPET_MAX_CHARS = 120

function snippetForMatch(content: string, start: number, end: number): string {
  const lineStart = content.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const nextNewline = content.indexOf('\n', end)
  const lineEnd = nextNewline === -1 ? content.length : nextNewline
  const rawLine = content.slice(lineStart, lineEnd)
  const compactWhole = rawLine.replace(/\s+/g, ' ').trim()
  if (compactWhole.length <= DUP_SNIPPET_MAX_CHARS) return compactWhole
  // Long line: window the RAW line AROUND the match and only then compact, so
  // the matched bytes (and their immediate neighbours) stay visible. The old
  // behaviour sliced the first 117 chars of the line, which — for a short
  // needle deep inside a long prose/Chinese line — showed only the line's
  // START and never the match, making the message's own advice ("retry with
  // more surrounding context") impossible to act on.
  const matchStart = Math.max(0, start - lineStart)
  const matchLen = Math.max(1, end - start)
  const pad = Math.max(
    0,
    Math.floor((DUP_SNIPPET_MAX_CHARS - Math.min(matchLen, DUP_SNIPPET_MAX_CHARS)) / 2),
  )
  const windowStart = Math.max(0, matchStart - pad)
  const windowEnd = Math.min(rawLine.length, matchStart + matchLen + pad)
  const prefix = windowStart > 0 ? '…' : ''
  const suffix = windowEnd < rawLine.length ? '…' : ''
  const window = rawLine.slice(windowStart, windowEnd).replace(/\s+/g, ' ').trim()
  return `${prefix}${window}${suffix}`
}

function collectMatchLocations(content: string, needle: string): Array<{ minLine1: number; maxLine1: number; snippet: string }> {
  const out: Array<{ minLine1: number; maxLine1: number; snippet: string }> = []
  if (!needle) return out
  let cursor = 0
  while (cursor <= content.length) {
    const idx = content.indexOf(needle, cursor)
    if (idx === -1) break
    const range = lineRangeForMatch(content, idx, idx + needle.length)
    out.push({ ...range, snippet: snippetForMatch(content, idx, idx + needle.length) })
    cursor = idx + Math.max(needle.length, 1)
    if (out.length >= 8) break
  }
  return out
}

function duplicateOldStringError(content: string, effectiveOld: string): string {
  const locations = collectMatchLocations(content, effectiveOld)
  if (locations.length === 0) {
    return 'The old_string appears multiple times. Make it more specific or set replace_all: true.'
  }
  const rendered = locations
    .slice(0, 5)
    .map((loc) => {
      const lineLabel = loc.minLine1 === loc.maxLine1 ? `line ${loc.minLine1}` : `lines ${loc.minLine1}-${loc.maxLine1}`
      return `- ${lineLabel}: ${loc.snippet}`
    })
    .join('\n')
  const more = locations.length > 5 ? `\n- ...and ${locations.length - 5} more match(es)` : ''
  const firstLine = locations[0]?.minLine1
  const hashAnchorHint =
    firstLine !== undefined
      ? `\nBest fix for repeated short strings (edit_file only): pin the edit to ONE region with hashAnchor instead of lengthening old_string. ` +
        `Copy the \`N:hash\` prefix that read_file printed for your target line (e.g. line ${firstLine}) into hashAnchor — ` +
        `edit_file then confines the match to that line range, so the duplicate elsewhere is ignored. No counting, no re-read.`
      : ''
  return (
    `The old_string appears multiple times (${locations.length} shown/known match(es)). No edit was made.\n` +
    `Candidate locations:\n${rendered}${more}` +
    hashAnchorHint +
    '\nOtherwise, expand old_string so it matches exactly once: include the FULL line(s) around your target ' +
    '(and an adjacent line above/below if a single line is still ambiguous). ' +
    'You already have these bytes from your last read — no re-read is needed unless the file changed. ' +
    'Only set replace_all: true if EVERY occurrence above should get the same change ' +
    '(in multi_edit_file replace_all is per-edit and rewrites all matches of THIS edit).'
  )
}

const WORD_CHAR_RE = /[A-Za-z0-9_]/

/**
 * Post-hoc boundary check for `replace_all` — the classic `user` vs
 * `username` trap (harness-write design D13). When an occurrence of the
 * replaced string sits ADJACENT to an identifier character in the original
 * text (and the needle's own boundary char is an identifier char, i.e. the
 * replacement genuinely splices into a longer identifier), we do NOT reject
 * (the model may well mean it), but the success message names the affected
 * lines so a wrong mass-rename is caught in the same turn instead of at
 * compile/review time. Returns `null` when no occurrence collides.
 */
export function collectReplaceAllBoundaryCollisionWarning(
  content: string,
  needle: string,
): string | null {
  if (!needle) return null
  const firstIsWord = WORD_CHAR_RE.test(needle[0]!)
  const lastIsWord = WORD_CHAR_RE.test(needle[needle.length - 1]!)
  if (!firstIsWord && !lastIsWord) return null

  const collidedLines: number[] = []
  let idx = content.indexOf(needle)
  while (idx !== -1) {
    const prev = idx > 0 ? content[idx - 1]! : ''
    const next = idx + needle.length < content.length ? content[idx + needle.length]! : ''
    const splicesIdentifier =
      (firstIsWord && prev !== '' && WORD_CHAR_RE.test(prev)) ||
      (lastIsWord && next !== '' && WORD_CHAR_RE.test(next))
    if (splicesIdentifier) {
      const line1 = line1AtCharIndexForDuplicateMessage(content, idx)
      if (collidedLines[collidedLines.length - 1] !== line1) collidedLines.push(line1)
      if (collidedLines.length >= 8) break
    }
    idx = content.indexOf(needle, idx + Math.max(needle.length, 1))
  }
  if (collidedLines.length === 0) return null
  const lineList = collidedLines.join(', ')
  return (
    `replace_all boundary check: some replaced occurrence(s) sit INSIDE a longer identifier ` +
    `(line${collidedLines.length === 1 ? '' : 's'} ${lineList}) — the pattern that turns ` +
    `"user" into "account" inside "username" → "accountname". Verify those lines; if any ` +
    `replacement was unintended, fix it with a follow-up edit.`
  )
}

/**
 * Truncation-placeholder signatures a model writes when it "summarises"
 * code/prose it no longer has in context — the lazy-write data-loss pattern
 * (hermes-agent #20849). Two shapes are flagged, both line-scoped:
 *
 *   1. A comment-marker line whose payload starts with an ellipsis:
 *      `// ...`, `# … more handlers`, a `...` block comment, `<!-- ... -->`
 *   2. Any line combining an ellipsis with an "omitted content" keyword
 *      (EN + ZH): `... rest of the code unchanged`, `……其余内容保持不变`
 *
 * Deliberately NOT flagged (false-positive control):
 *   - a bare `...` / `…` line (legit Python `Ellipsis`, prose)
 *   - ellipses inside ordinary prose without an omission keyword
 *     (Chinese documents use `……` constantly)
 *   - spread/rest syntax (`(...args)`) — no comment marker, no keyword
 */
const PLACEHOLDER_COMMENT_ELLIPSIS_LINE_RE =
  /^\s*(?:\/\/|#|\/\*|\*|<!--|;|--)\s*(?:\.{3}|\u2026+)/
const PLACEHOLDER_OMISSION_KEYWORD_RE =
  /(rest of|remaining|unchanged|omitted|existing (?:code|content)|original (?:code|content)|same as (?:before|above)|其余|其他部分|保持不变|省略|同上)/i
const ANY_ELLIPSIS_RE = /\.{3}|\u2026/

/**
 * Detect placeholder lines that `newString` INTRODUCES relative to the
 * region it replaces. Lines already present in `replacedRegion` are the
 * model faithfully copying existing content and never flagged. Returns a
 * warning message naming the first offending line, or `null`.
 */
export function detectPlaceholderIntroducedByEdit(
  replacedRegion: string,
  newString: string,
): string | null {
  if (!newString) return null
  const lines = newString.split('\n')
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    const trimmed = line.trim()
    if (!trimmed) continue
    const isCommentEllipsis = PLACEHOLDER_COMMENT_ELLIPSIS_LINE_RE.test(line)
    const isKeywordEllipsis =
      ANY_ELLIPSIS_RE.test(line) && PLACEHOLDER_OMISSION_KEYWORD_RE.test(line)
    if (!isCommentEllipsis && !isKeywordEllipsis) continue
    if (replacedRegion.includes(trimmed)) continue
    const preview = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed
    return (
      `new_string introduces what looks like a truncation placeholder (${JSON.stringify(preview)}) ` +
      `that was NOT present in the text being replaced. If that line stands in for real content ` +
      `you no longer have in context, this edit just DELETED that content — re-read the file ` +
      `and restore the omitted section (file-history backup keeps the pre-edit bytes). ` +
      `If the placeholder is intentional, ignore this warning.`
    )
  }
  return null
}

/**
 * Pure string edit — same semantics as {@link toolEditFile} without filesystem I/O.
 * Used for permission diff preview and tests.
 *
 * Includes a one-shot literal-escape retry on the not-found path. It recovers
 * both Unicode escape text and redundant JSON-string escapes that survived
 * into an already-parsed tool field. The retry runs only AFTER the raw form
 * failed to match, so files that genuinely contain escape text are unaffected.
 */
export type FileEditComputeResult =
  | {
      success: true
      newContent: string
      /**
       * Advisory, non-blocking warnings attached to a SUCCESSFUL edit:
       *   - replace_all substring-boundary collisions (`user` → inside `username`)
       *   - new_string introducing a truncation-placeholder line
       * Callers surface these in the success output so the model can
       * self-verify in the same turn. Absent when there is nothing to flag.
       */
      warnings?: string[]
    }
  | { success: false; error: string }

export function computeFileEditResult(
  content: string,
  oldString: string,
  newString: string,
  options?: { replaceAll?: boolean },
): FileEditComputeResult {
  return computeFileEditResultInner(content, oldString, newString, options, true)
}

/**
 * One-shot retry of {@link computeFileEditResultInner} with redundant literal
 * escapes decoded on BOTH sides. Returns `null` when the retry does not apply
 * or when the decoded form is not found either; the caller then falls back to
 * its original not-found error.
 *
 * JSON escape kinds are mirrored from old_string to new_string: if old_string
 * proves that `\"` was redundant, the same escape is decoded in new_string,
 * while unrelated sequences such as an intentional `\n` remain untouched.
 * A non-not-found failure on the decoded form (for example duplicate matches)
 * is surfaced because it is more actionable than the original not-found.
 */
function retryEditWithDecodedLiteralEscapes(
  content: string,
  oldString: string,
  newString: string,
  options?: { replaceAll?: boolean },
): FileEditComputeResult | null {
  const decoded = decodeLiteralEditStrings(oldString, newString)
  if (decoded === null) return null
  const retry = computeFileEditResultInner(
    content,
    decoded.oldString,
    decoded.newString,
    options,
    false,
  )
  if (retry.success) {
    const recoveryWarning =
      `old_string contained redundant ${decoded.label}; its raw form was absent, so the tool safely ` +
      'decoded the proven escape form in old_string and new_string before applying the edit.'
    return {
      ...retry,
      warnings: [...(retry.warnings ?? []), recoveryWarning],
    }
  }
  if (retry.error.startsWith('The old_string was not found')) return null
  return {
    success: false,
    error:
      `old_string contained redundant ${decoded.label}; the tool auto-decoded them ` +
      `and retried, but the decoded form failed: ${retry.error}`,
  }
}

function computeFileEditResultInner(
  content: string,
  oldString: string,
  newString: string,
  options: { replaceAll?: boolean } | undefined,
  allowEscapeDecodeRetry: boolean,
): FileEditComputeResult {
  const { body: cBody, hadBom: contentHadBom } = stripUtf8Bom(content)
  const { body: oldBody } = stripUtf8Bom(oldString)
  const { body: newBody } = stripUtf8Bom(newString)

  const finalize = (
    newContent: string,
    warnings?: string[],
  ): { success: true; newContent: string; warnings?: string[] } => ({
    success: true,
    newContent:
      contentHadBom && !newContent.startsWith(UTF8_BOM_CHAR)
        ? UTF8_BOM_CHAR + newContent
        : newContent,
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  })

  /** Collect advisory warnings for a successful replacement. Never rejects. */
  const warningsFor = (
    replacedRegion: string,
    insertedText: string,
    boundaryCheck?: { haystack: string; needle: string },
  ): string[] => {
    const out: string[] = []
    if (boundaryCheck) {
      const w = collectReplaceAllBoundaryCollisionWarning(
        boundaryCheck.haystack,
        boundaryCheck.needle,
      )
      if (w) out.push(w)
    }
    const p = detectPlaceholderIntroducedByEdit(replacedRegion, insertedText)
    if (p) out.push(p)
    return out
  }

  const fileEffectivelyEmpty = cBody.trim() === ''
  // Distinguish a literally-empty file body (BOM-only or 0-byte) from a
  // file that has whitespace bytes — important for the fast-paths below.
  const fileBodyLiterallyEmpty = cBody.length === 0
  const oldIsOnlyWhitespace = oldBody.length > 0 && oldBody.trim() === ''
  const replaceAll = options?.replaceAll === true

  // upstream: empty old_string on non-empty file is invalid (not a silent full overwrite).
  if (oldBody === '') {
    if (!fileEffectivelyEmpty) {
      return {
        success: false,
        error:
          'Cannot use empty old_string when the file already has content. Provide a unique old_string to replace, or use edit_file with a concrete old_string for a full replacement.',
      }
    }
    // Branch on the *raw* old_string, not the BOM-stripped body:
    //   - `old_string === ''` (literal empty): user is doing a fresh full
    //     replace and made no reference to a BOM. Use `new_string` verbatim
    //     so we do NOT auto-prepend a BOM left over from the previous file
    //     (test E12). If they want a BOM in the result, they include one
    //     in `new_string`.
    //   - `old_string` was a BOM (or `\uFEFF…`): user explicitly referenced
    //     the BOM as the thing being replaced — keep the established
    //     BOM-preservation behaviour via `finalize()` (test E1).
    if (oldString === '') {
      return { success: true, newContent: newString }
    }
    return finalize(newBody)
  }

  // Whitespace `old_string` on a *literally* empty file (0 bytes / BOM-only)
  // is a full replacement — historical behaviour preserved by tests like
  // CAT1.E8 in tools.extremeScenarios. We do NOT extend this to files that
  // contain whitespace bytes (`'   \n\t\n  '`): there the user gave a
  // concrete substring and expects positional replacement (test E8 in
  // tools.editFile.extreme), so we fall through to the substring path.
  if (oldIsOnlyWhitespace && fileBodyLiterallyEmpty) {
    return finalize(newBody)
  }

  if (replaceAll) {
    for (const oldTry of collectEditOldStringVariants(oldBody)) {
      const resolvedRaw = resolveOldStringInFile(cBody, oldTry)
      if (resolvedRaw !== null) {
        const newToUse = preserveDriftCharStyle(oldTry, resolvedRaw, newBody)
        return finalize(
          cBody.split(resolvedRaw).join(newToUse),
          warningsFor(resolvedRaw, newToUse, { haystack: cBody, needle: resolvedRaw }),
        )
      }
      const nContent = normalizeNewlinesForEdit(cBody)
      const nOld = normalizeNewlinesForEdit(oldTry)
      const nNew = normalizeNewlinesForEdit(newBody)
      const resolvedN = resolveOldStringInFile(nContent, nOld)
      if (resolvedN !== null && nContent.indexOf(resolvedN) !== -1) {
        // Splice every match into the ORIGINAL body (not a fully LF-normalized
        // copy that gets blanket re-CRLF'd). Untouched lines keep their exact
        // original EOLs; only the inserted text adopts a chosen EOL. See
        // corruptionEdgeCases.test.ts BUG#2.
        const newToUse = preserveDriftCharStyle(nOld, resolvedN, nNew)
        const map = buildLfToOriginalIndexMap(cBody)
        let out = ''
        let normCursor = 0
        let idx = nContent.indexOf(resolvedN)
        while (idx !== -1) {
          out += cBody.slice(map[normCursor]!, map[idx]!)
          const replacedRegion = cBody.slice(map[idx]!, map[idx + resolvedN.length]!)
          out += newToUse.replace(/\n/g, eolForInsertedText(replacedRegion, cBody))
          normCursor = idx + resolvedN.length
          idx = nContent.indexOf(resolvedN, normCursor)
        }
        out += cBody.slice(map[normCursor]!)
        return finalize(
          out,
          warningsFor(resolvedN, newToUse, { haystack: nContent, needle: resolvedN }),
        )
      }
    }
    if (allowEscapeDecodeRetry) {
      const retried = retryEditWithDecodedLiteralEscapes(cBody, oldBody, newBody, options)
      if (retried) {
        return retried.success ? finalize(retried.newContent, retried.warnings) : retried
      }
    }
    return {
      success: false,
      error:
        `The old_string was not found in the file.` +
        findLiteralUnicodeEscapeHint(cBody, oldBody) +
        findFuzzyOldStringHints(cBody, oldBody),
    }
  }

  for (const oldTry of collectEditOldStringVariants(oldBody)) {
    const resolvedRaw = resolveOldStringInFile(cBody, oldTry)
    if (resolvedRaw !== null) {
      const index = cBody.indexOf(resolvedRaw)
      if (index !== -1) {
        let effectiveOld = extendOldThroughFollowingNewline(cBody, index, resolvedRaw, newBody)
        effectiveOld = expandOldWhenNewStringEmpty(cBody, index, effectiveOld, newBody)
        if (cBody.indexOf(effectiveOld, index + effectiveOld.length) !== -1) {
          return {
            success: false,
            error: duplicateOldStringError(cBody, effectiveOld),
          }
        }
        const newToUse = preserveDriftCharStyle(oldTry, effectiveOld, newBody)
        return finalize(
          cBody.replace(effectiveOld, newToUse),
          warningsFor(effectiveOld, newToUse),
        )
      }
    }

    const nContent = normalizeNewlinesForEdit(cBody)
    const nOld = normalizeNewlinesForEdit(oldTry)
    const nNew = normalizeNewlinesForEdit(newBody)
    const resolvedN = resolveOldStringInFile(nContent, nOld)
    if (resolvedN !== null) {
      const nIndex = nContent.indexOf(resolvedN)
      if (nIndex !== -1) {
        let effectiveOldN = extendOldThroughFollowingNewline(nContent, nIndex, resolvedN, nNew)
        effectiveOldN = expandOldWhenNewStringEmpty(nContent, nIndex, effectiveOldN, nNew)
        if (nContent.indexOf(effectiveOldN, nIndex + effectiveOldN.length) !== -1) {
          return {
            success: false,
            error: duplicateOldStringError(nContent, effectiveOldN),
          }
        }
        // Splice into the ORIGINAL body via the LF→original index map so the
        // untouched prefix/suffix keep their exact original line endings.
        // Previously the whole result was rebuilt in LF space and blanket
        // re-CRLF'd, which rewrote the EOL of lines the edit never targeted on
        // mixed-EOL files (corruptionEdgeCases.test.ts BUG#2).
        const newToUse = preserveDriftCharStyle(nOld, effectiveOldN, nNew)
        const map = buildLfToOriginalIndexMap(cBody)
        const origStart = map[nIndex]!
        const origEnd = map[nIndex + effectiveOldN.length]!
        const replacedRegion = cBody.slice(origStart, origEnd)
        const insert = newToUse.replace(/\n/g, eolForInsertedText(replacedRegion, cBody))
        return finalize(
          cBody.slice(0, origStart) + insert + cBody.slice(origEnd),
          warningsFor(replacedRegion, insert),
        )
      }
    }
  }

  // ── Whitespace-tolerant fallback (see tier comment block above) ──
  // Only reached after every exact / canonicalized tier failed. Unique
  // whitespace-normalized match → apply with the file's actual bytes and an
  // advisory warning; multiple matches → explicit ambiguity error.
  for (const oldTry of collectEditOldStringVariants(oldBody)) {
    const plan = computeWhitespaceTolerantEditPlan(cBody, oldTry, newBody)
    if (plan.kind === 'ambiguous') {
      return {
        success: false,
        error:
          `The old_string was not found byte-for-byte, and its whitespace-normalized form matches ` +
          `${plan.count} locations (starting at lines ${plan.firstLines1.join(', ')}). ` +
          `Extend old_string with more distinctive surrounding lines so exactly one region matches, then retry.`,
      }
    }
    if (plan.kind === 'match') {
      return finalize(
        cBody.slice(0, plan.origStart) + plan.insert + cBody.slice(plan.origEnd),
        [...warningsFor(plan.replacedRegion, plan.insert), plan.note],
      )
    }
  }

  if (allowEscapeDecodeRetry) {
    const retried = retryEditWithDecodedLiteralEscapes(cBody, oldBody, newBody, options)
    if (retried) {
      return retried.success ? finalize(retried.newContent, retried.warnings) : retried
    }
  }

  return {
    success: false,
    error:
      `The old_string was not found in the file.` +
      findLiteralUnicodeEscapeHint(cBody, oldBody) +
      findFuzzyOldStringHints(cBody, oldBody),
  }
}

/**
 * Decode literal `\uXXXX` / `\u{...}` sequences in `s` into real characters.
 * Returns `null` when `s` contains no decodable escape (or an out-of-range
 * codepoint makes the decode meaningless). Shared by the auto-decode retry
 * in {@link computeFileEditResult} and the diagnosis hint below.
 */
export function decodeLiteralUnicodeEscapes(s: string): string | null {
  if (!/\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\}/.test(s)) return null
  let decoded: string
  try {
    decoded = s
      .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => {
        const cp = parseInt(hex, 16)
        if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) {
          throw new Error('out-of-range codepoint')
        }
        return String.fromCodePoint(cp)
      })
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  } catch {
    return null
  }
  return decoded === s ? null : decoded
}

type JsonStringEscapeKind = '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't'

type JsonStringEscapeDecode = {
  decoded: string
  kinds: Set<JsonStringEscapeKind>
}

const JSON_STRING_ESCAPE_REPLACEMENTS: Record<JsonStringEscapeKind, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

function decodeLiteralJsonStringEscapesByKind(
  value: string,
  allowedKinds?: ReadonlySet<JsonStringEscapeKind>,
): JsonStringEscapeDecode | null {
  let decoded = ''
  let changed = false
  const kinds = new Set<JsonStringEscapeKind>()

  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (char !== '\\' || index + 1 >= value.length) {
      decoded += char
      continue
    }

    const possibleKind = value[index + 1] as JsonStringEscapeKind
    if (
      !Object.prototype.hasOwnProperty.call(JSON_STRING_ESCAPE_REPLACEMENTS, possibleKind) ||
      (allowedKinds !== undefined && !allowedKinds.has(possibleKind))
    ) {
      decoded += char
      continue
    }

    decoded += JSON_STRING_ESCAPE_REPLACEMENTS[possibleKind]
    kinds.add(possibleKind)
    changed = true
    index++
  }

  return changed ? { decoded, kinds } : null
}

function decodeLiteralEditOldString(oldString: string): string | null {
  let decoded = oldString
  let changed = false
  const jsonDecoded = decodeLiteralJsonStringEscapesByKind(decoded)
  if (jsonDecoded !== null) {
    decoded = jsonDecoded.decoded
    changed = true
  }
  const unicodeDecoded = decodeLiteralUnicodeEscapes(decoded)
  if (unicodeDecoded !== null) {
    decoded = unicodeDecoded
    changed = true
  }
  return changed ? decoded : null
}

function decodeLiteralEditStrings(
  oldString: string,
  newString: string,
): { oldString: string; newString: string; label: string } | null {
  let decodedOld = oldString
  let decodedNew = newString
  const labels: string[] = []

  const jsonOld = decodeLiteralJsonStringEscapesByKind(decodedOld)
  if (jsonOld !== null) {
    decodedOld = jsonOld.decoded
    decodedNew =
      decodeLiteralJsonStringEscapesByKind(decodedNew, jsonOld.kinds)?.decoded ?? decodedNew
    labels.push('JSON string escapes (`\\"`, `\\\\`, `\\n`, etc.)')
  }

  const unicodeOld = decodeLiteralUnicodeEscapes(decodedOld)
  if (unicodeOld !== null) {
    decodedOld = unicodeOld
    decodedNew = decodeLiteralUnicodeEscapes(decodedNew) ?? decodedNew
    labels.push('Unicode escapes (`\\uXXXX`)')
  }

  if (labels.length === 0) return null
  return {
    oldString: decodedOld,
    newString: decodedNew,
    label: labels.join(' and '),
  }
}

/**
 * Detect the "literal \uXXXX in old_string" anti-pattern and return a
 * targeted hint.
 *
 * Real-world failure mode (seen in agent traces converting straight
 * quotes to curly quotes): the model writes `"old_string": "\u201d"` and
 * believes the tool will reverse-decode `\u201d` into U+201D before
 * matching. It doesn't — `old_string` is a raw byte comparator, so the
 * tool looks for the literal 6 characters `\`, `u`, `2`, `0`, `1`, `d`,
 * fails, and the agent then "concludes" JSON did a double-escape, which
 * is incorrect.
 *
 * This helper checks: does `oldString` contain a literal `\uXXXX` (or
 * `\u{...}`) substring whose JSON-decoded form is present in `content`?
 * If yes, return a leading-space hint that the message can prepend to
 * the standard "not found" body. Otherwise return `''`.
 *
 * Exported so the validator-side path can reuse it after a future
 * file-aware refactor; the immediate caller is the substring matcher
 * inside this file.
 */
export function findLiteralUnicodeEscapeHint(
  content: string,
  oldString: string,
): string {
  const decoded = decodeLiteralUnicodeEscapes(oldString)
  if (decoded === null) return ''
  if (!content.includes(decoded)) return ''

  const escapeMatch = oldString.match(/\\u\{[0-9a-fA-F]+\}|\\u[0-9a-fA-F]{4}/)
  const sampleEscape = escapeMatch?.[0] ?? ''
  let sampleChar = ''
  let sampleCodePoint = -1
  if (sampleEscape) {
    try {
      sampleCodePoint = sampleEscape.startsWith('\\u{')
        ? parseInt(sampleEscape.slice(3, -1), 16)
        : parseInt(sampleEscape.slice(2), 16)
      if (Number.isFinite(sampleCodePoint) && sampleCodePoint >= 0 && sampleCodePoint <= 0x10ffff) {
        sampleChar = String.fromCodePoint(sampleCodePoint)
      }
    } catch {
      sampleChar = ''
      sampleCodePoint = -1
    }
  }
  const codePointLabel =
    sampleCodePoint >= 0
      ? `U+${sampleCodePoint.toString(16).toUpperCase().padStart(4, '0')}`
      : ''
  const sampleDescriptor =
    sampleEscape && sampleChar
      ? ` (e.g. the literal sequence ${JSON.stringify(sampleEscape)} represents the character ${JSON.stringify(sampleChar)}${codePointLabel ? ` / ${codePointLabel}` : ''})`
      : ''
  // One copy-paste-ready corrected value, rendered with REAL glyphs.
  // Deliberately no "you can write \uXXXX inside the JSON string" advice:
  // that instruction is provider-dependent (structured function-calling
  // channels have no model-controlled JSON-syntax layer) and in practice
  // taught models to double-escape, reproducing this exact failure.
  const correctedPreview =
    decoded.length <= 200
      ? ` Retry with this exact value (real characters, not escape text): "old_string": ${JSON.stringify(decoded)}.`
      : ` Retry with the decoded characters (e.g. ${JSON.stringify(sampleChar)} instead of the text ${JSON.stringify(sampleEscape)}).`
  return (
    ` Diagnosis: your old_string contains a literal \`\\uXXXX\` Unicode-escape sequence${sampleDescriptor}, ` +
    'and the JSON-decoded form of your old_string DOES exist in the file. ' +
    'edit_file does NOT decode Unicode escapes — `old_string` is a raw byte comparator, so the 6 ASCII ' +
    'characters `\\`, `u`, and 4 hex digits will never match a 1-character Unicode glyph in the file. ' +
    'Fix: paste the actual target character (copy it from read_file output).' +
    correctedPreview
  )
}

/**
 * Token-similarity fuzzy suggestions for "old_string not found" errors.
 *
 * When the agent's `old_string` does not appear in the file, we locate the
 * file lines whose word-token overlap with the first non-empty trimmed line
 * of `old_string` is highest. This turns the classic "read wrong range →
 * edit fails → read again" ping-pong into a one-shot correction: the error
 * message now points the agent at the actual lines to look at.
 */
function tokenizeForFuzzy(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9_$]+/g) ?? []
}

export function findFuzzyOldStringHints(
  content: string,
  oldString: string,
  maxHints = 3,
): string {
  const contentLines = content.split(/\r?\n/)
  const oldLines = oldString.split(/\r?\n/)
  const anchor = oldLines.find((ln) => ln.trim().length > 0)?.trim() ?? ''
  if (!anchor) return ''
  const anchorTokens = new Set(tokenizeForFuzzy(anchor))
  if (anchorTokens.size === 0) return ''

  type Hit = { line1: number; excerpt: string; score: number }
  const hits: Hit[] = []

  for (let i = 0; i < contentLines.length; i++) {
    const raw = contentLines[i]
    if (raw === undefined) continue
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    const lineTokens = new Set(tokenizeForFuzzy(trimmed))
    if (lineTokens.size === 0) continue
    let intersect = 0
    for (const t of lineTokens) if (anchorTokens.has(t)) intersect++
    if (intersect === 0) continue
    const union = anchorTokens.size + lineTokens.size - intersect
    const jaccard = intersect / union
    // Coverage of the anchor — a line containing most of the anchor's tokens is
    // more useful than a line sharing only one or two common identifiers.
    const coverage = intersect / anchorTokens.size
    const score = jaccard * 0.4 + coverage * 0.6
    if (score < 0.35) continue
    hits.push({
      line1: i + 1,
      excerpt: trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed,
      score,
    })
  }

  hits.sort((a, b) => b.score - a.score)
  const top = hits.slice(0, maxHints)
  if (top.length === 0) return ''

  const lines = top.map(
    (h) => `  • line ${h.line1} (similarity ${(h.score * 100).toFixed(0)}%): ${h.excerpt}`,
  )
  const bestScore = top[0].score
  // Count how many candidate lines have *exact* anchor matches — the first
  // non-empty line of old_string matches the file verbatim. Threshold 0.98
  // (not 1.0) absorbs floating-point / whitespace-normalisation fuzz; in
  // practice our scoring only yields 1.0 or <0.8 for anchors, so the cutoff
  // is unambiguous.
  const EXACT_ANCHOR_THRESHOLD = 0.98
  const exactAnchorHits = hits.filter((h) => h.score >= EXACT_ANCHOR_THRESHOLD)

  // Diagnostic reasoning (in order of specificity):
  //
  //   1. bestScore < 0.55             → "wrong file / paraphrase" (pre-existing)
  //   2. exactAnchorHits.length > 1   → "anchor not unique, add surrounding context"
  //   3. exactAnchorHits.length == 1  → "self-inflicted drift — RE-READ first"
  //      This is the case the user kept hitting in real sessions: multiple
  //      successful edits on one file within a single agentic loop, then a
  //      subsequent edit whose old_string was composed from a now-stale
  //      mental model of the file. The anchor matches because the model
  //      remembered the target line verbatim, but the lines around it have
  //      shifted due to the earlier edits and no longer match old_string.
  //      The fix is surgical and always the same: re-run read_file.
  //   4. otherwise                    → generic "if one of these is your target, paste…"
  let diagnosticTail = ''
  if (bestScore < 0.55) {
    diagnosticTail =
      '\nNote: the best match is only ' +
      `${(bestScore * 100).toFixed(0)}% similar — you are likely reading from ` +
      'the WRONG file or the WRONG version of the buffer. Run read_file on ' +
      'the actual target before retrying; do not paraphrase.'
  } else if (exactAnchorHits.length > 1) {
    const linesList = exactAnchorHits.map((h) => h.line1).join(', ')
    diagnosticTail =
      `\nNote: your old_string's first line matches the file EXACTLY at ` +
      `${exactAnchorHits.length} locations (lines ${linesList}). ` +
      'old_string is therefore ambiguous — either extend it with a few more ' +
      'distinctive surrounding lines so exactly one location matches, or set ' +
      '`replace_all: true` if you intended to change every occurrence.'
  } else if (exactAnchorHits.length === 1) {
    const anchorLine = exactAnchorHits[0].line1
    diagnosticTail =
      `\nNote: your old_string's first line matches line ${anchorLine} EXACTLY, ` +
      'but the lines after it do not match the file. This is almost always ' +
      '**self-inflicted drift**: earlier edit_file / write_file calls in this ' +
      'session have mutated the lines around your target, so the snippet you ' +
      'composed from a stale read is no longer byte-accurate.\n' +
      `Fix: run \`read_file\` on this file AGAIN to get a fresh view around ` +
      `line ${anchorLine}, then recompose old_string from that fresh output. ` +
      'Do NOT retry with whitespace / typographical tweaks — the bytes genuinely differ.'
  } else {
    // 4. bestScore is 0.55-0.97 with NO exact anchor hit. The first
    //    non-empty line of old_string token-overlaps the suggested line
    //    substantially, but doesn't match verbatim. The two dominant real
    //    causes we've seen in production:
    //
    //    (a) **Stale composition after a failed write.** A previous
    //        edit_file / write_file on this path returned RENAME_FAILED
    //        (Windows EPERM from browser/AV/sync lock) or HASH_MISMATCH.
    //        The disk is unchanged, but the agent composed this
    //        old_string from the "what I tried to write" buffer instead
    //        of re-reading. Token-level overlap is high (same words),
    //        order and surrounding lines diverge.
    //
    //    (b) **Wrong-region copy from a multi-area read.** The agent
    //        read a long window covering several similar code blocks and
    //        spliced lines from two different blocks into one old_string.
    //        Each individual line shares vocabulary with the file but
    //        the composite doesn't exist anywhere on disk.
    //
    //    Either way the right next action is the same: re-read the
    //    region around the suggested line and recompose old_string from
    //    fresh, contiguous, byte-accurate output. Whitespace tweaks
    //    won't help — the bytes genuinely differ.
    const bestLine = top[0].line1
    diagnosticTail =
      `\nNote: best candidate is ${(bestScore * 100).toFixed(0)}% similar — your old_string ` +
      `partially overlaps line ${bestLine} but isn't byte-accurate. Two common causes:\n` +
      `  (a) A previous edit_file / write_file call on this path failed ` +
      `(e.g. RENAME_FAILED on Windows when a browser / antivirus held the ` +
      `file). The disk is unchanged but you composed this old_string from ` +
      `the would-be-written content. Re-read the file to see actual bytes.\n` +
      `  (b) You stitched lines from two different regions of a wide ` +
      `read_file window — the composite never existed on disk verbatim.\n` +
      `Fix: re-run \`read_file\` around line ${bestLine}, then recompose ` +
      `old_string from that fresh output. Do NOT retry with whitespace ` +
      `or quote tweaks — the bytes genuinely differ.`
  }

  return (
    ` The closest match(es) on disk:\n${lines.join('\n')}\n` +
    'If one of these is your intended target, copy the exact on-disk text ' +
    '(including whitespace) into old_string and retry; otherwise read_file ' +
    'around those lines for accurate context.' +
    diagnosticTail
  )
}

/** Lines of context required around the edited span for read-before-edit (see readFileState). */
export const EDIT_READ_MARGIN_LINES = 100

function line1AtCharIndex(content: string, charIndex: number): number {
  if (charIndex <= 0) return 1
  return content.slice(0, charIndex).split(/\r?\n/).length
}

/**
 * Line bounds (1-based, inclusive) of the substring that {@link computeFileEditResult} would
 * replace for a single-match edit, plus whether a partial read_file window can satisfy the gate.
 * `replace_all` and newline-normalized matches require a full-file read for the gate.
 */
export function getEditAffectedLineBounds1Based(
  content: string,
  oldString: string,
  newString: string,
  options?: { replaceAll?: boolean },
):
  | { ok: true; minLine1: number; maxLine1: number; requiresFullRead: boolean }
  | { ok: false; error: string } {
  const { body: cBody } = stripUtf8Bom(content)
  const { body: oldBody } = stripUtf8Bom(oldString)
  const { body: newBody } = stripUtf8Bom(newString)

  const fileEffectivelyEmpty = cBody.trim() === ''
  const oldIsOnlyWhitespace = oldBody.length > 0 && oldBody.trim() === ''
  const replaceAll = options?.replaceAll === true

  if (replaceAll) {
    return { ok: true, minLine1: 1, maxLine1: 1, requiresFullRead: true }
  }

  if (oldBody === '') {
    if (!fileEffectivelyEmpty) {
      return {
        ok: false,
        error:
          'Cannot use empty old_string when the file already has content. Provide a unique old_string to replace, or use edit_file with a concrete old_string for a full replacement.',
      }
    }
    return { ok: true, minLine1: 1, maxLine1: 1, requiresFullRead: true }
  }

  if (oldIsOnlyWhitespace && fileEffectivelyEmpty) {
    return { ok: true, minLine1: 1, maxLine1: 1, requiresFullRead: true }
  }

  for (const oldTry of collectEditOldStringVariants(oldBody)) {
    const resolvedRaw = resolveOldStringInFile(cBody, oldTry)
    if (resolvedRaw !== null) {
      const index = cBody.indexOf(resolvedRaw)
      if (index !== -1) {
        let effectiveOld = extendOldThroughFollowingNewline(cBody, index, resolvedRaw, newBody)
        effectiveOld = expandOldWhenNewStringEmpty(cBody, index, effectiveOld, newBody)
        if (cBody.indexOf(effectiveOld, index + effectiveOld.length) !== -1) {
          return {
            ok: false,
            error:
              'The old_string appears multiple times. Make it more specific or set replace_all: true.',
          }
        }
        const start = index
        const endEx = start + effectiveOld.length
        const minLine1 = line1AtCharIndex(cBody, start)
        const maxLine1 = line1AtCharIndex(cBody, endEx - 1)
        return { ok: true, minLine1, maxLine1, requiresFullRead: false }
      }
    }

    const nContent = normalizeNewlinesForEdit(cBody)
    const nOld = normalizeNewlinesForEdit(oldTry)
    const nNew = normalizeNewlinesForEdit(newBody)
    const resolvedN = resolveOldStringInFile(nContent, nOld)
    if (resolvedN !== null) {
      const nIndex = nContent.indexOf(resolvedN)
      if (nIndex !== -1) {
        let effectiveOldN = extendOldThroughFollowingNewline(nContent, nIndex, resolvedN, nNew)
        effectiveOldN = expandOldWhenNewStringEmpty(nContent, nIndex, effectiveOldN, nNew)
        if (nContent.indexOf(effectiveOldN, nIndex + effectiveOldN.length) !== -1) {
          return {
            ok: false,
            error:
              'The old_string appears multiple times. Make it more specific or set replace_all: true.',
          }
        }
        return { ok: true, minLine1: 1, maxLine1: 1, requiresFullRead: true }
      }
    }
  }

  // Mirror computeFileEditResult's whitespace-tolerant fallback: the match
  // spans a normalized buffer, so (like the CRLF-normalized branch) require
  // a full-file read for the gate rather than trusting window line numbers.
  for (const oldTry of collectEditOldStringVariants(oldBody)) {
    const plan = computeWhitespaceTolerantEditPlan(cBody, oldTry, newBody)
    if (plan.kind === 'match' || plan.kind === 'ambiguous') {
      return { ok: true, minLine1: 1, maxLine1: 1, requiresFullRead: true }
    }
  }

  // Mirror computeFileEditResult's literal-escape decode retry so the
  // read-window gate agrees with what the edit itself will match.
  const decoded = decodeLiteralEditStrings(oldBody, newString)
  if (decoded !== null && editOldStringLocatable(cBody, decoded.oldString, false)) {
    return getEditAffectedLineBounds1Based(
      content,
      decoded.oldString,
      decoded.newString,
      options,
    )
  }

  return {
    ok: false,
    error:
      `The old_string was not found in the file.` +
      findLiteralUnicodeEscapeHint(cBody, oldBody) +
      findFuzzyOldStringHints(cBody, oldBody),
  }
}

// ---------------------------------------------------------------------------
// P0 — `expectedLineRange` soft anchor (cross-boundary edit guard)
//
// Goal: defend against the "model glued the regex closing of one function
// with the next function's signature into a single oldString" failure mode.
// The tool already applies the model's edit by-the-book whenever oldString
// matches exactly once — but that exact match can span across logical
// boundaries the model itself didn't intend (boundary-blindness is
// fundamentally outside what byte matching can detect).
//
// The guard is OPT-IN: when the model declares an `expectedLineRange`, we
// re-compute the actual hit lines and reject if any hit goes outside that
// window. We do NOT widen / narrow / auto-correct the model's intent — the
// guard is a tripwire, not a fixer. Failures return the actual hit lines
// alongside the declared window so the next retry can either tighten the
// oldString or correct the range.
//
// This function is INTENTIONALLY independent of getEditAffectedLineBounds1Based:
//   - read-before-edit gate uses bounds for a different purpose (window
//     sufficiency check), and its replaceAll/normalized short-circuits are
//     correct for that use case.
//   - boundary guard MUST scan every hit (replaceAll), MUST refuse on the
//     normalized fallback path (line numbers there refer to a *normalized*
//     buffer the model never saw, so any range comparison is meaningless).
// ---------------------------------------------------------------------------

export type ExpectedLineRange = readonly [number, number]

export type ExpectedLineRangeViolationResult =
  | { ok: true }
  | {
      ok: false
      /** Stable code consumed by the tool / tests / future hooks. */
      code: 'OUT_OF_WINDOW' | 'NOT_FOUND' | 'NORMALIZED_HIT_INCOMPATIBLE' | 'INTERNAL_ERROR'
      /** Human-readable, model-friendly message. */
      message: string
      /** Per-occurrence hit ranges that were inspected (1-based, inclusive). */
      hits?: Array<{ minLine1: number; maxLine1: number }>
    }

/**
 * Validate that every hit of `oldString` in `content` falls within
 * `expectedLineRange` (1-based, inclusive). Mirrors the matching behavior of
 * {@link computeFileEditResult} for the raw / curly-quote-normalized branch
 * but rejects on the newline-normalized branch (line numbers there are
 * meaningless to the model).
 *
 * Caller contract:
 *   - `content` MUST be the post-lock disk buffer (same buffer
 *     {@link computeFileEditResult} will later read), so the hit ranges
 *     reported here are exactly what the edit will mutate.
 *   - `expectedLineRange` shape is validated in `validateEditTool.ts`; this
 *     function assumes a well-formed `[start, end]` (start>=1, start<=end).
 */
export function computeExpectedLineRangeViolation(
  content: string,
  oldString: string,
  newString: string,
  options: { replaceAll?: boolean; expectedLineRange: ExpectedLineRange },
): ExpectedLineRangeViolationResult {
  const [expectedStart, expectedEnd] = options.expectedLineRange
  const replaceAll = options.replaceAll === true

  const { body: cBody } = stripUtf8Bom(content)
  const { body: oldBody } = stripUtf8Bom(oldString)
  const { body: newBody } = stripUtf8Bom(newString)

  // Empty oldString edits create a brand-new file's content / replace an
  // empty file — the line-range concept doesn't apply since there's no
  // pre-existing line to anchor against. Treat as "out of scope": the
  // boundary guard simply doesn't run.
  if (oldBody === '') return { ok: true }

  // Compute ALL raw hits (no curly-quote/normalize gymnastics here — those
  // bring back ambiguity about *which* normalization the model is anchoring
  // its expected range against). If raw match fails, fall back to a single
  // round of variants, but only ones that produce hits in the original
  // (un-normalized) `cBody`. Newline-normalized matches use a *different*
  // buffer and are rejected with a dedicated error code below.
  const hits: Array<{ start: number; end: number }> = []

  const tryCollectIn = (haystack: string, needle: string): boolean => {
    if (haystack !== cBody) return false
    if (!needle) return false
    let cursor = 0
    let foundAny = false
    while (cursor <= haystack.length) {
      const idx = haystack.indexOf(needle, cursor)
      if (idx === -1) break
      foundAny = true
      let effective = extendOldThroughFollowingNewline(haystack, idx, needle, newBody)
      effective = expandOldWhenNewStringEmpty(haystack, idx, effective, newBody)
      hits.push({ start: idx, end: idx + effective.length })
      // Single-shot mode collects only the first hit; replaceAll keeps going.
      if (!replaceAll) break
      // Advance past the matched span to avoid overlapping double-counts —
      // matches the conservative non-overlapping policy used in
      // String.prototype.replaceAll for substrings.
      cursor = idx + Math.max(needle.length, 1)
    }
    return foundAny
  }

  let collected = false
  for (const variant of collectEditOldStringVariants(oldBody)) {
    const resolved = resolveOldStringInFile(cBody, variant)
    if (resolved !== null) {
      collected = tryCollectIn(cBody, resolved)
      if (collected) break
    }
  }

  if (!collected) {
    // Try the newline-normalized branch — if the only way to match is via
    // EOL normalization, the model's oldString uses a different EOL than
    // disk, and `expectedLineRange` becomes meaningless. We reject up-front
    // so the next retry can paste verbatim from the file's actual EOL.
    for (const variant of collectEditOldStringVariants(oldBody)) {
      const nContent = normalizeNewlinesForEdit(cBody)
      const nOld = normalizeNewlinesForEdit(variant)
      const resolvedN = resolveOldStringInFile(nContent, nOld)
      if (resolvedN !== null && nContent.indexOf(resolvedN) !== -1) {
        return {
          ok: false,
          code: 'NORMALIZED_HIT_INCOMPATIBLE',
          message:
            'expectedLineRange cannot be checked against this old_string because it only ' +
            'matches after CRLF/LF normalization. Re-paste old_string with the file\'s ' +
            'actual line endings (read_file output already has them) and retry, OR omit ' +
            'expectedLineRange to fall back to legacy single-match behaviour.',
        }
      }
    }
    // Genuinely not found — let the regular edit path produce its own
    // "not found + fuzzy hints" error so we don't double up on suggestions.
    return { ok: true }
  }

  if (hits.length === 0) {
    // Defensive: should be impossible after `collected` is true, but keep
    // the failure mode explicit for tests / future refactors.
    return { ok: true }
  }

  const violations: Array<{ minLine1: number; maxLine1: number }> = []
  const hitRanges: Array<{ minLine1: number; maxLine1: number }> = []
  for (const hit of hits) {
    const minLine1 = line1AtCharIndex(cBody, hit.start)
    const maxLine1 = line1AtCharIndex(cBody, Math.max(hit.end - 1, hit.start))
    hitRanges.push({ minLine1, maxLine1 })
    if (minLine1 < expectedStart || maxLine1 > expectedEnd) {
      violations.push({ minLine1, maxLine1 })
    }
  }

  if (violations.length === 0) return { ok: true }

  // Build a tight, action-oriented error. We intentionally NOT include the
  // matched bytes (could be huge); we surface just the line ranges plus
  // the next-step the model should take.
  const violationDescriptions = violations
    .slice(0, 3)
    .map((v) =>
      v.minLine1 === v.maxLine1
        ? `line ${v.minLine1}`
        : `lines ${v.minLine1}-${v.maxLine1}`,
    )
  const more =
    violations.length > 3 ? ` (+${violations.length - 3} more out-of-window hit${violations.length - 3 === 1 ? '' : 's'})` : ''
  const declared = `expectedLineRange [${expectedStart}, ${expectedEnd}]`
  const totalHits = replaceAll ? `${hits.length} match${hits.length === 1 ? '' : 'es'} total` : '1 match'
  const message =
    `Edit refused: ${totalHits}, but ${violations.length} of them fall outside ${declared}. ` +
    `Out-of-window: ${violationDescriptions.join('; ')}${more}. ` +
    `This usually means old_string accidentally bridged a logical boundary — e.g. the closing ` +
    `bytes of one function and the signature of the next. ` +
    `Next step: either (a) shorten old_string so the match stays within ${declared}, or ` +
    `(b) re-read the file and update expectedLineRange to reflect the true intended span.`

  return {
    ok: false,
    code: 'OUT_OF_WINDOW',
    message,
    hits: hitRanges,
  }
}

// ---------------------------------------------------------------------------
// upstream FileEditTool `normalizeFileEditInput`: trim new_string lines + desanitize old_string
// ---------------------------------------------------------------------------

/**
 * Strips trailing whitespace from each line while preserving line endings (CRLF / LF / CR).
 * Ported from upstream FileEditTool/utils.
 */
export function stripTrailingWhitespace(str: string): string {
  const lines = str.split(/(\r\n|\n|\r)/)
  let result = ''
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i]
    if (part !== undefined) {
      if (i % 2 === 0) {
        result += part.replace(/\s+$/, '')
      } else {
        result += part
      }
    }
  }
  return result
}

/**
 * Edit-aware variant of {@link stripTrailingWhitespace}.
 *
 * The plain strip in `normalizeFileEditInput` exists because models often
 * emit code with spurious trailing spaces on intermediate lines (a known
 * generation artefact). It does NOT, however, distinguish that case from
 * deliberate structural trailing whitespace — e.g. `old='\tcol2\t'`,
 * `new='\tNEW\t'`, where the trailing tab is a column separator the user
 * is explicitly preserving (test E17). The naive strip silently rewrote
 * `\tNEW\t` to `\tNEW`, corrupting tab-delimited / TSV-like files.
 *
 * Heuristic: if `new_string`'s last-line trailing whitespace exactly
 * mirrors `old_string`'s last-line trailing whitespace AND that whitespace
 * is non-empty, the model is intentionally preserving structure — keep
 * those bytes. Intermediate-line strip is unchanged, so the original
 * "models add spurious trailing spaces in multi-line code" defence still
 * applies.
 */
export function stripTrailingWhitespaceForEdit(
  oldString: string,
  newString: string,
): string {
  const oldLines = oldString.split(/\r\n|\n|\r/)
  const oldLastLine = oldLines[oldLines.length - 1] ?? ''
  const oldTrail = oldLastLine.match(/[\t ]+$/)?.[0] ?? ''

  // split() with a capturing group alternates content (even idx) / separator (odd idx).
  const parts = newString.split(/(\r\n|\n|\r)/)
  let result = ''
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === undefined) continue
    if (i % 2 === 1) {
      result += part
      continue
    }
    const isLastContent = i === parts.length - 1
    if (isLastContent) {
      const newTrail = part.match(/[\t ]+$/)?.[0] ?? ''
      if (newTrail !== '' && newTrail === oldTrail) {
        result += part
        continue
      }
    }
    result += part.replace(/\s+$/, '')
  }
  return result
}

/** API-sanitized tokens the model may echo instead of real tags (upstream DESANITIZATIONS). */
const DESANITIZATIONS: Record<string, string> = {
  '<fnr>': '<function_results>',
  '<n>': '<name>',
  '</n>': '</name>',
  '<o>': '<output>',
  '</o>': '</output>',
  '<e>': '<error>',
  '</e>': '</error>',
  '<s>': '<system>',
  '</s>': '</system>',
  '<r>': '<result>',
  '</r>': '</result>',
  '< META_START >': '<META_START>',
  '< META_END >': '<META_END>',
  '< EOT >': '<EOT>',
  '< META >': '<META>',
  '< SOS >': '<SOS>',
  '\n\nH:': '\n\nHuman:',
  '\n\nA:': '\n\nAssistant:',
}

export function desanitizeMatchString(matchString: string): {
  result: string
  appliedReplacements: Array<{ from: string; to: string }>
} {
  let result = matchString
  const appliedReplacements: Array<{ from: string; to: string }> = []
  for (const [from, to] of Object.entries(DESANITIZATIONS)) {
    const beforeReplace = result
    result = result.replaceAll(from, to)
    if (beforeReplace !== result) {
      appliedReplacements.push({ from, to })
    }
  }
  return { result, appliedReplacements }
}

export type NormalizedFileEdit = {
  old_string: string
  new_string: string
  replace_all?: boolean
}

/**
 * Normalize FileEdit-style payloads before matching (upstream `normalizeFileEditInput`).
 *
 * - Non-`.md`/`.mdx`: strip trailing whitespace from each line of `new_string` (models often add spaces).
 * - If `old_string` is not in `fileContent`, try de-sanitized variants and mirror replacements into `new_string`.
 *
 * When `fileContent` is `undefined` (file not read / missing — upstream ENOENT path), returns edits unchanged.
 */
export function normalizeFileEditInput(options: {
  file_path: string
  fileContent: string | undefined
  edits: NormalizedFileEdit[]
}): { file_path: string; edits: NormalizedFileEdit[] } {
  const { file_path, edits } = options
  const fileContent = options.fileContent

  if (edits.length === 0) {
    return { file_path, edits: [] }
  }

  if (fileContent === undefined) {
    return { file_path, edits: edits.map((e) => ({ ...e })) }
  }

  const isMarkdown = /\.(md|mdx)$/i.test(file_path)

  return {
    file_path,
    edits: edits.map(({ old_string, new_string, replace_all }) => {
      const normalizedNewString = isMarkdown
        ? new_string
        : stripTrailingWhitespaceForEdit(old_string, new_string)

      if (fileContent.includes(old_string)) {
        return {
          old_string,
          new_string: normalizedNewString,
          replace_all,
        }
      }

      const { result: desanitizedOldString, appliedReplacements } = desanitizeMatchString(old_string)
      if (fileContent.includes(desanitizedOldString)) {
        let desanitizedNewString = normalizedNewString
        for (const { from, to } of appliedReplacements) {
          desanitizedNewString = desanitizedNewString.replaceAll(from, to)
        }
        return {
          old_string: desanitizedOldString,
          new_string: desanitizedNewString,
          replace_all,
        }
      }

      return {
        old_string,
        new_string: normalizedNewString,
        replace_all,
      }
    }),
  }
}

/** Single-edit convenience wrapper around {@link normalizeFileEditInput}. */
export function normalizeOneFileEdit(
  file_path: string,
  fileContent: string | undefined,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
): { oldString: string; newString: string; replaceAll: boolean } {
  const e = normalizeFileEditInput({
    file_path,
    fileContent,
    edits: [{ old_string: oldString, new_string: newString, replace_all: replaceAll }],
  }).edits[0]!
  return {
    oldString: e.old_string,
    newString: e.new_string,
    replaceAll: e.replace_all === true,
  }
}

// ---------------------------------------------------------------------------
// Multi-edit batch — 1:1 port of upstream FileEditTool/utils.ts
// `getPatchForEdits` (the array-capable variant that was internal-only on the
// upstream side, never surfaced as its own tool). Same loop body, same safety
// rules, same error wording — but the per-edit primitive is our richer
// {@link computeFileEditResult} (variant collection + quote/CRLF/BOM
// normalisation + fuzzy hints) instead of upstream's simpler
// `applyEditToFile`. The upstream invariants this preserves:
//
//   1. Empty-file + single `{old:'', new:''}` is a valid no-op fast path.
//   2. Before each edit, its `old_string` (trailing newlines stripped) must
//      NOT overlap the **newly-authored segment** of ANY previously-applied
//      edit. This catches "edit N rewrites what edit M<N just authored",
//      which would silently clobber the earlier edit's intent.
//
//      Deliberate refinement over upstream (2026-06 audit): upstream
//      rejects whenever `old_string` is a substring of a previous
//      `new_string` AT ALL. That over-fires on the most common batch
//      shape models produce — adjacent edits that each carry a few
//      unchanged context lines. Edit #1's new_string then contains
//      verbatim-rewritten context bytes, and edit #2 targeting those
//      same (pre-existing!) bytes tripped the guard even though the two
//      edits don't conflict; reordering never helps and the only escape
//      was splitting the batch (an extra round-trip). We instead trim
//      the common prefix/suffix between the previous edit's old/new
//      strings to isolate its *changed core* — the bytes it actually
//      authored — and reject only when the new edit's old_string
//      intersects that core. Touching re-written context is allowed;
//      ambiguity is still caught downstream by the single-occurrence
//      uniqueness gate in `computeFileEditResult`.
//   3. After applying each edit, if the file content did not actually
//      change, the whole batch fails — a no-op edit in the middle is almost
//      always a model bug we want to surface, not silently swallow.
//   4. After applying ALL edits, the final content must differ from the
//      original. A batch that round-trips to identical bytes is rejected.
//
// Unlike the single-edit path, multi-edit does NOT support per-edit
// `expectedLineRange` or `hashAnchor`: after the first in-memory mutation
// the line numbers / line hashes shift, so those anchors are meaningful
// only for the first edit. We rely on the file-level `baseReadId` content
// hash anchor (validated by the caller) as the single source of truth for
// "the bytes the agent saw really are still on disk".
// ---------------------------------------------------------------------------

export type MultiEditOne = {
  oldString: string
  newString: string
  replaceAll?: boolean
  /**
   * Optional positional cross-check (2026-07), `[startLine, endLine]` 1-based
   * inclusive, in the coordinates of the PRE-BATCH file — i.e. the read_file
   * output the model composed this batch from. Validated by a pre-pass
   * against the ORIGINAL buffer before any edit applies (see the guard in
   * {@link computeFileEditResultMulti}); deliberately NOT re-checked against
   * the shifting mid-batch buffer, whose line numbers the model never saw.
   */
  expectedLineRange?: ExpectedLineRange
}

export type MultiEditSuccess = {
  success: true
  newContent: string
  appliedEdits: number
  /** Advisory warnings from individual edits, prefixed `Edit #N:`. See {@link FileEditComputeResult}. */
  warnings?: string[]
}

export type MultiEditFailure = {
  success: false
  /** 0-based index of the edit that triggered the failure. -1 for batch-level errors (empty array, final no-op). */
  failedEditIndex: number
  error: string
}

export type MultiEditResult = MultiEditSuccess | MultiEditFailure

/**
 * Locate the *changed core* of an edit inside its `newString`: trim the
 * longest common prefix and (non-overlapping) common suffix between
 * `oldString` and `newString`; what remains — `newString[start, end)` —
 * is the segment the edit actually authored. Context lines the model
 * carried for uniqueness re-write byte-identical bytes and fall entirely
 * inside the trimmed prefix/suffix, so they are NOT part of the core.
 *
 * A pure deletion (or an edit whose normalized old/new only differ by
 * removed bytes) yields an empty interval `start === end` — it authored
 * nothing, so nothing in it can be clobbered.
 */
function changedCoreOfEdit(
  oldString: string,
  newString: string,
): { start: number; end: number } {
  const maxPrefix = Math.min(oldString.length, newString.length)
  let p = 0
  while (p < maxPrefix && oldString.charCodeAt(p) === newString.charCodeAt(p)) p++
  const maxSuffix = maxPrefix - p
  let s = 0
  while (
    s < maxSuffix &&
    oldString.charCodeAt(oldString.length - 1 - s) ===
      newString.charCodeAt(newString.length - 1 - s)
  ) {
    s++
  }
  return { start: p, end: newString.length - s }
}

/**
 * Minimal contiguous change envelope between `prev` and `next`: the half-open
 * range `[start, end)` of `prev` that was replaced, plus the length of the
 * inserted text in `next`. Computed by trimming the longest common prefix and
 * (non-overlapping) common suffix. The authored bytes in `next` therefore
 * occupy `[start, start + insertedLen)`.
 *
 * For a single contiguous edit this is exact. For a replaceAll that touched
 * several disjoint spots it collapses to one over-broad envelope — callers
 * must NOT use it for replaceAll edits (see the seam guard in
 * {@link computeFileEditResultMulti}).
 */
function contiguousChangeSpan(
  prev: string,
  next: string,
): { start: number; end: number; insertedLen: number } {
  const max = Math.min(prev.length, next.length)
  let p = 0
  while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++
  let s = 0
  while (
    s < max - p &&
    prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)
  ) {
    s++
  }
  return { start: p, end: prev.length - s, insertedLen: next.length - p - s }
}

/** True when any occurrence of `needle` inside `haystack` intersects the
 *  half-open interval `[coreStart, coreEnd)`. */
function occurrenceIntersectsCore(
  haystack: string,
  needle: string,
  coreStart: number,
  coreEnd: number,
): boolean {
  if (coreStart >= coreEnd) return false
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    if (idx < coreEnd && idx + needle.length > coreStart) return true
    idx = haystack.indexOf(needle, idx + 1)
  }
  return false
}

/**
 * Apply a batch of edits to file content in memory. Pure function — does no
 * I/O. See the comment block above for invariants.
 *
 * `oldStringToCheck = edit.oldString.replace(/\n+$/, '')` mirrors
 * upstream line 299 verbatim: trailing newlines are stripped before the
 * substring check so that an edit which ends in `\n` is not falsely flagged
 * as overlapping with a previous new_string that happens to share a
 * non-terminal block.
 */
export function computeFileEditResultMulti(
  content: string,
  edits: ReadonlyArray<MultiEditOne>,
): MultiEditResult {
  if (edits.length === 0) {
    return {
      success: false,
      failedEditIndex: -1,
      error: 'multi_edit_file: `edits` array is empty. Provide at least one edit.',
    }
  }

  // upstream special case (utils.ts lines 275-294): empty file + single
  // `{old:'', new:''}` is a valid no-op. We preserve the same fast path so
  // the behaviour matches upstream byte-for-byte when this exact shape is
  // submitted.
  if (
    content === '' &&
    edits.length === 1 &&
    edits[0]!.oldString === '' &&
    edits[0]!.newString === ''
  ) {
    return { success: true, newContent: '', appliedEdits: 1 }
  }

  // ── Per-edit positional cross-check pre-pass (2026-07) ──
  // Real-world failure this guards (weak-model trace): a batch edit whose
  // oldString uniquely matched a location DIFFERENT from the one the model
  // intended — content meant for "line 8" landing at "line 10" because the
  // intended target drifted (stale memory) while a similar region matched
  // exactly. Pure content addressing cannot see this; a declared line range
  // can (span's "guard + positional cross-check" pattern).
  //
  // The check runs against the ORIGINAL pre-batch buffer, deliberately:
  //   - The model's declared ranges come from its read_file output, whose
  //     coordinates ARE the pre-batch buffer. Validating mid-batch (after
  //     earlier edits shifted lines) would compare against numbers the model
  //     never saw — guaranteed false rejections.
  //   - NOT_FOUND in the original buffer → skip silently: the edit may
  //     legitimately target text an earlier edit in this batch authored;
  //     the sequential applier below judges it (and its clobber guards run).
  //   - NORMALIZED_HIT_INCOMPATIBLE (CRLF/LF-only match) → skip: line
  //     numbers survive EOL normalization, but the violation checker refuses
  //     that branch by design for single edits; in batch we degrade to
  //     "no cross-check" rather than rejecting an otherwise valid edit.
  //   - OUT_OF_WINDOW → reject the WHOLE batch before anything applies
  //     (atomicity preserved; the model retries with a corrected oldString
  //     or range, or re-reads).
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!
    if (!edit.expectedLineRange) continue
    const violation = computeExpectedLineRangeViolation(
      content,
      edit.oldString,
      edit.newString,
      {
        replaceAll: edit.replaceAll === true,
        expectedLineRange: edit.expectedLineRange,
      },
    )
    if (!violation.ok && violation.code === 'OUT_OF_WINDOW') {
      return {
        success: false,
        failedEditIndex: i,
        error:
          `Edit #${i + 1}: ${violation.message} ` +
          `(Range checked against the PRE-BATCH file — the same line numbers your read_file showed. ` +
          `No edit from this batch was applied.)`,
      }
    }
  }

  let updatedFile = content
  const appliedEditRecords: Array<{
    newString: string
    coreStart: number
    coreEnd: number
  }> = []
  // Seam-spanning clobber guard: contiguous range each prior edit authored, in
  // the CURRENT `updatedFile` coordinates. Disabled once a replaceAll edit is
  // applied (its disjoint changes can't be modelled as one range). See the
  // guard below for the full rationale.
  const authoredRanges: Array<{ start: number; end: number }> = []
  let seamTrackingValid = true
  const batchWarnings: string[] = []

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!

    // upstream line 299 — strip trailing newlines for the substring check.
    const oldStringToCheck = edit.oldString.replace(/\n+$/, '')

    // upstream lines 302-311, refined (see invariant #2 in the block
    // comment above) — old_string must not touch the *newly-authored core*
    // of any previously-applied new_string. Substring hits that land
    // entirely inside re-written context bytes are allowed: those bytes
    // pre-existed on disk and the two edits don't conflict. We surface
    // WHICH earlier edit conflicts plus the authored segment so the agent
    // can merge instead of blind-retrying.
    if (oldStringToCheck !== '') {
      for (let j = 0; j < appliedEditRecords.length; j++) {
        const prev = appliedEditRecords[j]!
        if (!prev.newString.includes(oldStringToCheck)) continue
        if (
          occurrenceIntersectsCore(
            prev.newString,
            oldStringToCheck,
            prev.coreStart,
            prev.coreEnd,
          )
        ) {
          const core = prev.newString.slice(prev.coreStart, prev.coreEnd)
          const corePreview =
            core.length > 80 ? `${core.slice(0, 80)}…(+${core.length - 80} chars)` : core
          return {
            success: false,
            failedEditIndex: i,
            error:
              `Edit #${i + 1}: oldString is a substring of the newString that edit #${j + 1} just wrote, ` +
              `and it overlaps the segment edit #${j + 1} newly authored (${JSON.stringify(corePreview)}). ` +
              `Same-batch rewrites of just-authored text cannot be applied safely. Fix it one of these ways: ` +
              `(1) if edit #${i + 1} refines what edit #${j + 1} writes, MERGE them — author edit #${j + 1}'s ` +
              `newString in its final form and drop edit #${i + 1}; ` +
              `(2) if edit #${i + 1} is a deliberate second pass (e.g. a replaceAll rename), split the batch ` +
              `into separate multi_edit_file calls so each runs against fresh disk content. ` +
              `Do NOT resend the same batch unchanged.`,
          }
        }
      }
    }

    const previousContent = updatedFile
    const oneEditResult = computeFileEditResult(
      updatedFile,
      edit.oldString,
      edit.newString,
      { replaceAll: edit.replaceAll === true },
    )
    if (!oneEditResult.success) {
      // multi_edit_file cannot use hashAnchor (line numbers / hashes shift
      // mid-batch), so when an individual edit is rejected for being ambiguous
      // (oldString matches multiple places), steer the model to pull THIS edit
      // out into a standalone edit_file where hashAnchor IS available.
      const multiEditSplitHint = oneEditResult.error.includes('appears multiple times')
        ? ` Note: multi_edit_file does not support hashAnchor. To disambiguate this one edit by region, ` +
          `remove it from the batch and apply it as a standalone edit_file with hashAnchor for the target line.`
        : ''
      return {
        success: false,
        failedEditIndex: i,
        error: `Edit #${i + 1}: ${oneEditResult.error}${multiEditSplitHint}`,
      }
    }
    updatedFile = oneEditResult.newContent
    if (oneEditResult.warnings) {
      for (const w of oneEditResult.warnings) {
        batchWarnings.push(`Edit #${i + 1}: ${w}`)
      }
    }

    // upstream lines 325-327 — a per-edit no-op is a model bug; refuse
    // the whole batch rather than silently swallow it.
    if (updatedFile === previousContent) {
      return {
        success: false,
        failedEditIndex: i,
        error:
          `Edit #${i + 1}: applied without changing the file. This usually means oldString === newString ` +
          `after BOM / quote / whitespace normalisation, or the edit cancelled out an earlier one. ` +
          `Remove this edit from the batch and retry.`,
      }
    }

    // ── Seam-spanning clobber guard (authored-range overlap) ──
    // The substring guard at the top of the loop only inspects each previous
    // edit's `newString` in ISOLATION, so it misses a needle that straddles
    // the boundary between a previous edit's authored bytes and the following
    // ORIGINAL content (corruptionEdgeCases.test.ts GAP#3 — e.g. edit #1
    // AAA→XEND then edit #2 "END\nBBB"→ZZZ silently eats edit #1's "END").
    // Here we additionally track, in the CURRENT buffer's coordinates, the
    // contiguous range each edit authored, and reject when a later edit's
    // change span overlaps one.
    //
    // Strictly additive + regression-safe: a replaceAll edit can rewrite
    // several disjoint spans that our prefix/suffix diff would collapse into
    // one over-broad range (false positives), so the FIRST replaceAll edit
    // disables this guard for the rest of the batch — the substring guard
    // above still runs. The guard therefore only ever ADDS rejections for
    // clear single-edit overlaps and never rejects a batch the old logic
    // accepted.
    if (seamTrackingValid) {
      if (edit.replaceAll === true) {
        seamTrackingValid = false
      } else {
        const span = contiguousChangeSpan(previousContent, updatedFile)
        for (const r of authoredRanges) {
          if (span.start < r.end && span.end > r.start) {
            return {
              success: false,
              failedEditIndex: i,
              error:
                `Edit #${i + 1}: its match overwrites bytes that an earlier edit in this batch already ` +
                `authored (overlapping the working-buffer range [${r.start}, ${r.end})). A later edit ` +
                `silently rewriting an earlier edit's output is almost always a mistake. Fix it one of ` +
                `these ways: (1) MERGE the two edits — author the earlier edit's newString in its final ` +
                `form and drop this one; or (2) if this is a deliberate second pass, split the batch into ` +
                `separate multi_edit_file calls so each runs against fresh content. Do NOT resend the ` +
                `same batch unchanged.`,
            }
          }
        }
        const delta = updatedFile.length - previousContent.length
        for (const r of authoredRanges) {
          if (r.start >= span.end) {
            r.start += delta
            r.end += delta
          }
        }
        authoredRanges.push({ start: span.start, end: span.start + span.insertedLen })
      }
    }

    const core = changedCoreOfEdit(edit.oldString, edit.newString)
    appliedEditRecords.push({
      newString: edit.newString,
      coreStart: core.start,
      coreEnd: core.end,
    })
  }

  // upstream lines 333-337 — final whole-file no-op check.
  if (updatedFile === content) {
    return {
      success: false,
      failedEditIndex: edits.length - 1,
      error:
        'After applying all edits, the file content is identical to the original. ' +
        'No-op edit batches are not allowed — at least one edit must produce a real change.',
    }
  }

  return {
    success: true,
    newContent: updatedFile,
    appliedEdits: edits.length,
    ...(batchWarnings.length > 0 ? { warnings: batchWarnings } : {}),
  }
}
