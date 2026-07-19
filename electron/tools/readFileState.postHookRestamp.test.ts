/**
 * Regression — double readId rotation after a successful edit (2026-07 fix).
 *
 * Sequence under test (mirrors the agentic loop's post-hook re-stamp block in
 * `runAgenticToolUseBody.ts`):
 *   1. edit_file succeeds → `recordSelfMutationReadReceipt` rotates the readId
 *      to X and the tool output trailer promises "readId for next edit: X".
 *   2. `runPostToolHooksSafe` runs; the loop then re-stamps the receipt so it
 *      reflects any hook-side file mutation (formatter / lint-fix).
 *
 * The bug: the re-stamp called `recordSuccessfulRead` UNCONDITIONALLY, which
 * always generates a fresh readId Y and unregisters X — so the id the model
 * was explicitly told to use was already dead, and every chained edit failed
 * once with READ_ID_NOT_FOUND ("baseReadId … is unknown or expired").
 *
 * The fix: the loop consults `hasCurrentScopeReceiptMatchingDisk` first and
 * skips the re-stamp when no hook actually touched the file, keeping X valid.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertReadBeforeEditByReadId,
  clearAllReadFileState,
  findReadReceiptByReadId,
  hasCurrentScopeReceiptMatchingDisk,
  recordSelfMutationReadReceipt,
  recordSuccessfulRead,
} from './readFileState'

describe('hasCurrentScopeReceiptMatchingDisk — post-hook re-stamp guard', () => {
  let tmp: string
  let filePath: string

  beforeEach(() => {
    clearAllReadFileState()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-restamp-'))
    filePath = path.join(tmp, 'target.ts')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('returns false when the path has no receipt in the current scope', () => {
    fs.writeFileSync(filePath, 'const a = 1\n', 'utf-8')
    const stat = fs.statSync(filePath)
    expect(
      hasCurrentScopeReceiptMatchingDisk(filePath, stat.mtimeMs, 'const a = 1\n'),
    ).toBe(false)
  })

  it('returns true right after a self-mutation receipt when hooks did not touch the file', () => {
    const content = 'const a = 1\n'
    fs.writeFileSync(filePath, content, 'utf-8')
    const refreshed = recordSelfMutationReadReceipt(filePath, content)
    expect(refreshed?.readId).toBeDefined()

    const statNow = fs.statSync(filePath)
    const diskNow = fs.readFileSync(filePath, 'utf-8')
    expect(hasCurrentScopeReceiptMatchingDisk(filePath, statNow.mtimeMs, diskNow)).toBe(true)
  })

  it('returns false when a hook modified the file content after the write', () => {
    const content = 'const a = 1\n'
    fs.writeFileSync(filePath, content, 'utf-8')
    recordSelfMutationReadReceipt(filePath, content)

    // Simulate a PostToolUse formatter rewriting the file.
    const formatted = 'const a = 1;\n'
    fs.writeFileSync(filePath, formatted, 'utf-8')
    const statNow = fs.statSync(filePath)
    expect(hasCurrentScopeReceiptMatchingDisk(filePath, statNow.mtimeMs, formatted)).toBe(false)
  })

  it('returns false on an mtime bump even with identical bytes (conservative: re-stamp)', () => {
    const content = 'const a = 1\n'
    fs.writeFileSync(filePath, content, 'utf-8')
    recordSelfMutationReadReceipt(filePath, content)
    // Same bytes, different mtime — e.g. a hook re-saved the identical file.
    const future = new Date(Date.now() + 5_000)
    fs.utimesSync(filePath, future, future)
    const statNow = fs.statSync(filePath)
    expect(hasCurrentScopeReceiptMatchingDisk(filePath, statNow.mtimeMs, content)).toBe(false)
  })

  it('REGRESSION: the trailer-promised readId survives the loop re-stamp decision and passes the edit gate', () => {
    const content = 'const a = 1\nconst b = 2\n'
    fs.writeFileSync(filePath, content, 'utf-8')

    // Step 1 — edit tool success path promises this id to the model.
    const refreshed = recordSelfMutationReadReceipt(filePath, content)
    expect(refreshed?.readId).toBeDefined()
    const promisedId = refreshed!.readId

    // Step 2 — the loop's post-hook block: no hook touched the file, so the
    // guarded re-stamp is a no-op (this is the fixed behaviour; previously it
    // called recordSuccessfulRead unconditionally and killed `promisedId`).
    const statNow = fs.statSync(filePath)
    const diskNow = fs.readFileSync(filePath, 'utf-8')
    if (!hasCurrentScopeReceiptMatchingDisk(filePath, statNow.mtimeMs, diskNow)) {
      recordSuccessfulRead(filePath, {
        mtimeMs: statNow.mtimeMs,
        isPartialView: false,
        fullFileContent: diskNow,
        source: 'self_mutation',
      })
    }

    // Step 3 — the next chained edit echoes the promised id: must resolve and
    // pass the hash-anchored gate instead of READ_ID_NOT_FOUND.
    expect(findReadReceiptByReadId(promisedId)).toBeDefined()
    const gate = assertReadBeforeEditByReadId(
      filePath,
      promisedId,
      diskNow,
      'const b = 2',
      'const b = 3',
    )
    expect(gate.ok).toBe(true)
  })

  it('still rotates (and invalidates the old id) when a hook DID change the file', () => {
    const content = 'const a = 1\n'
    fs.writeFileSync(filePath, content, 'utf-8')
    const refreshed = recordSelfMutationReadReceipt(filePath, content)
    const promisedId = refreshed!.readId

    const formatted = 'const a = 1;\n'
    fs.writeFileSync(filePath, formatted, 'utf-8')
    const statNow = fs.statSync(filePath)
    if (!hasCurrentScopeReceiptMatchingDisk(filePath, statNow.mtimeMs, formatted)) {
      recordSuccessfulRead(filePath, {
        mtimeMs: statNow.mtimeMs,
        isPartialView: false,
        fullFileContent: formatted,
        source: 'self_mutation',
      })
    }
    // Old id is dead — the receipt now reflects the post-hook bytes.
    expect(findReadReceiptByReadId(promisedId)).toBeUndefined()
  })
})
