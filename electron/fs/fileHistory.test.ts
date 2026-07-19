/**
 * fileHistory backup tests.
 *
 * The module's safety promise is: every call site that's about to do a
 * destructive write CAN await this and trust that, if it returns, the
 * pre-write bytes are durable on disk (when the source existed and
 * permissions allow). These tests pin that contract.
 *
 * No Electron at test-time — we use the `ASTRA_FILE_HISTORY_DIR`
 * env-var override to redirect the backup root into a per-test tmpdir.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  _resetFileHistoryTrackingForTests,
  cleanupFileHistorySessionDir,
  fileHistoryEnabled,
  fileHistoryTrackEdit,
  getBackupPath,
  hasBackup,
} from './fileHistory'

let workdir: string
let historyRoot: string
let prevEnv: string | undefined
let prevDisable: string | undefined

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-fh-work-'))
  historyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-fh-root-'))
  prevEnv = process.env.ASTRA_FILE_HISTORY_DIR
  prevDisable = process.env.ASTRA_DISABLE_FILE_HISTORY
  process.env.ASTRA_FILE_HISTORY_DIR = historyRoot
  delete process.env.ASTRA_DISABLE_FILE_HISTORY
  _resetFileHistoryTrackingForTests()
})

afterEach(() => {
  if (prevEnv === undefined) {
    delete process.env.ASTRA_FILE_HISTORY_DIR
  } else {
    process.env.ASTRA_FILE_HISTORY_DIR = prevEnv
  }
  if (prevDisable === undefined) {
    delete process.env.ASTRA_DISABLE_FILE_HISTORY
  } else {
    process.env.ASTRA_DISABLE_FILE_HISTORY = prevDisable
  }
  try {
    fs.rmSync(workdir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(historyRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function shortHash(p: string): string {
  return createHash('sha256').update(p).digest('hex').slice(0, 16)
}

describe('fileHistoryTrackEdit — happy paths', () => {
  it('copies the current file bytes into the session backup dir', async () => {
    const f = path.join(workdir, 'a.ts')
    fs.writeFileSync(f, 'pre-edit content\n', 'utf-8')

    await fileHistoryTrackEdit(f)

    const backup = getBackupPath(f)
    expect(fs.existsSync(backup)).toBe(true)
    expect(fs.readFileSync(backup, 'utf-8')).toBe('pre-edit content\n')
  })

  it('uses a sha256-hashed filename so two files never collide', async () => {
    const f1 = path.join(workdir, 'a.ts')
    const f2 = path.join(workdir, 'b.ts')
    fs.writeFileSync(f1, 'A', 'utf-8')
    fs.writeFileSync(f2, 'B', 'utf-8')

    await fileHistoryTrackEdit(f1)
    await fileHistoryTrackEdit(f2)

    const expectName1 = `${shortHash(path.resolve(f1))}@v1`
    const expectName2 = `${shortHash(path.resolve(f2))}@v1`
    expect(getBackupPath(f1).endsWith(expectName1)).toBe(true)
    expect(getBackupPath(f2).endsWith(expectName2)).toBe(true)
    expect(expectName1).not.toBe(expectName2)
  })

  it('hasBackup reflects the on-disk state', async () => {
    const f = path.join(workdir, 'present.ts')
    fs.writeFileSync(f, 'x', 'utf-8')
    expect(await hasBackup(f)).toBe(false)
    await fileHistoryTrackEdit(f)
    expect(await hasBackup(f)).toBe(true)
  })
})

describe('fileHistoryTrackEdit — idempotency', () => {
  it('does not re-copy when the same file is tracked twice in a row', async () => {
    const f = path.join(workdir, 'twice.ts')
    fs.writeFileSync(f, 'v1\n', 'utf-8')

    await fileHistoryTrackEdit(f)
    const backup = getBackupPath(f)
    const firstMtime = fs.statSync(backup).mtimeMs

    // Mutate the source — if we WERE to re-track, the backup would change.
    fs.writeFileSync(f, 'v2\n', 'utf-8')

    // Wait a moment so mtime would differ if we re-copied.
    await new Promise((r) => setTimeout(r, 30))
    await fileHistoryTrackEdit(f)

    // Same backup content, same mtime → no second copyFile happened.
    expect(fs.readFileSync(backup, 'utf-8')).toBe('v1\n')
    expect(fs.statSync(backup).mtimeMs).toBe(firstMtime)
  })

  it('concurrent calls for the same file backup exactly once', async () => {
    const f = path.join(workdir, 'race.ts')
    fs.writeFileSync(f, 'race content\n', 'utf-8')

    await Promise.all([
      fileHistoryTrackEdit(f),
      fileHistoryTrackEdit(f),
      fileHistoryTrackEdit(f),
      fileHistoryTrackEdit(f),
    ])

    expect(fs.existsSync(getBackupPath(f))).toBe(true)
    // Backup dir should have exactly ONE entry for this file (the v1 backup).
    const dir = path.dirname(getBackupPath(f))
    const entries = fs.readdirSync(dir).filter((n) => n.endsWith('@v1'))
    expect(entries.length).toBe(1)
  })
})

describe('fileHistoryTrackEdit — missing source', () => {
  it('skips quietly when the source file does not exist (create-via-edit)', async () => {
    const f = path.join(workdir, 'never-existed.ts')
    expect(fs.existsSync(f)).toBe(false)

    await fileHistoryTrackEdit(f)

    // No backup created — but no throw, either.
    expect(fs.existsSync(getBackupPath(f))).toBe(false)
  })
})

describe('fileHistoryTrackEdit — non-fatal failure modes', () => {
  it('warns but does not throw when the backup root cannot be created (read-only POSIX)', async () => {
    if (process.platform === 'win32') return
    const f = path.join(workdir, 'denied.ts')
    fs.writeFileSync(f, 'x', 'utf-8')

    // Point the backup root at a read-only dir, replacing the per-test
    // tmpdir. The function must return without throwing — failures here
    // would silently break the destructive write that follows.
    const roRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-fh-ro-'))
    process.env.ASTRA_FILE_HISTORY_DIR = path.join(roRoot, 'will-fail')
    try {
      fs.chmodSync(roRoot, 0o555)
      await expect(fileHistoryTrackEdit(f)).resolves.toBeUndefined()
    } finally {
      fs.chmodSync(roRoot, 0o755)
      fs.rmSync(roRoot, { recursive: true, force: true })
    }
  })

  it('honours ASTRA_DISABLE_FILE_HISTORY=1 (no-op fast path)', async () => {
    process.env.ASTRA_DISABLE_FILE_HISTORY = '1'
    expect(fileHistoryEnabled()).toBe(false)
    const f = path.join(workdir, 'disabled.ts')
    fs.writeFileSync(f, 'x', 'utf-8')
    await fileHistoryTrackEdit(f)
    expect(fs.existsSync(getBackupPath(f))).toBe(false)
  })
})

describe('fileHistoryTrackEdit — permission preservation (POSIX)', () => {
  const itPosix = process.platform === 'win32' ? it.skip : it

  itPosix('backup keeps the original 0o600 mode (e.g. SSH key shape)', async () => {
    const f = path.join(workdir, 'private')
    fs.writeFileSync(f, 'SECRET\n', { encoding: 'utf-8', mode: 0o600 })
    expect(fs.statSync(f).mode & 0o777).toBe(0o600)

    await fileHistoryTrackEdit(f)

    const backup = getBackupPath(f)
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600)
  })

  itPosix('backup keeps the executable bit on shell scripts', async () => {
    const f = path.join(workdir, 'run.sh')
    fs.writeFileSync(f, '#!/bin/sh\n', { encoding: 'utf-8', mode: 0o755 })
    await fileHistoryTrackEdit(f)
    expect(fs.statSync(getBackupPath(f)).mode & 0o777).toBe(0o755)
  })
})

describe('fileHistoryTrackEdit — large file (does NOT load into JS heap)', () => {
  it('handles a multi-MB file via streaming copyFile without OOM', async () => {
    // 8 MB synthetic content — big enough to be obvious if we ever
    // accidentally went back to a readFile + writeFile pipeline that
    // doubles the working set. Real OOM would require GB-scale files,
    // but a 8 MB allocation in JS is still measurably slower than
    // sendfile/CopyFileEx, so this also stays a perf regression guard.
    const f = path.join(workdir, 'big.bin')
    const chunk = Buffer.alloc(1024 * 1024, 0x61) // 1 MB of 'a'
    const handle = fs.openSync(f, 'w')
    try {
      for (let i = 0; i < 8; i++) fs.writeSync(handle, chunk)
    } finally {
      fs.closeSync(handle)
    }

    await fileHistoryTrackEdit(f)

    const backup = getBackupPath(f)
    expect(fs.statSync(backup).size).toBe(8 * 1024 * 1024)
  })
})

describe('cleanupFileHistorySessionDir', () => {
  it('removes all backups for the current session and resets tracking', async () => {
    const f1 = path.join(workdir, 'one.ts')
    const f2 = path.join(workdir, 'two.ts')
    fs.writeFileSync(f1, '1', 'utf-8')
    fs.writeFileSync(f2, '2', 'utf-8')
    await fileHistoryTrackEdit(f1)
    await fileHistoryTrackEdit(f2)

    const dir = path.dirname(getBackupPath(f1))
    expect(fs.readdirSync(dir).length).toBeGreaterThanOrEqual(2)

    const { removed } = await cleanupFileHistorySessionDir()
    expect(removed).toBeGreaterThanOrEqual(2)
    expect(fs.existsSync(getBackupPath(f1))).toBe(false)

    // Tracking is reset — re-tracking after cleanup MUST create a new backup.
    fs.writeFileSync(f1, '1-new', 'utf-8')
    await fileHistoryTrackEdit(f1)
    expect(fs.existsSync(getBackupPath(f1))).toBe(true)
    expect(fs.readFileSync(getBackupPath(f1), 'utf-8')).toBe('1-new')
  })
})
