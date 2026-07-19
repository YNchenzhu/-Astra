/**
 * File-history backup — pre-write content snapshot so a user can recover
 * "what was here before the AI touched it" within the current session.
 *
 * Strategy (mirrors upstream `src/utils/fileHistory.ts` at the granularity
 * that matters for safety, deliberately simpler at the session-state level):
 *
 *   1. **`fs.promises.copyFile` (no JS heap)**. The whole point of this
 *      module is to be safe to call on large files. `copyFile` delegates
 *      to the OS (sendfile / CopyFileEx) and never reads the file into
 *      Node's memory. The naive `readFile + writeFile` pipeline used by
 *      the diff-preview backup attempts on legacy paths would OOM on
 *      100 MB+ source files.
 *   2. **Content-hash naming, not versioning**. Backup path is
 *      `<userData>/file-history/<sessionId>/<sha256(filePath)[:16]>@v1`.
 *      A given file in a given session has exactly one backup — the
 *      content at first touch. Re-edits don't add backups; that's the
 *      restore target we want. `@v1` is kept in the filename so we can
 *      later add `@v2…` if we adopt per-message snapshots like upstream.
 *   3. **Permission preservation**. `chmod(backup, srcStats.mode)` so a
 *      `0o600` private key remains backed up at `0o600`, not under the
 *      process umask.
 *   4. **Awaitable + idempotent**. The caller `await`s the backup so the
 *      destructive write that follows can rely on the snapshot being on
 *      disk. Idempotency is per (sessionId, filePath) via an in-memory
 *      `Set` — fast enough that the path is essentially free for files
 *      we've already snapshotted.
 *   5. **Failure is non-fatal**. If the backup fails (full disk, bad
 *      permissions on userData, …) we WARN but `return` cleanly so the
 *      caller's main write proceeds. "AI changed your file, no backup
 *      this time" is strictly better than "AI couldn't change your file
 *      because we couldn't take a backup".
 *
 * We do NOT (yet) implement:
 *   • Per-message snapshots (upstream's `messageId` per-snapshot model).
 *     We treat a session as a single big snapshot. Adding per-message
 *     versioning is a future change; the on-disk layout already has the
 *     `@v1` suffix as room to grow.
 *   • An LRU cap (upstream's `MAX_SNAPSHOTS = 100`). The backup dir grows
 *     by O(files-touched-this-session); cleanup happens on session
 *     teardown / app restart via `cleanupFileHistorySessionDir`.
 *   • Cross-session lookup. Today the recovery scope is "this conversation
 *     only". Older sessions' backups are best-effort artifacts on disk
 *     that the UI can choose to expose later.
 */

import fs from 'node:fs/promises'
import type { Stats } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { getAgentContext } from '../agents/agentContext'

/**
 * Process-lifetime fallback session id used when no agent context provides
 * a conversation id (e.g. direct IPC calls outside an agent turn).
 *
 * Stable across the whole process so two backup attempts in the same app
 * run share the same directory; resets next launch (intentional — backups
 * are session-scoped recovery, not long-term version history).
 */
const PROCESS_SESSION_ID = randomUUID()

/**
 * (sessionId → set of file paths already backed up in this session).
 *
 * In-memory only. Survives nothing; on restart we re-backup on first touch
 * (cheap idempotent operation thanks to the content-hash filename — if the
 * v1 backup file already exists from a previous session, copyFile will
 * just overwrite it with identical bytes, no harm done).
 */
const trackedFiles = new Map<string, Set<string>>()

/**
 * Gate the entire subsystem so users / e2e tests can disable backups
 * without surgery. upstream uses `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING`;
 * we mirror the env-var pattern under our project prefix.
 */
export function fileHistoryEnabled(): boolean {
  const v = process.env.ASTRA_DISABLE_FILE_HISTORY?.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return false
  return true
}

function getSessionId(): string {
  const ctx = getAgentContext()
  const conv = ctx?.streamConversationId?.trim()
  return conv && conv.length > 0 ? conv : PROCESS_SESSION_ID
}

/**
 * Resolve the file-history root directory. Prefers Electron's `userData`
 * path (the canonical per-user app dir). Falls back to a deterministic
 * tmpdir slot for vitest / non-Electron contexts so unit tests are
 * self-contained.
 *
 * `ASTRA_FILE_HISTORY_DIR` overrides everything — used by tests to
 * point at a freshly-created tmpdir without going through Electron.
 */
function getFileHistoryBaseDir(): string {
  const override = process.env.ASTRA_FILE_HISTORY_DIR?.trim()
  if (override) return path.resolve(override)
  try {
    // Lazy require — keeps this module importable from vitest without
    // electron in the runtime (static import would crash at module
    // evaluation and poison every test that touches the file tools).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    if (typeof app?.getPath === 'function') {
      return path.join(app.getPath('userData'), 'file-history')
    }
  } catch {
    /* vitest / non-electron — fall through */
  }
  return path.join(os.tmpdir(), 'astra-file-history')
}

function getSessionDir(sessionId: string): string {
  return path.join(getFileHistoryBaseDir(), sessionId)
}

/**
 * Hash-keyed backup filename. 16 hex chars of sha256 keeps filenames short
 * while keeping collisions cryptographically negligible at the scale of a
 * single session's working set (≪ 2^32 files).
 */
function getBackupFileName(filePath: string): string {
  return (
    createHash('sha256').update(filePath).digest('hex').slice(0, 16) + '@v1'
  )
}

function getTrackedSet(sessionId: string): Set<string> {
  let set = trackedFiles.get(sessionId)
  if (!set) {
    set = new Set()
    trackedFiles.set(sessionId, set)
  }
  return set
}

/**
 * Return the backup path that `fileHistoryTrackEdit` would use for
 * `filePath` in the CURRENT session. Useful for UI to surface "restore
 * from this backup" actions.
 */
export function getBackupPath(filePath: string): string {
  const absPath = path.resolve(filePath)
  return path.join(getSessionDir(getSessionId()), getBackupFileName(absPath))
}

/** Best-effort check: do we already have a v1 backup for this file? */
export async function hasBackup(filePath: string): Promise<boolean> {
  try {
    await fs.stat(getBackupPath(filePath))
    return true
  } catch {
    return false
  }
}

/**
 * Snapshot the current bytes of `filePath` to the session's backup dir
 * BEFORE the caller performs a destructive write. Idempotent per
 * (sessionId, filePath).
 *
 * The await is intentional: callers (toolWriteFile / toolEditFile /
 * toolMultiEditFile) `await fileHistoryTrackEdit(...)` so by the time
 * the destructive write fires, the backup is durable on disk. For
 * "small file" (KB range) the copyFile is sub-millisecond; for "large
 * file" (100 MB+) we'd rather wait 200 ms than risk an incomplete
 * snapshot.
 *
 * If the source file doesn't exist (create-via-edit / create-via-write
 * path), we record the file in the in-memory tracking set but skip the
 * copy — a missing pre-state IS the pre-state, and the natural recovery
 * is "delete the file the AI created", which doesn't need a backup file.
 */
export async function fileHistoryTrackEdit(filePath: string): Promise<void> {
  if (!fileHistoryEnabled()) return
  const absPath = path.resolve(filePath)

  const sessionId = getSessionId()
  const tracked = getTrackedSet(sessionId)
  if (tracked.has(absPath)) return

  // Mark BEFORE the async ops so a concurrent caller doesn't double-copy.
  // If the copy fails below we keep the marker — the main write proceeds
  // either way, and re-trying the backup would only burn IO without
  // changing the durability story (same content, same destination).
  tracked.add(absPath)

  // Stat first: separates "file doesn't exist yet" (skip cleanly) from
  // "permission denied" (warn but don't break main write). Sharing a
  // catch for both meant a file deleted between copyFile-success and
  // stat would leave an orphan backup with a null state record — a bug
  // upstream specifically guarded against; we follow the same pattern.
  let srcStats: Stats
  try {
    srcStats = await fs.stat(absPath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
     
    console.warn(`[fileHistory] stat failed for ${absPath}:`, e)
    return
  }

  const backupDir = getSessionDir(sessionId)
  const backupPath = path.join(backupDir, getBackupFileName(absPath))

  // Lazy mkdir: 99% of calls after the first one in a session hit the
  // fast path (dir already exists). On ENOENT, mkdir then retry — this
  // is faster than an unconditional `mkdir -p` because mkdir issues
  // a syscall per directory level regardless of existence.
  try {
    await fs.copyFile(absPath, backupPath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        await fs.mkdir(path.dirname(backupPath), { recursive: true })
        await fs.copyFile(absPath, backupPath)
      } catch (retry) {
         
        console.warn(`[fileHistory] backup failed for ${absPath}:`, retry)
        return
      }
    } else {
       
      console.warn(`[fileHistory] backup failed for ${absPath}:`, e)
      return
    }
  }

  // Preserve permissions on the backup. The original file might be a
  // 0o600 secret; restoring from a 0o644 backup would silently widen
  // the permission surface. Best-effort — some filesystems (FAT, exFAT)
  // don't support modes.
  try {
    await fs.chmod(backupPath, srcStats.mode)
  } catch {
    /* best-effort */
  }
}

/**
 * Best-effort cleanup of the current session's backup directory. Called
 * on conversation end / app exit to bound disk usage. Returns the number
 * of files removed.
 *
 * Errors are swallowed — cleanup runs in a finally / on-quit handler
 * where there's nothing useful to do with an exception.
 */
export async function cleanupFileHistorySessionDir(): Promise<{
  removed: number
}> {
  const dir = getSessionDir(getSessionId())
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return { removed: 0 }
  }
  let removed = 0
  for (const entry of entries) {
    try {
      await fs.unlink(path.join(dir, entry))
      removed++
    } catch {
      /* per-entry best-effort */
    }
  }
  try {
    await fs.rmdir(dir)
  } catch {
    /* dir may be non-empty if a concurrent backup raced us; leave it */
  }
  // Drop in-memory tracking so the next session starts fresh.
  trackedFiles.delete(getSessionId())
  return { removed }
}

/** Test-only: clear all in-memory tracking. */
export function _resetFileHistoryTrackingForTests(): void {
  trackedFiles.clear()
}
