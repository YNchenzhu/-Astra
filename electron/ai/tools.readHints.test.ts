/**
 * Regression tests for the "AI first-shot hit-rate" improvements:
 *
 *   1. Fuzzy hints — when `old_string` does not match any bytes in the file,
 *      the error message points the agent at the closest lines (by token
 *      Jaccard + coverage). Covers both the direct semantics helper and the
 *      `toolEditFile` end-to-end path.
 *
 *   2. Symbol outline — when a full read is returned (small file or explicit
 *      full read), the tool output appends a `Top symbols:` trailer for common
 *      language families. Outlines are NOT emitted for partial reads.
 *
 *   3. Dedup containment — `tryConsumeReadDedup` now returns true whenever the
 *      requested `[offset, offset+limit]` window is fully covered by the last
 *      successful read (mtime unchanged), not only on exact offset/limit
 *      equality. Verifies both the unit-level predicate and the tool-level
 *      effect (repeat read collapses to the FILE_UNCHANGED_STUB).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toolReadFile, toolEditFile, computeFileEditResult } from './tools'
import { findFuzzyOldStringHints } from './fileEditSemantics'
import { setWorkspacePath } from '../tools/workspaceState'
import {
  clearAllReadFileState,
  recordSuccessfulRead,
  tryConsumeReadDedup,
  SMALL_FILE_FULL_READ_LINE_THRESHOLD,
} from '../tools/readFileState'

function extractReadId(output: string): string | undefined {
  return output.match(/readId:\s*(read-[0-9a-f]+)/)?.[1]
}

// --------------------------------------------------------------------------
// 1. Fuzzy hints
// --------------------------------------------------------------------------

describe('findFuzzyOldStringHints (semantics)', () => {
  it('points at the closest line when old_string is misspelt but shares tokens', () => {
    const content = [
      'import foo from "./foo"',
      '',
      'export const computeTotalPrice = (items) => {',
      '  return items.reduce((a, b) => a + b.price, 0)',
      '}',
      '',
      'export const formatDate = (d) => d.toISOString()',
    ].join('\n')
    const old = 'export const computeTotlPrice = (items) => {'
    const hint = findFuzzyOldStringHints(content, old)
    expect(hint).toMatch(/line 3/)
    expect(hint).toMatch(/computeTotalPrice/)
    expect(hint).toMatch(/similarity \d+%/)
  })

  it('ranks higher-coverage lines above incidental token overlaps', () => {
    const content = [
      'const unrelatedFoo = 1',
      'function handleRequest(req, res) {',
      '  return res.send(req.body)',
      '}',
      'const anotherFoo = 2',
    ].join('\n')
    const old = 'function handleRequest(req, res) { return res.json(req.body) }'
    const hint = findFuzzyOldStringHints(content, old)
    expect(hint).toMatch(/line 2/)
    const lineTwoIdx = hint.indexOf('line 2')
    const lineFourIdx = hint.indexOf('line 4')
    if (lineFourIdx !== -1) {
      expect(lineTwoIdx).toBeLessThan(lineFourIdx)
    }
  })

  it('returns empty string when nothing comes close', () => {
    const content = ['alpha', 'beta', 'gamma'].join('\n')
    const hint = findFuzzyOldStringHints(content, 'totally_unrelated_symbol_xyz')
    expect(hint).toBe('')
  })

  it('returns empty string on an empty anchor line', () => {
    const content = 'x\ny\nz'
    expect(findFuzzyOldStringHints(content, '')).toBe('')
    expect(findFuzzyOldStringHints(content, '   \n   ')).toBe('')
  })

  it('caps suggestions at the configured limit', () => {
    const content = Array.from({ length: 200 }, (_, i) => `export const fnNumberOne_${i} = () => {}`).join('\n')
    const hint = findFuzzyOldStringHints(
      content,
      'export const fnNumberOne_missing = () => {}',
      3,
    )
    const bulletCount = (hint.match(/\n {2}•/g) ?? []).length
    expect(bulletCount).toBeLessThanOrEqual(3)
    expect(bulletCount).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // Self-inflicted drift diagnostic. Real-world sample: an AI performed two
  // successful edits on a file during turns 13-14 of an agentic loop, then
  // at turn 15 submitted a third edit whose old_string had been composed
  // from the AI's now-stale mental model of the file. The anchor line
  // matched 100% but the rest of old_string no longer did — because the
  // surrounding lines had shifted from the earlier edits. The hint has to
  // point at re-reading, not at whitespace tweaks.
  // -------------------------------------------------------------------------

  it('diagnoses self-inflicted drift when EXACTLY one anchor line matches 100%', () => {
    const content = [
      '# unrelated header',
      'class StyleAnalyzeThread(QThread):',
      '    def run(self): pass',
      '',
      'class ReviewThread(QThread):',
      '    def run(self):',
      '        do_different_things_now()   # shifted by earlier edit',
      '        return 42',
    ].join('\n')
    // old_string's first line matches line 5 (`class ReviewThread(QThread):`)
    // EXACTLY, but the lines after it reflect the PRE-edit version.
    const old = [
      'class ReviewThread(QThread):',
      '    def run(self):',
      '        old_pre_edit_body()',
    ].join('\n')

    const hint = findFuzzyOldStringHints(content, old)
    // Calls out the exact anchor line.
    expect(hint).toMatch(/line 5 EXACTLY/)
    // Names the diagnosis.
    expect(hint).toMatch(/self-inflicted drift/i)
    // Points at the fix (re-run read_file).
    expect(hint).toMatch(/read_file/)
    // Forbids the WRONG fix (whitespace tweaking).
    expect(hint).toMatch(/Do NOT retry with whitespace/i)
  })

  it('diagnoses ambiguous-anchor when the old_string first line matches 2+ locations exactly', () => {
    const content = [
      'class Foo:',
      '    def run(self): pass',
      '',
      'class Foo:', // second class with the same name (line 4) — imagined scenario
      '    def run(self): pass',
    ].join('\n')
    // old_string first line matches at lines 1 AND 4 verbatim.
    const old = [
      'class Foo:',
      '    def run(self): different_body()',
    ].join('\n')

    const hint = findFuzzyOldStringHints(content, old)
    expect(hint).toMatch(/EXACTLY at 2 locations/i)
    expect(hint).toMatch(/lines 1, 4/)
    // The uniqueness fix route.
    expect(hint).toMatch(/extend it with a few more distinctive surrounding lines/i)
    // And/or the replace_all opt-in.
    expect(hint).toMatch(/replace_all/)
    // This branch must NOT mis-attribute to drift, since multiple anchors
    // means the problem is ambiguity not staleness.
    expect(hint).not.toMatch(/self-inflicted drift/i)
  })

  it('weak-match branch still wins over exact-anchor branch when best score < 0.55', () => {
    // Guards a branch-ordering bug: `bestScore < 0.55` is checked FIRST so
    // the weak-match warning is what the agent sees in that case, even if
    // no exact anchor exists at all.
    const content = ['aaa', 'bbb', 'ccc'].join('\n')
    const old = 'xxx yyy zzz'
    const hint = findFuzzyOldStringHints(content, old)
    // No hits at all → empty hint; this guards the no-op path of the same
    // threshold logic (so future tweaks to 0.55 don't accidentally emit
    // drift/uniqueness tails when there's nothing to tie them to).
    expect(hint).toBe('')
  })

  it('diagnoses partial-overlap (0.55–0.97, no exact anchor) with stale-write / wrong-region hint', () => {
    // Scenario: the file has one line that shares MOST tokens with the
    // first line of old_string but NOT verbatim — e.g. the model has a
    // stale mental model of the file after a previous failed write, so
    // the anchor token set overlaps but order / surrounding bytes drift.
    //
    // Best candidate must land in (0.55, 0.98) AND there must be no
    // line scoring ≥ 0.98 (otherwise the existing self-drift branch
    // takes over).
    const content = [
      '// unrelated header line one',
      '// unrelated header line two',
      'export function computeTotalPrice(items, tax, currency) {',
      '  return items.reduce((a, b) => a + b.price, 0) * (1 + tax)',
      '}',
    ].join('\n')
    // Reorder tokens + drop one (currency) so it cannot reach the 0.98
    // exact-anchor threshold but still token-overlaps strongly with line 3.
    const old = [
      'export function computeTotalPrice(tax, items) {',
      '  // a body the file does not have',
      '}',
    ].join('\n')

    const hint = findFuzzyOldStringHints(content, old)
    // Points at the right line.
    expect(hint).toMatch(/line 3/)
    // Reports the actual similarity percentage so the agent can reason
    // about how close it really is.
    expect(hint).toMatch(/similar/)
    // The new branch must NOT fall back to the generic "drift" wording —
    // that branch is reserved for the EXACT-anchor case, and confusing
    // the two would mis-direct the agent's next action.
    expect(hint).not.toMatch(/self-inflicted drift/i)
    expect(hint).not.toMatch(/EXACTLY/)
    // Must call out the two plausible root causes so the agent knows
    // which corrective action to take.
    expect(hint).toMatch(/RENAME_FAILED|previous edit_file|failed/i)
    expect(hint).toMatch(/different regions|stitched|composite/i)
    // Must direct the agent at the canonical fix.
    expect(hint).toMatch(/re-?run.*read_file|re-?read/i)
  })
})

describe('computeFileEditResult fuzzy hints on miss', () => {
  it('appends fuzzy hint to the "not found" error when a close match exists', () => {
    const content = 'const answerIs = 42\n'
    const r = computeFileEditResult(content, 'const ansewrIs = 42', 'const answerIs = 43')
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toMatch(/not found/i)
      expect(r.error).toMatch(/line 1/)
      expect(r.error).toMatch(/answerIs/)
    }
  })

  it('keeps the error concise when no fuzzy match rises above the threshold', () => {
    const r = computeFileEditResult('alpha\n', 'completely_unrelated_zzz', 'whatever')
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toBe('The old_string was not found in the file.')
    }
  })
})

describe('toolEditFile fuzzy hint end-to-end', () => {
  let tmp: string

  beforeEach(() => {
    clearAllReadFileState()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-hints-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('surfaces fuzzy-match suggestions when edit_file fails to locate old_string', async () => {
    const f = path.join(tmp, 'a.ts')
    fs.writeFileSync(
      f,
      [
        'export function handleRequest(req, res) {',
        '  return res.json(req.body)',
        '}',
      ].join('\n') + '\n',
      'utf-8',
    )
    await toolReadFile(f)
    const edit = await toolEditFile(
      f,
      'export function handlRequest(req, res) {',
      'export function handleRequest(req, res) {',
    )
    expect(edit.success).toBe(false)
    expect(edit.error).toMatch(/not found/i)
    expect(edit.error).toMatch(/line 1/)
    expect(edit.error).toMatch(/handleRequest/)
  })
})

// --------------------------------------------------------------------------
// 2. Symbol outline
// --------------------------------------------------------------------------

describe('read_file symbol outline', () => {
  let tmp: string

  beforeEach(() => {
    clearAllReadFileState()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-outline-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('emits a Top symbols trailer with line numbers for TypeScript', async () => {
    const f = path.join(tmp, 'a.ts')
    fs.writeFileSync(
      f,
      [
        'import { x } from "./x"',
        '',
        'export const alpha = 1',
        '',
        'export function beta(n: number) {',
        '  return n * 2',
        '}',
        '',
        'class Gamma {',
        '  hi() {}',
        '}',
      ].join('\n') + '\n',
      'utf-8',
    )
    const r = await toolReadFile(f)
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    expect(out).toMatch(/Top symbols:/)
    expect(out).toMatch(/L3:\s*alpha/)
    expect(out).toMatch(/L5:\s*beta/)
    expect(out).toMatch(/L9:\s*Gamma/)
  })

  it('emits outline for Python def/class', async () => {
    const f = path.join(tmp, 'a.py')
    fs.writeFileSync(
      f,
      [
        'import os',
        '',
        'def compute(x):',
        '    return x + 1',
        '',
        'class Shape:',
        '    pass',
      ].join('\n') + '\n',
      'utf-8',
    )
    const r = await toolReadFile(f)
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    expect(out).toMatch(/Top symbols:/)
    expect(out).toMatch(/L3:\s*compute/)
    expect(out).toMatch(/L6:\s*Shape/)
  })

  it('does NOT emit an outline for a partial read (large file)', async () => {
    const f = path.join(tmp, 'big.ts')
    // Over the auto-widen threshold so offset/limit is respected.
    const lines = Array.from({ length: SMALL_FILE_FULL_READ_LINE_THRESHOLD + 100 }, (_, i) =>
      i === 50 ? 'export function target() {}' : `// noise line ${i + 1}`,
    )
    fs.writeFileSync(f, lines.join('\n') + '\n', 'utf-8')
    const r = await toolReadFile(f, { offset: 0, limit: 100 })
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    expect(out).not.toMatch(/Top symbols:/)
    expect(out).toMatch(/showing lines 1-100 of/)
  })

  it('caps outline entries at the top 12 symbols', async () => {
    const f = path.join(tmp, 'many.ts')
    const lines = Array.from({ length: 40 }, (_, i) => `export function sym${i}() {}`)
    fs.writeFileSync(f, lines.join('\n') + '\n', 'utf-8')
    const r = await toolReadFile(f)
    expect(r.success).toBe(true)
    const out = r.output ?? ''
    const bullets = (out.match(/\n {2}L\d+:\s/g) ?? []).length
    expect(bullets).toBeLessThanOrEqual(12)
    expect(bullets).toBeGreaterThanOrEqual(1)
  })

  it('skips outline for non-source text files', async () => {
    const f = path.join(tmp, 'notes.txt')
    fs.writeFileSync(
      f,
      [
        'def looks_like_python_but_is_not(): pass',
        'function alsoNot() {}',
        'plain text',
      ].join('\n') + '\n',
      'utf-8',
    )
    const r = await toolReadFile(f)
    expect(r.success).toBe(true)
    expect(r.output ?? '').not.toMatch(/Top symbols:/)
  })
})

// --------------------------------------------------------------------------
// 3. Dedup containment
// --------------------------------------------------------------------------

describe('tryConsumeReadDedup containment', () => {
  let tmp: string
  const p = (name: string) => path.join(tmp, name).replace(/\\/g, '/')

  beforeEach(() => {
    clearAllReadFileState()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-dedup-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('still matches when offset and limit are identical (fast path)', () => {
    const target = p('a.txt')
    recordSuccessfulRead(target, {
      mtimeMs: 1000,
      isPartialView: true,
      readOffset: 100,
      readLimit: 50,
      fullFileContent: 'x',
    })
    expect(tryConsumeReadDedup(target, 1000, 100, 50)).toMatchObject({ dedup: true, strikeCount: 1 })
  })

  it('matches when the requested window is fully inside the previous window (relaxed)', () => {
    const target = p('b.txt')
    recordSuccessfulRead(target, {
      mtimeMs: 2000,
      isPartialView: true,
      readOffset: 0,
      readLimit: 500,
      fullFileContent: 'x',
    })
    expect(tryConsumeReadDedup(target, 2000, 50, 300)).toMatchObject({ dedup: true })
    expect(tryConsumeReadDedup(target, 2000, 100, 400)).toMatchObject({ dedup: true })
    expect(tryConsumeReadDedup(target, 2000, 0, 500)).toMatchObject({ dedup: true })
  })

  it('does not match when the requested window extends past the previous end', () => {
    const target = p('c.txt')
    recordSuccessfulRead(target, {
      mtimeMs: 3000,
      isPartialView: true,
      readOffset: 0,
      readLimit: 500,
      fullFileContent: 'x',
    })
    expect(tryConsumeReadDedup(target, 3000, 0, 600)).toMatchObject({ dedup: false })
    expect(tryConsumeReadDedup(target, 3000, 400, 200)).toMatchObject({ dedup: false })
  })

  it('does not match when the requested window starts before the previous start', () => {
    const target = p('d.txt')
    recordSuccessfulRead(target, {
      mtimeMs: 4000,
      isPartialView: true,
      readOffset: 100,
      readLimit: 200,
      fullFileContent: 'x',
    })
    expect(tryConsumeReadDedup(target, 4000, 0, 200)).toMatchObject({ dedup: false })
    expect(tryConsumeReadDedup(target, 4000, 50, 100)).toMatchObject({ dedup: false })
  })

  it('does not match across mtime changes (freshness wins over containment)', () => {
    const target = p('e.txt')
    recordSuccessfulRead(target, {
      mtimeMs: 5000,
      isPartialView: true,
      readOffset: 0,
      readLimit: 500,
      fullFileContent: 'x',
    })
    expect(tryConsumeReadDedup(target, 5001, 100, 100)).toMatchObject({ dedup: false })
  })

  it('is disabled when DISABLE_READ_DEDUP=1', () => {
    const target = p('f.txt')
    recordSuccessfulRead(target, {
      mtimeMs: 6000,
      isPartialView: true,
      readOffset: 0,
      readLimit: 500,
      fullFileContent: 'x',
    })
    const prev = process.env.DISABLE_READ_DEDUP
    process.env.DISABLE_READ_DEDUP = '1'
    try {
      expect(tryConsumeReadDedup(target, 6000, 100, 100)).toMatchObject({ dedup: false })
    } finally {
      if (prev === undefined) delete process.env.DISABLE_READ_DEDUP
      else process.env.DISABLE_READ_DEDUP = prev
    }
  })
})

describe('toolReadFile dedup containment end-to-end', () => {
  let tmp: string

  beforeEach(() => {
    clearAllReadFileState()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-dedup-e2e-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('short-circuits a second read whose window is already covered by the first', async () => {
    const f = path.join(tmp, 'big.ts')
    // Over the auto-widen threshold so the first partial read stays partial.
    const lines = Array.from({ length: SMALL_FILE_FULL_READ_LINE_THRESHOLD + 500 }, (_, i) => `line ${i + 1}`)
    fs.writeFileSync(f, lines.join('\n') + '\n', 'utf-8')

    const first = await toolReadFile(f, { offset: 0, limit: 500 })
    expect(first.success).toBe(true)
    expect(first.output ?? '').toMatch(/showing lines 1-500 of/)
    // Prove the first read recorded as partial (otherwise dedup is moot).
    expect(extractReadId(first.output ?? '')).toBeDefined()

    // Fully-contained follow-up — containment should hit and return cached content immediately.
    const second = await toolReadFile(f, { offset: 50, limit: 100 })
    expect(second.success).toBe(true)
    expect(second.output).toContain('file unchanged since last read')
    expect(second.output).toContain('line 51')
    expect(second.output).toContain('line 150')
    expect(second.output).toContain('from cache')
  })

  it('re-reads when the second window extends past the first', async () => {
    const f = path.join(tmp, 'big2.ts')
    const lines = Array.from({ length: SMALL_FILE_FULL_READ_LINE_THRESHOLD + 500 }, (_, i) => `line ${i + 1}`)
    fs.writeFileSync(f, lines.join('\n') + '\n', 'utf-8')

    const first = await toolReadFile(f, { offset: 0, limit: 500 })
    expect(first.success).toBe(true)

    const second = await toolReadFile(f, { offset: 400, limit: 300 })
    expect(second.success).toBe(true)
    expect(second.output).not.toContain('File unchanged since your last read')
    expect(second.output ?? '').toMatch(/showing lines 401-700 of/)
  })
})
