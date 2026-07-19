/**
 * Tests for {@link toolMultiEditFile} and the pure-function backbone
 * {@link computeFileEditResultMulti}. Focuses on:
 *
 *   1. 1:1 parity with upstream `getPatchForEdits` invariants:
 *      - empty-file + single `{old:'', new:''}` no-op fast path
 *      - per-edit substring overlap check vs previously applied newStrings
 *      - per-edit no-op refusal
 *      - final whole-batch no-op refusal
 *   2. Integration around the same gates toolEditFile uses:
 *      read-before-write, baseReadId rotation, .ipynb refusal,
 *      file-not-found refusal (we deliberately do NOT create via multi),
 *      placeholder-ellipsis batch rejection.
 *   3. Behaviour the registry depends on: the response trailer carries a
 *      fresh `readId for next edit:` line on success and the previous
 *      readId is invalidated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  computeFileEditResultMulti,
  toolMultiEditFile,
  toolReadFile,
  toolEditFile,
} from './tools'
import { setWorkspacePath } from '../tools/workspaceState'
import {
  clearAllReadFileState,
  findCurrentReadIdForPath,
} from '../tools/readFileState'

describe('computeFileEditResultMulti (pure)', () => {
  it('happy path: applies two sequential edits in order', () => {
    const r = computeFileEditResultMulti('hello world\nfoo bar\n', [
      { oldString: 'hello', newString: 'HELLO' },
      { oldString: 'foo', newString: 'FOO' },
    ])
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('HELLO world\nFOO bar\n')
      expect(r.appliedEdits).toBe(2)
    }
  })

  it('happy path: single-element batch still works', () => {
    const r = computeFileEditResultMulti('abc', [
      { oldString: 'b', newString: 'B' },
    ])
    expect(r.success).toBe(true)
    if (r.success) expect(r.newContent).toBe('aBc')
  })

  it('chained edits: edit #2 operates on the buffer produced by edit #1', () => {
    // edit #1 introduces "EXTRA "; edit #2 targets a region that pre-existed,
    // not what edit #1 produced. This is the legitimate chained shape — both
    // succeed and the substring guard does NOT fire.
    const r = computeFileEditResultMulti('hello world', [
      { oldString: 'hello', newString: 'EXTRA hello' },
      { oldString: 'world', newString: 'WORLD' },
    ])
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('EXTRA hello WORLD')
      expect(r.appliedEdits).toBe(2)
    }
  })

  it('empty edits array returns a batch-level error', () => {
    const r = computeFileEditResultMulti('hello', [])
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.failedEditIndex).toBe(-1)
      expect(r.error).toMatch(/empty/i)
    }
  })

  it('empty file + single {old:"", new:""} hits the no-op fast path', () => {
    const r = computeFileEditResultMulti('', [
      { oldString: '', newString: '' },
    ])
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('')
      expect(r.appliedEdits).toBe(1)
    }
  })

  it('substring overlap: oldString of edit #2 inside newString of edit #1 is rejected', () => {
    const r = computeFileEditResultMulti('hello world', [
      { oldString: 'hello', newString: 'GREETING' },
      { oldString: 'GREETING', newString: 'HI' },
    ])
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.failedEditIndex).toBe(1)
      expect(r.error).toMatch(/substring of the newString that edit #1/)
    }
  })

  it('substring overlap check strips trailing newlines from oldString (OpenClaude line 299)', () => {
    // edit #1's new = "ABC". edit #2's old = "AB\n\n" → after strip → "AB" → still substring of "ABC"
    const r = computeFileEditResultMulti('xx', [
      { oldString: 'xx', newString: 'ABC' },
      { oldString: 'AB\n\n', newString: 'whatever' },
    ])
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.failedEditIndex).toBe(1)
      expect(r.error).toMatch(/substring of the newString that edit #1/)
    }
  })

  it('substring overlap error names all three recovery paths (merge / split / no blind retry)', () => {
    const r = computeFileEditResultMulti('hello world', [
      { oldString: 'hello', newString: 'GREETING' },
      { oldString: 'GREETING', newString: 'HI' },
    ])
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toMatch(/MERGE/)
      expect(r.error).toMatch(/split the batch/)
      expect(r.error).toMatch(/Do NOT resend the same batch unchanged/)
    }
  })

  // ── changed-core refinement (2026-06 audit): shared-context batches pass ──

  it('adjacent edits sharing context lines are NOT rejected (core-aware guard)', () => {
    // edit #1 changes line A and carries B/C/D verbatim as context; edit #2
    // then targets line C. 'const C = 3' IS a substring of edit #1's
    // newString — but those bytes were re-written context, not authored
    // text, so the batch must apply cleanly.
    const content = 'const A = 1\nconst B = 2\nconst C = 3\nconst D = 4'
    const r = computeFileEditResultMulti(content, [
      {
        oldString: 'const A = 1\nconst B = 2\nconst C = 3\nconst D = 4',
        newString: 'const A = 100\nconst B = 2\nconst C = 3\nconst D = 4',
      },
      { oldString: 'const C = 3', newString: 'const C = 300' },
    ])
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe(
        'const A = 100\nconst B = 2\nconst C = 300\nconst D = 4',
      )
      expect(r.appliedEdits).toBe(2)
    }
  })

  it('pure-deletion edit authors nothing — follow-up edits inside its newString are allowed', () => {
    const content = 'keep1\nDELETE_ME\nkeep2\n'
    const r = computeFileEditResultMulti(content, [
      { oldString: 'keep1\nDELETE_ME\nkeep2', newString: 'keep1\nkeep2' },
      { oldString: 'keep2', newString: 'KEEP2' },
    ])
    expect(r.success).toBe(true)
    if (r.success) expect(r.newContent).toBe('keep1\nKEEP2\n')
  })

  it('oldString straddling the authored core boundary is still rejected', () => {
    // edit #1 authors 'NEW' between context 'aa' and 'bb'; edit #2's
    // oldString 'NEWbb' covers authored bytes + trailing context → clobber.
    const r = computeFileEditResultMulti('aabb', [
      { oldString: 'aabb', newString: 'aaNEWbb' },
      { oldString: 'NEWbb', newString: 'X' },
    ])
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.failedEditIndex).toBe(1)
      expect(r.error).toMatch(/substring of the newString that edit #1/)
      expect(r.error).toMatch(/newly authored/)
    }
  })

  it('context-only overlap that is ambiguous in the document still fails via the uniqueness gate', () => {
    // 'dup' appears in edit #1's re-written context AND elsewhere in the
    // file. The core-aware guard lets it through; the single-occurrence
    // uniqueness check then reports the ambiguity with its own message.
    const content = 'dup\nA\ndup\n'
    const r = computeFileEditResultMulti(content, [
      { oldString: 'dup\nA', newString: 'dup\nB' },
      { oldString: 'dup', newString: 'DUP' },
    ])
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.failedEditIndex).toBe(1)
      expect(r.error).not.toMatch(/newly authored/)
      expect(r.error).toMatch(/2|unique|times/i)
    }
  })

  it('per-edit not-found surfaces with index and forwarded error', () => {
    const r = computeFileEditResultMulti('hello world', [
      { oldString: 'hello', newString: 'HELLO' },
      { oldString: 'zzz', newString: 'whatever' },
    ])
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.failedEditIndex).toBe(1)
      expect(r.error).toMatch(/^Edit #2:/)
      expect(r.error).toMatch(/not found/i)
    }
  })

  it('round-trip where edit #2 rewrites edit #1 output is caught by the authored-range guard', () => {
    // Construct a round-trip whose oldStrings are NOT substrings of the
    // earlier newStrings (the legacy substring guard runs in the
    // previousNewString.includes direction, so a wider oldString containing
    // the previous newString sneaks past it).
    //
    //   start:           "A=1\nC=3"
    //   after edit #1:   "X=1\nC=3"            (A=1 → X=1, authored "X")
    //   after edit #2:   "A=1\nC=3"            (X=1\nC=3 → A=1\nC=3)
    //
    // edit #2's match starts at the "X" that edit #1 authored, so the
    // authored-range overlap guard now rejects it BEFORE the final-no-op gate
    // (and with a more specific reason: a later edit rewriting an earlier
    // edit's output). The final-no-op gate remains as a backstop for any
    // round-trip that does NOT touch a prior edit's authored bytes.
    const r = computeFileEditResultMulti('A=1\nC=3', [
      { oldString: 'A=1', newString: 'X=1' },
      { oldString: 'X=1\nC=3', newString: 'A=1\nC=3' },
    ])
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.failedEditIndex).toBe(1)
      expect(r.error).toMatch(/overwrites bytes that an earlier edit/i)
    }
  })

  it('per-entry replaceAll only affects that entry', () => {
    // edit #1 has replaceAll=true so both "foo" become "FOO". edit #2 has
    // no replaceAll and "bar" is unique in the file at that point.
    const r = computeFileEditResultMulti('foo foo bar baz', [
      { oldString: 'foo', newString: 'FOO', replaceAll: true },
      { oldString: 'bar', newString: 'BAR' },
    ])
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.newContent).toBe('FOO FOO BAR baz')
    }
  })
})

// ---------------------------------------------------------------------------
// Integration with the on-disk pipeline.
// ---------------------------------------------------------------------------

describe('toolMultiEditFile', () => {
  let dir: string
  beforeEach(() => {
    clearAllReadFileState()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-multi-edit-'))
    setWorkspacePath(dir)
  })
  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('happy path: applies two edits and rotates readId once', async () => {
    const fp = path.join(dir, 'a.ts')
    fs.writeFileSync(fp, 'const a = 1\nconst b = 2\n', 'utf-8')
    await toolReadFile(fp)
    const r = await toolMultiEditFile(fp, [
      { oldString: 'const a = 1', newString: 'const a = 100' },
      { oldString: 'const b = 2', newString: 'const b = 200' },
    ])
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('const a = 100\nconst b = 200\n')
    expect(r.output).toMatch(/Applied 2 edits/)
    expect(r.output).toMatch(/readId for next edit: read-/)
  })

  it('happy path: single-edit batch still rotates the readId', async () => {
    const fp = path.join(dir, 'a1.ts')
    fs.writeFileSync(fp, 'x', 'utf-8')
    await toolReadFile(fp)
    const r = await toolMultiEditFile(fp, [{ oldString: 'x', newString: 'X' }])
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/Applied 1 edit\b/)
  })

  it('missing filePath is rejected before any disk I/O', async () => {
    const r = await toolMultiEditFile('', [{ oldString: 'a', newString: 'b' }])
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/filePath/i)
  })

  // ── baseReadId fallback (loosened Zod gate) ──────────────────────────
  //
  // Models occasionally drop `filePath` on long multi-edit batches under
  // the (correct) reasoning that `baseReadId` already identifies the
  // file. The tool now recovers the path from the read receipt instead
  // of hard-failing with the cryptic "InputValidationError ... received
  // keys: [edits, baseReadId]" message.

  it('recovers filePath from baseReadId when filePath is empty (loosened gate)', async () => {
    const fp = path.join(dir, 'recover.ts')
    fs.writeFileSync(fp, 'const a = 1\n', 'utf-8')
    const readRes = await toolReadFile(fp)
    expect(readRes.success).toBe(true)
    // Read receipts are keyed internally — grab the current one for this
    // path. (toolReadFile's textual output doesn't include the readId
    // trailer; that trailer is only emitted by edit_file/multi_edit_file
    // after a successful write.)
    const baseReadId = findCurrentReadIdForPath(fp)
    expect(baseReadId).toBeDefined()

    // Call without filePath — fallback should kick in via readFileState.
    const r = await toolMultiEditFile(
      '',
      [{ oldString: 'const a = 1', newString: 'const a = 100' }],
      { baseReadId },
    )
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('const a = 100\n')
  })

  it('hard-fails with actionable message when baseReadId is unknown/expired', async () => {
    const r = await toolMultiEditFile(
      '',
      [{ oldString: 'a', newString: 'b' }],
      { baseReadId: 'read-doesnotexist' },
    )
    expect(r.success).toBe(false)
    // Error message should explicitly mention baseReadId so the model
    // knows what to do next (re-read with read_file).
    expect(r.error).toMatch(/baseReadId/)
    expect(r.error).toMatch(/re-read/i)
  })

  it('hard-fails with the no-baseReadId message when neither filePath nor baseReadId is supplied', async () => {
    const r = await toolMultiEditFile('', [{ oldString: 'a', newString: 'b' }])
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/filePath/)
    // Hint should mention baseReadId as an alternative.
    expect(r.error).toMatch(/baseReadId/)
  })

  it('empty edits array is rejected', async () => {
    const fp = path.join(dir, 'b.ts')
    fs.writeFileSync(fp, 'hi', 'utf-8')
    await toolReadFile(fp)
    const r = await toolMultiEditFile(fp, [])
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/edits/i)
    // File untouched.
    expect(fs.readFileSync(fp, 'utf-8')).toBe('hi')
  })

  it('placeholder ellipsis inside an edit falls through to exact-byte match (cc-haha alignment)', async () => {
    // upstream alignment Part 1: the placeholder-ellipsis gate is gone.
    // Edit #2's old_string `more\n...\ncontent` no longer triggers a
    // specialized error — it falls through to exact-byte matching, which
    // legitimately fails because that literal sequence isn't on disk.
    // The atomic-batch contract still holds: edit #1's success doesn't
    // commit if edit #2 fails.
    const fp = path.join(dir, 'c.ts')
    fs.writeFileSync(fp, 'good content\nmore content\n', 'utf-8')
    await toolReadFile(fp)
    const r = await toolMultiEditFile(fp, [
      { oldString: 'good content', newString: 'GREAT content' },
      { oldString: 'more\n...\ncontent', newString: 'replacement' },
    ])
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Edit #2:|not found|exact match/i)
    expect(r.error).not.toMatch(/exact byte matching/i)
    // Critical: atomicity preserved — edit #1 must not have leaked through.
    expect(fs.readFileSync(fp, 'utf-8')).toBe('good content\nmore content\n')
  })

  it('rejects when file does not exist (multi_edit_file does not create)', async () => {
    const fp = path.join(dir, 'missing.ts')
    const r = await toolMultiEditFile(fp, [
      { oldString: '', newString: 'new content' },
    ])
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/not found/i)
    expect(r.error).toMatch(/write_file|edit_file/i)
  })

  it('refuses .ipynb and points to NotebookEdit', async () => {
    const fp = path.join(dir, 'note.ipynb')
    fs.writeFileSync(fp, '{}', 'utf-8')
    await toolReadFile(fp)
    const r = await toolMultiEditFile(fp, [
      { oldString: '{}', newString: '{"cells":[]}' },
    ])
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/NotebookEdit/)
  })

  it('rejects edits when file was not read first (read-before-write gate)', async () => {
    const fp = path.join(dir, 'unread.ts')
    fs.writeFileSync(fp, 'hello', 'utf-8')
    // NOTE: no toolReadFile() call.
    const r = await toolMultiEditFile(fp, [
      { oldString: 'hello', newString: 'HELLO' },
    ])
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/read/i)
  })

  it('accepts a fresh baseReadId from read_file and emits a new readId after the batch', async () => {
    const fp = path.join(dir, 'rotate.ts')
    fs.writeFileSync(fp, 'a=1\nb=2\n', 'utf-8')
    const readResp = await toolReadFile(fp)
    expect(readResp.success).toBe(true)
    const readIdMatch = readResp.output!.match(/readId: (read-[a-z0-9-]+)/)
    expect(readIdMatch).toBeTruthy()
    const initialReadId = readIdMatch![1]!

    const r = await toolMultiEditFile(
      fp,
      [
        { oldString: 'a=1', newString: 'a=10' },
        { oldString: 'b=2', newString: 'b=20' },
      ],
      { baseReadId: initialReadId },
    )
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('a=10\nb=20\n')

    // Output carries a fresh readId distinct from the input one.
    const nextIdMatch = r.output!.match(/readId for next edit: (read-[a-z0-9-]+)/)
    expect(nextIdMatch).toBeTruthy()
    const newReadId = nextIdMatch![1]!
    expect(newReadId).not.toBe(initialReadId)

    // The freshly-rotated readId IS the one that works for chained edits.
    const next = await toolEditFile(fp, 'a=10', 'a=100', {
      baseReadId: newReadId,
    })
    expect(next.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('a=100\nb=20\n')
  })

  it('safely rebinds a stale same-path readId for a later multi-edit batch', async () => {
    const fp = path.join(dir, 'multi-rebind.ts')
    fs.writeFileSync(fp, 'a=1\nb=2\n', 'utf-8')
    const readResp = await toolReadFile(fp)
    const initialReadId = readResp.output!.match(/readId: (read-[a-z0-9-]+)/)![1]!

    const first = await toolMultiEditFile(
      fp,
      [{ oldString: 'a=1', newString: 'a=10' }],
      { baseReadId: initialReadId },
    )
    expect(first.success).toBe(true)

    const second = await toolMultiEditFile(
      fp,
      [{ oldString: 'b=2', newString: 'b=20' }],
      { baseReadId: initialReadId },
    )
    expect(second.success).toBe(true)
    expect(second.output).toMatch(/safely rebound/i)
    expect(second.output).toContain(initialReadId)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('a=10\nb=20\n')
  })

  it('rejects substring overlap on disk and leaves file untouched', async () => {
    const fp = path.join(dir, 'overlap.ts')
    fs.writeFileSync(fp, 'hello world\n', 'utf-8')
    await toolReadFile(fp)
    const r = await toolMultiEditFile(fp, [
      { oldString: 'hello', newString: 'GREETING' },
      { oldString: 'GREETING', newString: 'HI' },
    ])
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/substring of the newString that edit #1/)
    // CRITICAL — the on-disk file must be untouched. The batch lands
    // atomically or not at all.
    expect(fs.readFileSync(fp, 'utf-8')).toBe('hello world\n')
  })

  it('rejects a round-trip batch that rewrites a prior edit and leaves file untouched', async () => {
    const fp = path.join(dir, 'roundtrip.ts')
    fs.writeFileSync(fp, 'A=1\nC=3\n', 'utf-8')
    await toolReadFile(fp)
    // Same construction as the pure-function test: edit #2's wider oldString
    // sneaks past the substring guard but its match starts on the "X" that
    // edit #1 authored, so the authored-range overlap guard rejects it. The
    // batch must land atomically or not at all — file stays untouched.
    const r = await toolMultiEditFile(fp, [
      { oldString: 'A=1', newString: 'X=1' },
      { oldString: 'X=1\nC=3', newString: 'A=1\nC=3' },
    ])
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/overwrites bytes that an earlier edit/i)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('A=1\nC=3\n')
  })

  it('rejects per-edit no-op (oldString === newString in one entry)', async () => {
    const fp = path.join(dir, 'noop.ts')
    fs.writeFileSync(fp, 'hello world\n', 'utf-8')
    await toolReadFile(fp)
    const r = await toolMultiEditFile(fp, [
      { oldString: 'hello', newString: 'HELLO' },
      { oldString: 'world', newString: 'world' },
    ])
    expect(r.success).toBe(false)
    // The pure layer surfaces "Edit #2:" prefix, but the per-edit primitive
    // rejects identical strings before we even get to the substring check
    // (computeFileEditResult treats a same-string match as a successful
    // find but the resulting buffer is unchanged → per-edit no-op gate).
    expect(r.error).toMatch(/Edit #2:/)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('hello world\n')
  })

  it('per-entry replaceAll: one entry replaces all occurrences, other replaces one (unique)', async () => {
    const fp = path.join(dir, 'replaceall.ts')
    // "foo" appears twice (covered by replaceAll), "bar" only once (covered
    // by single-replace edit). If we left "bar" duplicated and asked for a
    // single-replace, computeFileEditResult would correctly fail with
    // "duplicate" — that is single-edit semantics, NOT a multi-edit bug.
    fs.writeFileSync(fp, 'foo foo bar baz\n', 'utf-8')
    await toolReadFile(fp)
    const r = await toolMultiEditFile(fp, [
      { oldString: 'foo', newString: 'FOO', replaceAll: true },
      { oldString: 'bar', newString: 'BAR' },
    ])
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('FOO FOO BAR baz\n')
  })

  it('identifies Edit #1 when the readId gate rejects the first oldString', async () => {
    const fp = path.join(dir, 'first-gate.ts')
    fs.writeFileSync(fp, 'alpha\nbeta\n', 'utf-8')
    const read = await toolReadFile(fp)
    const readId = read.output?.match(/readId: (read-[a-z0-9-]+)/)?.[1]
    expect(readId).toBeTruthy()

    const result = await toolMultiEditFile(
      fp,
      [
        { oldString: 'missing first target', newString: 'FIRST' },
        { oldString: 'beta', newString: 'BETA' },
      ],
      { baseReadId: readId },
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/^Edit #1:/)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('alpha\nbeta\n')
  })

  it('refuses to overwrite when DANGEROUS_DIRECTORY segment is in the path', async () => {
    const subdir = path.join(dir, '.git')
    fs.mkdirSync(subdir)
    const fp = path.join(subdir, 'config')
    fs.writeFileSync(fp, 'old', 'utf-8')
    // Skip read — the dangerous-dir gate runs before the read-before-write gate.
    const r = await toolMultiEditFile(fp, [
      { oldString: 'old', newString: 'new' },
    ])
    expect(r.success).toBe(false)
    // File must be untouched.
    expect(fs.readFileSync(fp, 'utf-8')).toBe('old')
  })
})
