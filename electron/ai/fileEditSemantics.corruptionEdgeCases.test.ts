/**
 * Extreme edge-case probes for the shared edit core
 * ({@link computeFileEditResult} / {@link computeFileEditResultMulti}),
 * hunting for inputs that SILENTLY corrupt content or write to the wrong
 * position. Both `edit_file` and `multi_edit_file` route every replacement
 * through `computeFileEditResult`, so any defect here affects both tools;
 * multi-edit amplifies it because the core runs once per edit in the batch.
 *
 * These were two confirmed silent-corruption bugs and one guard gap; all
 * three are now FIXED and these tests assert the corrected behavior so they
 * stay as regression guards.
 *
 * ── BUG #1 (HIGH — silent content corruption / wrong position) ───────────
 * `resolveOldStringInFile` matches via `canonicalizeForLlmDrift`, then slices
 * the ORIGINAL file body using an index taken from the CANONICALIZED string.
 * That only works if canonicalization is strictly 1:1 length-preserving —
 * but the canonicalizer ends with `.normalize('NFC')`, which composes a
 * decomposed sequence (base char + combining mark = 2 code units) into a
 * single code unit. Any such char BEFORE the match shifts every later index,
 * so the slice lands on the wrong bytes: the replacement deletes/garbles
 * unrelated characters with NO error raised.
 *
 * ── BUG #2 (MEDIUM — untouched lines rewritten) ──────────────────────────
 * When an edit only matches after CRLF→LF normalization, the result is
 * rebuilt in LF space and then `expandLfResultToFileStyle` converts EVERY
 * `\n` back to `\r\n` whenever the file contained ANY `\r\n`. On a
 * mixed-EOL file this rewrites the line endings of lines the edit never
 * targeted.
 *
 * ── GAP #3 (multi-edit overlap guard, LOW) ───────────────────────────────
 * The "edit N must not rewrite what edit M<N authored" guard compares the
 * new edit's oldString against the previous edit's `newString` in isolation.
 * A needle that straddles the seam between the previous newString and the
 * following ORIGINAL bytes is invisible to the guard, so edit #2 can
 * silently clobber part of edit #1's authored output.
 */

import { describe, it, expect } from 'vitest'
import { computeFileEditResult, computeFileEditResultMulti } from './fileEditSemantics'

describe('edit core — fixed silent-corruption regressions', () => {
  // BUG #1a. File: "é，abc" with é = e + U+0301 (decomposed) and a fullwidth
  // comma. Model sends an ASCII comma so the match only succeeds via drift
  // canonicalization. Pre-fix this produced `"e,XYZc"` (accent destroyed,
  // stray `c`); the length-preserving canonicalizer now keeps indices aligned.
  it('BUG#1a: NFC index shift no longer corrupts a decomposed char before a drift match', () => {
    const content = '"e\u0301\uFF0Cabc"'
    const r = computeFileEditResult(content, ',abc', ',XYZ')
    expect(r.success).toBe(true)
    if (!r.success) return
    // Accent must survive (composed or decomposed); abc must fully become XYZ.
    expect(r.newContent.includes('e\u0301') || r.newContent.includes('\u00e9')).toBe(true)
    expect(r.newContent).toContain('XYZ')
    expect(r.newContent.includes('abc')).toBe(false)
  })

  // BUG #1b. Same root cause via curly-quote drift. Original:
  // `é said "hi" done` (decomposed é, curly quotes). Edit "hi"→"YO".
  // Pre-fix output was `é said“YO”” done` (space eaten, closing quote
  // duplicated); now the match lands on the correct bytes.
  it('BUG#1b: NFC index shift no longer eats a space / duplicates the closing quote', () => {
    const content = 'e\u0301 said \u201Chi\u201D done'
    const r = computeFileEditResult(content, '"hi"', '"YO"')
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.newContent.includes('\u201D\u201D')).toBe(false) // no doubled closing quote
    expect(r.newContent).toContain('said ') // the space before the quote is preserved
  })

  // BUG #2. Mixed-EOL file (line 1 CRLF, lines 2-3 LF). The edit only matches
  // after newline normalization. Pre-fix the whole file was re-CRLF'd
  // (`a\r\nB\r\nc\r\n`, line 3's LF wrongly became CRLF); now untouched lines
  // keep their original EOL because the result is spliced into the original.
  it('BUG#2: normalized-path edit no longer rewrites the EOL of untouched lines (mixed EOL)', () => {
    const content = 'a\r\nb\nc\n'
    const r = computeFileEditResult(content, 'a\nb', 'a\nB')
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.newContent.endsWith('c\n')).toBe(true) // line 3 stays LF
    expect(r.newContent.includes('c\r\n')).toBe(false)
  })
})

describe('multi-edit overlap guard — seam-spanning clobber now rejected', () => {
  // GAP #3 (fixed). edit #1 turns AAA→XEND; edit #2's oldString `END\nBBB`
  // spans the tail of edit #1's newString ("END") plus the following original
  // "BBB". The legacy substring guard missed this (`END\nBBB` is not a
  // substring of "XEND" in isolation) and edit #2 silently produced "XZZZ\n",
  // eating edit #1's "END". The authored-range overlap guard now rejects it.
  it('rejects a seam-spanning clobber instead of silently eating edit #1 output', () => {
    const r = computeFileEditResultMulti('AAA\nBBB\n', [
      { oldString: 'AAA', newString: 'XEND' },
      { oldString: 'END\nBBB', newString: 'ZZZ' },
    ])
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.failedEditIndex).toBe(1)
    expect(r.error).toMatch(/earlier edit|overwrites/i)
  })

  // Regression guard: a genuinely independent two-edit batch in disjoint
  // regions must still be accepted (the new guard is additive, not blanket).
  it('still accepts two edits in disjoint regions', () => {
    const r = computeFileEditResultMulti('alpha\nbeta\ngamma\n', [
      { oldString: 'alpha', newString: 'ALPHA' },
      { oldString: 'gamma', newString: 'GAMMA' },
    ])
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.newContent).toBe('ALPHA\nbeta\nGAMMA\n')
  })
})

describe('edit core — adjacent cases that are CORRECT (bounds the bugs above)', () => {
  // Contrast to BUG#1: same drift match, but NO decomposed char before the
  // target, so NFC changes no length and the slice lands correctly.
  it('fullwidth-comma drift WITHOUT a decomposed char applies correctly', () => {
    const content = '"\uFF0Cabc"' // "，abc" — composed, fullwidth comma only
    const r = computeFileEditResult(content, ',abc', ',XYZ')
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.newContent).toContain('XYZ')
    expect(r.newContent.includes('abc')).toBe(false)
  })

  // Contrast to BUG#2: a UNIFORM-CRLF file re-CRLF'd is idempotent, so only
  // the targeted line changes.
  it('uniform-CRLF normalized edit changes only the targeted line', () => {
    const content = 'a\r\nb\r\nc\r\n'
    const r = computeFileEditResult(content, 'a\nb', 'a\nB')
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.newContent).toBe('a\r\nB\r\nc\r\n')
  })
})
