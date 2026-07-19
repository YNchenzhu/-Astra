import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toolWriteFile, toolEditFile, toolReadFile } from './tools'
import { setWorkspacePath } from '../tools/workspaceState'
import {
  clearAllReadFileState,
  findCurrentReadIdForPath,
} from '../tools/readFileState'
import { validateEditToolPayload } from '../utils/settings/validateEditTool'

describe('toolWriteFile safety', () => {
  let tmp: string

  beforeEach(() => {
    clearAllReadFileState()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-write-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('rejects empty path', async () => {
    const r = await toolWriteFile('   ', 'x')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/empty/i)
  })

  // ── baseReadId fallback (loosened Zod gate, mirrors edit_file/multi_edit_file)
  //
  // Models occasionally drop `filePath` on write_file calls — typically
  // when the content payload is long enough that the JSON gets truncated,
  // or when the model reasons "baseReadId already identifies the file
  // I want to overwrite". The tool now recovers the path from the read
  // receipt instead of hard-failing with the cryptic "InputValidationError
  // (write_file): filePath: filePath or file_path is required" message.

  it('still recovers filePath from baseReadId when filePath is empty (then rejects with the canonical "use edit_file" wording for the resolved path)', async () => {
    // The baseReadId path-recovery fallback runs BEFORE the centralised
    // preflight gate, so we can verify (a) the fallback still resolves
    // the path even when filePath is empty, and (b) the recovered path
    // is then rejected by preflight because the file exists. The test
    // would have surfaced a generic "filePath is missing" error if the
    // fallback regressed.
    const f = path.join(tmp, 'recover-write.ts')
    fs.writeFileSync(f, 'const a = 1\n', 'utf-8')
    const readRes = await toolReadFile(f)
    expect(readRes.success).toBe(true)
    const baseReadId = findCurrentReadIdForPath(f)
    expect(baseReadId).toBeDefined()

    const r = await toolWriteFile('', 'const a = 999\n', { baseReadId })
    expect(r.success).toBe(false)
    if (!r.success) {
      // Recovered path surfaces in the error so the model knows what was resolved.
      expect(r.error).toContain('recover-write.ts')
      expect(r.error).toMatch(/edit_file/)
      expect(r.error).not.toMatch(/filePath is missing/i)
    }
    expect(fs.readFileSync(f, 'utf-8')).toBe('const a = 1\n')
  })

  it('hard-fails with an actionable message when baseReadId is unknown/expired', async () => {
    const r = await toolWriteFile('', 'content', { baseReadId: 'read-doesnotexist' })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/baseReadId/)
    expect(r.error).toMatch(/re-read/i)
  })

  it('hints at baseReadId in the no-args error when neither filePath nor baseReadId is supplied', async () => {
    const r = await toolWriteFile('', 'content')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/filePath/)
    expect(r.error).toMatch(/baseReadId/)
  })

  it('rejects empty content when target file already exists with content', async () => {
    const f = path.join(tmp, 'a.txt')
    fs.writeFileSync(f, 'keep', 'utf-8')
    await toolReadFile(f)
    const r = await toolWriteFile(f, '')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/empty|clear/i)
    expect(fs.readFileSync(f, 'utf-8')).toBe('keep')
  })

  it('rejects BOM-only content that would clear a non-empty file (post-normalisation guard)', async () => {
    const f = path.join(tmp, 'bom-only.txt')
    fs.writeFileSync(f, 'real data', 'utf-8')
    await toolReadFile(f)
    // Pre-normalisation the content is not strictly '' (it's '\uFEFF'), but
    // after stripping the BOM it is empty. The new post-normalisation guard
    // must still refuse to clobber the file.
    const r = await toolWriteFile(f, '\uFEFF')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/empty|clear/i)
    expect(fs.readFileSync(f, 'utf-8')).toBe('real data')
  })

  it('allows empty content for a new file', async () => {
    const f = path.join(tmp, 'new-empty.txt')
    const r = await toolWriteFile(f, '')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('')
  })

  // NOTE: The previous test suite included six "overwrite-by-Write" cases
  // (no-op-when-content-matches, four line-ending/BOM verbatim variants on
  // top of pre-existing files, and the chained-self-write receipt-refresh
  // case). All of them exercised code paths that are now unreachable from
  // toolWriteFile under the strengthened contract — write_file rejects ANY
  // pre-existing file via the centralised preflight gate. The verbatim
  // line-ending / BOM contract for FRESH files is still covered in
  // tools.writeFile.extreme.test.ts (#01 CRLF, #10 BOM, #11 newline-only,
  // #18 old-Mac CR, #19 tabs); the chained-write case is replaced below
  // with an explicit "second Write is rejected" assertion that documents
  // the new contract.

  it('a second Write by the same agent is rejected — chained mutations must go through edit_file', async () => {
    const f = path.join(tmp, 'doc.md')
    const first = await toolWriteFile(f, 'v1\n')
    expect(first.success).toBe(true)
    const second = await toolWriteFile(f, 'v2\n')
    expect(second.success).toBe(false)
    if (!second.success) {
      expect(second.error).toMatch(/edit_file/)
      expect(second.error).toMatch(/already exists/)
    }
    expect(fs.readFileSync(f, 'utf-8')).toBe('v1\n')
  })

  it('allows Edit right after Write by the same agent', async () => {
    const f = path.join(tmp, 'mix.md')
    const w = await toolWriteFile(f, 'hello world')
    expect(w.success).toBe(true)
    const e = await toolEditFile(f, 'hello', 'hi')
    expect(e.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('hi world')
  })

  it('a Write right after Edit on the same path is rejected — once the file exists, only edit_file can modify it', async () => {
    const f = path.join(tmp, 'mix2.md')
    fs.writeFileSync(f, 'first', 'utf-8')
    await toolReadFile(f)
    const e = await toolEditFile(f, 'first', 'second')
    expect(e.success).toBe(true)
    const w = await toolWriteFile(f, 'third')
    expect(w.success).toBe(false)
    if (!w.success) {
      expect(w.error).toMatch(/edit_file/)
    }
    expect(fs.readFileSync(f, 'utf-8')).toBe('second')
  })

  it('still detects external concurrent modification via mtime (via Edit, the only path that can re-mutate after self-write)', async () => {
    // Ported from Write to Edit: under the strengthened contract a chained
    // Write would be rejected by the preflight gate before ever reaching
    // the mtime check, so this regression is exercised through Edit. The
    // self-mutation receipt from the first Write seeds the read-receipt
    // store; an external mtime bump must defeat that receipt.
    const f = path.join(tmp, 'conflict.md')
    const first = await toolWriteFile(f, 'mine\n')
    expect(first.success).toBe(true)
    // Simulate an external process mutating the file AFTER the self-write.
    // Advance mtime into the future to defeat same-second timestamps on
    // filesystems with 1-second mtime resolution (FAT, some network FS).
    fs.writeFileSync(f, 'external\n', 'utf-8')
    const future = new Date(Date.now() + 5_000)
    fs.utimesSync(f, future, future)
    const second = await toolEditFile(f, 'external', 'mine2')
    expect(second.success).toBe(false)
    if (!second.success) {
      expect(second.error).toMatch(/modified on disk|mtime/i)
    }
    expect(fs.readFileSync(f, 'utf-8')).toBe('external\n')
  })
})

describe('toolEditFile no-op', () => {
  let tmp: string

  beforeEach(() => {
    clearAllReadFileState()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-edit-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('validateEditToolPayload rejects identical oldString/newString (registry pre-check)', () => {
    const v = validateEditToolPayload({
      filePath: path.join(tmp, 'x.ts'),
      oldString: 'a',
      newString: 'a',
    })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.message).toMatch(/identical/i)
  })

  it('toolEditFile: identical strings are a successful no-op after read_file (substring replace unchanged)', async () => {
    const f = path.join(tmp, 'same.txt')
    fs.writeFileSync(f, 'hello', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, 'hello', 'hello')
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/already matches/i)
  })

  it('skips write when result equals original (identical single occurrence substring)', async () => {
    const f = path.join(tmp, 'noop.txt')
    fs.writeFileSync(f, 'aXb', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, 'X', 'X')
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/already matches/i)
  })
})
