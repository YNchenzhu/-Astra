/**
 * Cross-process consolidation lock — port of upstream
 * `src/services/autoDream/consolidationLock.ts` adapted for our workspace.
 *
 * Why this exists (audit finding F1): the autoConsolidate / memoryWorker
 * pipeline today only has an in-memory `Map<filename, owner>` lock
 * (`electron/memory/extractionState.ts > fileWriteLocks`). That guards
 * concurrent writers WITHIN the same Electron process, but NOT across
 * processes.
 *
 * Concrete failure modes the in-memory lock cannot prevent:
 *
 *   - Two Electron instances opened on the same workspace (dev + packaged,
 *     or two windows of the same packaged build with `--user-data-dir`
 *     pointing at the same disk path) both fire `executeAutoConsolidate`
 *     within the same window → both worker threads scan the same memory
 *     directory, both choose to merge the same near-duplicate pair, both
 *     `writeMemoryFileAsync` → one merge wins, the other clobbers it.
 *   - A previously crashed Electron host left stale `.consolidate-lock`
 *     state (PID 12345 in the file, but PID 12345 is now `node` or
 *     `chrome.exe` reusing the slot) → without PID-liveness re-check, a
 *     second host respects the dead lock forever.
 *
 * Design (mirrors upstream):
 *
 *   - Lock file lives at `<memoryDir>/.consolidate-lock`. Its mtime IS
 *     `lastConsolidatedAt` — readable with a single `stat`.
 *   - Body is the holder's PID (decimal text). On acquire, the candidate
 *     re-reads the file after writing — last writer wins; loser bails.
 *   - HOLDER_STALE_MS = 60 minutes: anything older is reclaimable even if
 *     the PID looks live (covers PID reuse on long-running OSes).
 *   - On consolidation FAILURE, `rollbackConsolidationLock(priorMtime)`
 *     rewinds the mtime so the next time-gate fires normally instead of
 *     being suppressed for `minHours` because of a failed run.
 *
 * Non-goals: we deliberately do NOT serialise pass-internal writes
 * (`writeMemoryFileAsync` / `deleteMemoryFileAsync`). Those are still
 * guarded by the in-memory lock at `extractionState.tryAcquireFileLock`
 * — which is correct for INTRA-process collisions between the
 * autoExtract pipeline and the consolidator. The cross-process lock here
 * only gates ENTRY into a consolidation pass, which is the granularity
 * that actually matters (a pass is either running or not; the in-process
 * lock then handles fine-grained file overlap within that pass).
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

const LOCK_FILENAME = '.consolidate-lock'

/** Anything older than this is reclaimable regardless of PID liveness. */
const HOLDER_STALE_MS = 60 * 60 * 1000

function lockPath(memoryDir: string): string {
  return path.join(memoryDir, LOCK_FILENAME)
}

/**
 * Best-effort liveness probe. Node's `process.kill(pid, 0)` throws on:
 *   - ESRCH: no process with that pid
 *   - EPERM: permission denied (process exists but not ours)
 *
 * EPERM means the PID is live but owned by another user — we treat that
 * as "alive" and don't reclaim. ESRCH (or any other code) means the slot
 * is free.
 */
function isProcessRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EPERM') return true
    return false
  }
}

/**
 * mtime of the lock file = lastConsolidatedAt. Returns 0 when the file
 * does not exist yet (never consolidated in this directory).
 *
 * One stat per call — keep this cheap; callers may invoke per-turn.
 */
export async function readLastConsolidatedAt(memoryDir: string): Promise<number> {
  try {
    const s = await fsp.stat(lockPath(memoryDir))
    return s.mtimeMs
  } catch {
    return 0
  }
}

/**
 * Attempt to acquire the consolidation lock for `memoryDir`. On success,
 * returns the pre-acquire mtime so a failed run can rewind via
 * {@link rollbackConsolidationLock}. On contention / live holder / lost
 * race, returns `null`.
 *
 *   Success → mtime now points at acquisition time; do consolidation.
 *   Failure → caller treats it as "another host is consolidating", skips.
 *   Crash   → mtime stuck, PID dead → next caller reclaims.
 */
export async function tryAcquireConsolidationLock(
  memoryDir: string,
): Promise<number | null> {
  const file = lockPath(memoryDir)

  let mtimeMs: number | undefined
  let holderPid: number | undefined
  try {
    // Parallel stat + read keeps the contention window tight: both happen
    // before we write our own PID.
    const [s, raw] = await Promise.all([
      fsp.stat(file),
      fsp.readFile(file, 'utf-8'),
    ])
    mtimeMs = s.mtimeMs
    const parsed = parseInt(raw.trim(), 10)
    holderPid = Number.isFinite(parsed) ? parsed : undefined
  } catch {
    // ENOENT — no prior lock.
  }

  if (
    mtimeMs !== undefined &&
    Date.now() - mtimeMs < HOLDER_STALE_MS &&
    holderPid !== undefined &&
    isProcessRunning(holderPid)
  ) {
    // Live holder, recent mtime. Bail.
    return null
  }

  // Either no prior lock, or prior holder is dead / stale: take it.
  await fsp.mkdir(memoryDir, { recursive: true })
  await fsp.writeFile(file, String(process.pid), 'utf-8')

  // Two reclaimers may have written simultaneously; whoever wrote LAST
  // wins. The loser re-reads and bails.
  let verify: string
  try {
    verify = await fsp.readFile(file, 'utf-8')
  } catch {
    return null
  }
  if (parseInt(verify.trim(), 10) !== process.pid) return null

  return mtimeMs ?? 0
}

/**
 * Rewind the lock's mtime + clear the PID body after a failed run, so the
 * next acquire sees the lock as if we never grabbed it. priorMtime === 0
 * means "no prior file" → unlink the file entirely.
 *
 * Best-effort: errors are swallowed because the next acquire's
 * `HOLDER_STALE_MS` check will eventually reclaim anyway.
 */
export async function rollbackConsolidationLock(
  memoryDir: string,
  priorMtime: number,
): Promise<void> {
  const file = lockPath(memoryDir)
  try {
    if (priorMtime === 0) {
      await fsp.unlink(file).catch(() => {})
      return
    }
    // Clear PID body so our (still-running) process doesn't look like
    // it's holding. utimes expects seconds (float).
    await fsp.writeFile(file, '', 'utf-8')
    const sec = priorMtime / 1000
    await fsp.utimes(file, sec, sec)
  } catch {
    /* best-effort */
  }
}

/**
 * Stamp the lock's mtime to `now` and clear the PID body. Called after a
 * successful manual `/dream`-style trigger or any non-locked entry point
 * that wants to declare "consolidation just happened" for the time-gate.
 */
export async function recordConsolidation(memoryDir: string): Promise<void> {
  try {
    await fsp.mkdir(memoryDir, { recursive: true })
    await fsp.writeFile(lockPath(memoryDir), '', 'utf-8')
  } catch {
    /* best-effort */
  }
}

/**
 * Convenience wrapper: acquire → run → release (with rollback on throw).
 * The lock is released by re-writing the file with an empty PID body
 * (rather than unlinking) so the mtime stays as the wall clock the run
 * STARTED — `readLastConsolidatedAt` therefore reflects the most recent
 * successful pass, not the most recent acquire attempt.
 *
 * Returns the function's result on success, or `null` when the lock
 * could not be acquired.
 */
export async function withConsolidationLock<T>(
  memoryDir: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const priorMtime = await tryAcquireConsolidationLock(memoryDir)
  if (priorMtime === null) return null

  let succeeded = false
  try {
    const result = await fn()
    succeeded = true
    return result
  } finally {
    if (succeeded) {
      // Clear PID body so a future tryAcquire doesn't see us as live.
      try {
        await fsp.writeFile(lockPath(memoryDir), '', 'utf-8')
      } catch {
        /* best-effort */
      }
    } else {
      await rollbackConsolidationLock(memoryDir, priorMtime)
    }
  }
}
