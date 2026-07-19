/**
 * Regression tests for the "File has been modified on disk since it was read"
 * error that the user reported firing on a brand-new-file create workflow.
 *
 * Original scenario: AI creates a blank file and writes content; approval
 * dialog shows the correct diff; user clicks accept; content lands on disk;
 * tool then reports "mtime changed". These tests reproduce (or pin down)
 * each variant of the "blank file" workflow so we can rule out integrity-
 * guard / read-receipt issues as the source and localise the real cause.
 *
 * Contract update (current): write_file is now ONLY for creating NEW files.
 * ANY pre-existing path — even a zero-byte empty file — is rejected up-front
 * by the centralised preflight gate, before the read-receipt / mtime checks
 * run. The mtime/snapshot regression scenarios that used to exercise Write
 * therefore use Edit here: the read-before-edit gate
 * (`validateReadReceiptForEdit`) has the same snapshot fallback as the old
 * Write gate, so the regression intent is preserved exactly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toolWriteFile, toolEditFile, toolReadFile } from './tools'
import { setWorkspacePath } from '../tools/workspaceState'
import { clearAllReadFileState, recordSuccessfulRead } from '../tools/readFileState'

describe('new-file-create does NOT emit mtime errors', () => {
  let tmp: string

  beforeEach(() => {
    clearAllReadFileState()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-newfile-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // ── Write tool, non-existent path (the ONLY legitimate Write target) ──
  it('Write creates a brand-new file with content (no prior Read, no prior receipt)', async () => {
    const f = path.join(tmp, 'brand-new.txt')
    expect(fs.existsSync(f)).toBe(false)
    const r = await toolWriteFile(f, 'hello world')
    expect(r.success).toBe(true)
    expect(r.error).toBeUndefined()
    expect(fs.readFileSync(f, 'utf-8')).toBe('hello world')
  })

  it('Write then Write again on the same path is rejected — must use Edit for the second hop', async () => {
    // Under the strengthened contract, the second Write hits an existing
    // file (even though the same agent authored it) and must route through
    // edit_file. The mtime/snapshot tolerance that used to allow chained
    // self-mutation Writes is now exercised through Edit instead (see
    // separate test below).
    const f = path.join(tmp, 'twice.txt')
    const r1 = await toolWriteFile(f, 'first')
    expect(r1.success).toBe(true)
    const r2 = await toolWriteFile(f, 'second')
    expect(r2.success).toBe(false)
    if (!r2.success) {
      expect(r2.error).toMatch(/edit_file/)
      expect(r2.error).toMatch(/already exists/)
    }
    // File untouched by the rejected second Write.
    expect(fs.readFileSync(f, 'utf-8')).toBe('first')
  })

  // ── Edit tool, create-via-empty-old_string ───────────────────────────
  it('Edit with empty old_string creates a brand-new file (OpenClaude create semantics)', async () => {
    const f = path.join(tmp, 'via-edit.ts')
    const r = await toolEditFile(f, '', 'export const x = 1\n')
    expect(r.success).toBe(true)
    expect(r.error).toBeUndefined()
    expect(fs.readFileSync(f, 'utf-8')).toBe('export const x = 1\n')
  })

  it('Edit with empty old_string then Write content on the same path is rejected', async () => {
    // Create-via-edit lands content on disk; a follow-up Write now hits
    // an existing file and must route through edit_file.
    const f = path.join(tmp, 'edit-then-write.ts')
    const r1 = await toolEditFile(f, '', 'v1\n')
    expect(r1.success).toBe(true)
    const r2 = await toolWriteFile(f, 'v2\n')
    expect(r2.success).toBe(false)
    if (!r2.success) {
      expect(r2.error).toMatch(/edit_file/)
    }
    expect(fs.readFileSync(f, 'utf-8')).toBe('v1\n')
  })

  // ── Pre-existing empty file: Write is rejected up-front ──────────────
  it('Write into a pre-existing empty file is rejected by the preflight gate (use Edit instead)', async () => {
    // Under the old contract this was rejected with "has not been read";
    // under the new contract the centralised preflight runs first and
    // returns the canonical "use edit_file" wording, so the AI is told
    // the right corrective action immediately instead of wasting a Read
    // round-trip on a Write that would still be rejected afterwards.
    const f = path.join(tmp, 'pre-existing-empty.txt')
    fs.writeFileSync(f, '', 'utf-8')
    const r = await toolWriteFile(f, 'ai-content')
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toMatch(/edit_file/)
      expect(r.error).toMatch(/already exists/)
      expect(r.error).not.toMatch(/has not been read/i)
    }
    expect(fs.readFileSync(f, 'utf-8')).toBe('')
  })

  it('Edit with empty old_string into a pre-existing empty file succeeds (the correct create-into-empty flow)', async () => {
    // Documents the recovery path the preflight rejection above points at:
    // for an empty pre-existing file the AI must call edit_file with an
    // empty oldString to insert content.
    const f = path.join(tmp, 'pre-existing-empty-via-edit.txt')
    fs.writeFileSync(f, '', 'utf-8')
    const r = await toolEditFile(f, '', 'ai-content')
    expect(r.success).toBe(true)
    expect(r.error).toBeUndefined()
    expect(fs.readFileSync(f, 'utf-8')).toBe('ai-content')
  })

  // ── mtime/snapshot tolerance regressions (now exercised on Edit) ─────
  it('Approval-UI read-receipt stamping then Edit (happy path) — no spurious mtime-changed error', async () => {
    // Models what runAgenticToolUse does after the user clicks accept on
    // the diff approval dialog: it records a read receipt with the current
    // disk mtime + full content. The subsequent tool execution must pass
    // the mtime gate without issuing a false "mtime changed" verdict.
    // (Same regression intent as the Write-era version of this test.)
    const f = path.join(tmp, 'approval-flow.txt')
    fs.writeFileSync(f, 'prior-content', 'utf-8')
    const stat = fs.statSync(f)
    recordSuccessfulRead(f, {
      mtimeMs: stat.mtimeMs,
      isPartialView: false,
      fullFileContent: 'prior-content',
    })
    const r = await toolEditFile(f, 'prior-content', 'new-content')
    expect(r.success).toBe(true)
    expect(r.error).toBeUndefined()
    expect(fs.readFileSync(f, 'utf-8')).toBe('new-content')
  })

  it('Regression: read-before-edit must tolerate mtimeMs float drift by falling back to content snapshot', async () => {
    // Exact reproduction of the user-reported failure surface, ported
    // from Write to Edit: receipt mtime drifts by a sub-millisecond from
    // the live disk mtime while disk content is unchanged. The snapshot
    // fallback in validateReadReceiptForEdit must absorb the drift.
    //
    // Windows NTFS 100-ns filesystem time ↔ JS double-precision ms is
    // lossy across consecutive stat calls; without the snapshot fallback
    // a benign sub-ms drift produces a spurious "mtime changed" error.
    const f = path.join(tmp, 'drift.txt')
    fs.writeFileSync(f, 'unchanged', 'utf-8')
    const stat = fs.statSync(f)
    recordSuccessfulRead(f, {
      mtimeMs: stat.mtimeMs + 0.001,
      isPartialView: false,
      fullFileContent: 'unchanged',
    })
    const r = await toolEditFile(f, 'unchanged', 'ai-new-content')
    expect(r.success).toBe(true)
    expect(r.error).toBeUndefined()
    expect(fs.readFileSync(f, 'utf-8')).toBe('ai-new-content')
  })

  it('Regression: LARGE file (> snapshot cap) tolerates benign mtime drift via the content HASH fallback', async () => {
    // Root cause of the user-reported "I never touched the file but every
    // edit says mtime changed": `contentSnapshot` is truncated to
    // MAX_SNAPSHOT_CHARS (512 KB) for heap safety, so for any larger file the
    // verbatim `snapshot === diskContent` fallback can NEVER match. Before the
    // fix, that meant a purely benign mtime drift (unchanged bytes) surfaced
    // the hard "modified on disk" error on every edit of a big file. The
    // full-content `contentHash` is NOT truncated, so the hash branch must
    // absorb the drift here.
    const f = path.join(tmp, 'large.txt')
    // > 512 KB so the receipt snapshot is provably truncated.
    const big = 'x'.repeat(600_000)
    const content = `${big}\nUNIQUE_MARKER\n`
    fs.writeFileSync(f, content, 'utf-8')
    const stat = fs.statSync(f)
    recordSuccessfulRead(f, {
      // Sub-ms drift: differs from the live disk mtime so the gate falls
      // through to the content-identity branches.
      mtimeMs: stat.mtimeMs + 0.001,
      isPartialView: false,
      fullFileContent: content,
    })
    const r = await toolEditFile(f, 'UNIQUE_MARKER', 'REPLACED_MARKER')
    expect(r.success).toBe(true)
    expect(r.error).toBeUndefined()
    expect(fs.readFileSync(f, 'utf-8')).toBe(`${big}\nREPLACED_MARKER\n`)
  })

  it('Regression: LARGE file with a GENUINE on-disk change is STILL rejected (hash mismatch)', async () => {
    // The hash fallback must not over-correct: if the bytes genuinely differ,
    // both the (truncated) snapshot AND the full-content hash disagree, so the
    // gate keeps rejecting an edit built on stale knowledge.
    const f = path.join(tmp, 'large-changed.txt')
    const big = 'x'.repeat(600_000)
    const onDisk = `${big}\nON_DISK_NOW\n`
    fs.writeFileSync(f, onDisk, 'utf-8')
    recordSuccessfulRead(f, {
      mtimeMs: 0,
      isPartialView: false,
      // What the agent THOUGHT was there — different bytes ⇒ different hash.
      fullFileContent: `${big}\nWHAT_AGENT_THOUGHT\n`,
    })
    const r = await toolEditFile(f, 'ON_DISK_NOW', 'AI_NEW')
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toMatch(/mtime changed|modified on disk/i)
    }
    expect(fs.readFileSync(f, 'utf-8')).toBe(onDisk)
  })

  it('Regression: approval-race — receipt stamped at approval, disk rewritten by renderer auto-save before tool runs', async () => {
    // Reproduces the user-reported bug, ported to Edit (Write would now
    // be rejected up-front by preflight on the pre-existing file):
    //
    //   1. Post-approval stamping records a receipt with pre-write disk
    //      state  { mtime: M_pre, snapshot: C_pre }  .
    //   2. Before the backend tool runs, the inline-diff accept flow in
    //      the renderer pushes model.setValue(C_post) → Monaco onChange →
    //      EditorArea's auto-save timer fires → fs.writeFileSync lands
    //      C_post on disk, bumping mtime to M_post.
    //   3. runAgenticToolUse re-stamps the receipt with (M_post, C_post)
    //      immediately before tool execution.
    //
    // The tool must succeed: the bytes the renderer wrote ARE the bytes
    // the user approved, so the follow-up tool change is either a no-op
    // or the same approved change.
    const f = path.join(tmp, 'approval-race.txt')
    fs.writeFileSync(f, 'pre-approval content', 'utf-8')
    const statPre = fs.statSync(f)
    recordSuccessfulRead(f, {
      mtimeMs: statPre.mtimeMs,
      isPartialView: false,
      fullFileContent: 'pre-approval content',
    })
    await new Promise((r) => setTimeout(r, 10))
    fs.writeFileSync(f, 'post-approval content', 'utf-8')
    const statLate = fs.statSync(f)
    recordSuccessfulRead(f, {
      mtimeMs: statLate.mtimeMs,
      isPartialView: false,
      fullFileContent: 'post-approval content',
    })
    const r = await toolEditFile(f, 'post-approval content', 'tool-applied content')
    expect(r.success).toBe(true)
    expect(r.error).toBeUndefined()
    expect(fs.readFileSync(f, 'utf-8')).toBe('tool-applied content')
  })

  it('Root cause B: a second writer between consecutive edits triggers the "before editing or writing" error', async () => {
    // Pins the renderer-autosave clobber the user reported on CONSECUTIVE
    // edits:
    //
    //   1. edit #1 lands C1 on disk and refreshes the self-mutation read
    //      receipt to (mtime_1, C1).
    //   2. The file is open in the editor with an unsaved (dirty) buffer, so
    //      the `workspace:file-changed` reload is SKIPPED. 1.5 s later the
    //      renderer's debounced autosave writes that stale buffer (C2 != C1)
    //      back to disk, bumping mtime past mtime_1.
    //   3. edit #2 arrives WITHOUT baseReadId (the common case once the model
    //      stops threading the fresh readId), so it falls back to
    //      `assertReadBeforeWrite` → `validateReadReceipt`: mtime differs AND
    //      the receipt snapshot (C1) no longer equals disk (C2) → the exact
    //      user-facing error.
    //
    // This is the failure the renderer-side autosave conflict guard
    // (decideAutoSave) prevents at the source by refusing to write C2 over
    // C1 once the disk diverged from the buffer's baseline.
    const f = path.join(tmp, 'consecutive.txt')
    fs.writeFileSync(f, 'line1\nline2\n', 'utf-8')
    await toolReadFile(f)

    const e1 = await toolEditFile(f, 'line1', 'LINE-ONE')
    expect(e1.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('LINE-ONE\nline2\n')

    // Simulate the renderer autosave clobbering the AI's edit with a stale
    // buffer. utimesSync forces a deterministically newer mtime so the test
    // does not depend on filesystem timestamp resolution.
    fs.writeFileSync(f, 'stale-buffer-from-editor\n', 'utf-8')
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(f, future, future)

    // edit #2 with no baseReadId → legacy mtime/write gate.
    const e2 = await toolEditFile(f, 'LINE-ONE', 'LINE-1-AGAIN')
    expect(e2.success).toBe(false)
    if (!e2.success) {
      expect(e2.error).toMatch(/before editing or writing/)
    }
    // The AI's bytes were already destroyed by the second writer — exactly the
    // data-loss the renderer guard exists to prevent.
    expect(fs.readFileSync(f, 'utf-8')).toBe('stale-buffer-from-editor\n')
  })

  it('Regression: read-before-edit STILL rejects when content genuinely changed', async () => {
    // Must not over-correct: if the receipt's mtime AND content both
    // disagree with the live disk state, the gate still rejects — that's
    // the case the in-tool re-check exists to catch. Ported to Edit.
    const f = path.join(tmp, 'genuine-change.txt')
    fs.writeFileSync(f, 'on-disk-now', 'utf-8')
    recordSuccessfulRead(f, {
      mtimeMs: 0,
      isPartialView: false,
      fullFileContent: 'what-agent-thought-was-there',
    })
    const r = await toolEditFile(f, 'on-disk-now', 'ai-new-content')
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toMatch(/mtime changed|modified on disk/i)
    }
    expect(fs.readFileSync(f, 'utf-8')).toBe('on-disk-now')
  })

  // ── Sanity: an explicit Read still enables Edit-create flows ─────────
  it('Read of an existing empty file followed by Edit-with-empty-old_string succeeds', async () => {
    const f = path.join(tmp, 'pre-existing-empty-read.txt')
    fs.writeFileSync(f, '', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, '', 'ai-content')
    expect(r.success).toBe(true)
    expect(r.error).toBeUndefined()
    expect(fs.readFileSync(f, 'utf-8')).toBe('ai-content')
  })
})
