/**
 * Behaviour tests for the cross-process consolidation lock.
 *
 * We can't spawn a real second Electron process inside vitest, but the
 * lock's contract is filesystem-level (mtime + PID file body), so we
 * can simulate "other-process holders" by writing the file directly
 * with a foreign PID and stat-touching the mtime.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  readLastConsolidatedAt,
  tryAcquireConsolidationLock,
  rollbackConsolidationLock,
  recordConsolidation,
  withConsolidationLock,
} from './consolidationLock'

const LOCK_FILE = '.consolidate-lock'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidation-lock-'))
})

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* tmpdir cleanup is best-effort */
  }
})

function lockFile(): string {
  return path.join(tmpDir, LOCK_FILE)
}

/**
 * Pick a PID that the OS reports as "not running". 1 is init on POSIX
 * (always alive) and 4 is the System process on Windows (always alive),
 * so we pick something arbitrarily high and unlikely to exist. We then
 * verify the choice is actually dead — otherwise the test would be
 * non-deterministic.
 */
function pickDeadPid(): number {
  for (const candidate of [987_654_321, 987_654_320, 999_999_990]) {
    try {
      process.kill(candidate, 0)
      // alive — pick another
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ESRCH') return candidate
    }
  }
  throw new Error('could not find a dead PID for test fixture')
}

describe('consolidationLock — readLastConsolidatedAt', () => {
  it('returns 0 when the lock file does not exist', async () => {
    expect(await readLastConsolidatedAt(tmpDir)).toBe(0)
  })

  it('returns the file mtime when present', async () => {
    await fsp.writeFile(lockFile(), '123', 'utf-8')
    const stat = await fsp.stat(lockFile())
    expect(await readLastConsolidatedAt(tmpDir)).toBe(stat.mtimeMs)
  })
})

describe('consolidationLock — tryAcquireConsolidationLock', () => {
  it('acquires when no prior lock exists, returning priorMtime=0', async () => {
    const prior = await tryAcquireConsolidationLock(tmpDir)
    expect(prior).toBe(0)
    // After acquire, the file contains our PID.
    const body = await fsp.readFile(lockFile(), 'utf-8')
    expect(parseInt(body.trim(), 10)).toBe(process.pid)
  })

  it('refuses to acquire when a live foreign holder is present and recent', async () => {
    // Plant a "live holder" using OUR pid (it really is alive — process.pid
    // belongs to vitest itself). The acquire path will see PID alive +
    // mtime fresh → bail.
    await fsp.writeFile(lockFile(), String(process.pid), 'utf-8')
    const prior = await tryAcquireConsolidationLock(tmpDir)
    expect(prior).toBeNull()
  })

  it('reclaims a stale lock whose PID is dead', async () => {
    await fsp.writeFile(lockFile(), String(pickDeadPid()), 'utf-8')
    const prior = await tryAcquireConsolidationLock(tmpDir)
    expect(prior).not.toBeNull()
    // Reclaim wrote our PID over the dead one.
    const body = await fsp.readFile(lockFile(), 'utf-8')
    expect(parseInt(body.trim(), 10)).toBe(process.pid)
  })

  it('reclaims a lock whose mtime is older than HOLDER_STALE_MS, regardless of PID liveness', async () => {
    // Plant OUR PID as holder (live) but rewind mtime past the 60-minute cap.
    await fsp.writeFile(lockFile(), String(process.pid), 'utf-8')
    const ancient = (Date.now() - 2 * 60 * 60 * 1000) / 1000 // 2 hours ago, seconds
    await fsp.utimes(lockFile(), ancient, ancient)
    const prior = await tryAcquireConsolidationLock(tmpDir)
    expect(prior).not.toBeNull()
  })
})

describe('consolidationLock — rollbackConsolidationLock', () => {
  it('rewinds mtime to priorMtime after a failed acquire→run cycle', async () => {
    // Pretend nothing existed before our run; we acquired then failed.
    await tryAcquireConsolidationLock(tmpDir)
    const before = await fsp.stat(lockFile())
    expect(before.mtimeMs).toBeGreaterThan(0)

    const priorMtime = before.mtimeMs - 10_000 // pretend pre-acquire mtime
    await rollbackConsolidationLock(tmpDir, priorMtime)

    const after = await fsp.stat(lockFile())
    // Rollback rewound mtime + cleared PID body.
    expect(Math.round(after.mtimeMs)).toBe(Math.round(priorMtime))
    const body = await fsp.readFile(lockFile(), 'utf-8')
    expect(body).toBe('')
  })

  it('unlinks the file when priorMtime is 0 (no prior file)', async () => {
    await tryAcquireConsolidationLock(tmpDir)
    expect(fs.existsSync(lockFile())).toBe(true)
    await rollbackConsolidationLock(tmpDir, 0)
    expect(fs.existsSync(lockFile())).toBe(false)
  })

  it('is best-effort: succeeds quietly when the lock file is already gone', async () => {
    await expect(rollbackConsolidationLock(tmpDir, 12_345)).resolves.toBeUndefined()
  })
})

describe('consolidationLock — recordConsolidation', () => {
  it('creates the lock file with empty PID body when absent', async () => {
    await recordConsolidation(tmpDir)
    expect(fs.existsSync(lockFile())).toBe(true)
    const body = await fsp.readFile(lockFile(), 'utf-8')
    expect(body).toBe('')
  })

  it('refreshes the mtime when the file already exists', async () => {
    await fsp.writeFile(lockFile(), 'old', 'utf-8')
    const ancient = (Date.now() - 60_000) / 1000
    await fsp.utimes(lockFile(), ancient, ancient)
    const before = await fsp.stat(lockFile())

    await recordConsolidation(tmpDir)
    const after = await fsp.stat(lockFile())
    expect(after.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs)
  })
})

describe('consolidationLock — withConsolidationLock', () => {
  it('runs the function and clears the PID body on success', async () => {
    const result = await withConsolidationLock(tmpDir, async () => {
      // Inside the lock: the file body MUST be our PID, proving the lock
      // is actually held.
      const body = await fsp.readFile(lockFile(), 'utf-8')
      expect(parseInt(body.trim(), 10)).toBe(process.pid)
      return 'computed-value'
    })
    expect(result).toBe('computed-value')
    // After release the body is empty so the next acquire doesn't see us
    // as a live holder.
    const after = await fsp.readFile(lockFile(), 'utf-8')
    expect(after).toBe('')
  })

  it('rolls back the lock when the function throws', async () => {
    // Plant a pre-existing mtime → expect rollback to restore it.
    await fsp.writeFile(lockFile(), String(pickDeadPid()), 'utf-8')
    const planted = Date.now() - 60_000
    await fsp.utimes(lockFile(), planted / 1000, planted / 1000)

    const failingTask = async (): Promise<string> => {
      throw new Error('boom')
    }
    await expect(withConsolidationLock(tmpDir, failingTask)).rejects.toThrow('boom')

    const after = await fsp.stat(lockFile())
    // Rollback restored mtime to within a second of planted (utimes
    // resolution).
    expect(Math.abs(after.mtimeMs - planted)).toBeLessThan(1_500)
    // And cleared the PID body so the lock looks unheld for the next caller.
    const body = await fsp.readFile(lockFile(), 'utf-8')
    expect(body).toBe('')
  })

  it('returns null when the lock cannot be acquired', async () => {
    // Plant a LIVE holder (our PID) at fresh mtime.
    await fsp.writeFile(lockFile(), String(process.pid), 'utf-8')

    let ranInner = false
    const result = await withConsolidationLock(tmpDir, async () => {
      ranInner = true
      return 'should-never-run'
    })
    expect(result).toBeNull()
    expect(ranInner).toBe(false)
  })
})
