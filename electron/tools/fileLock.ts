/**
 * File-level operation lock for multi-agent coordination.
 *
 * When multiple agents run in parallel, they may attempt to write the same
 * file. This module provides a simple in-process lock that serializes
 * write operations on a per-file basis.
 *
 * Design: Since all agents run in the same Electron main process (Node.js
 * single-threaded), we use a Map of promise chains rather than OS-level
 * file locks. Each file path gets its own serial queue.
 *
 * Reference: upstream uses proper-lockfile for inter-process locks on
 * task lists and mailboxes. We use in-process locks because our agents
 * share one process. If we later support multi-process agents, upgrade
 * to proper-lockfile.
 */

import { canonicalFileLockKey } from './canonicalPath'
import type { AgentId } from './ids'

type ReleaseFunction = () => void

interface LockEntry {
  queue: Promise<void>
  holders: number
  lastActivity: number
  /** Agent id that currently holds the lock (for conflict diagnostics). */
  holderAgentId?: AgentId
  /** Human-readable description of the lock holder (e.g. agent name). */
  holderDescription?: string
}

const locks = new Map<string, LockEntry>()

/** Maximum time a single lock holder may keep the lock before auto-release (10 minutes). */
const LOCK_TIMEOUT_MS = 10 * 60 * 1000

function normalizePath(filePath: string): string {
  // realpath-aware so a symlink path and its real target share one lock.
  return canonicalFileLockKey(filePath)
}

/**
 * Acquire a write lock on a file path.
 * Returns a release function that MUST be called when the write is done.
 *
 * If another agent is currently writing to this file, the returned promise
 * will wait until the previous write completes before resolving.
 *
 * Usage:
 * ```ts
 * const release = await acquireFileLock('/path/to/file.ts')
 * try {
 *   await fs.writeFile(...)
 * } finally {
 *   release()
 * }
 * ```
 */
export async function acquireFileLock(filePath: string): Promise<ReleaseFunction> {
  const key = normalizePath(filePath)
  let entry = locks.get(key)

  if (!entry) {
    entry = { queue: Promise.resolve(), holders: 0, lastActivity: Date.now() }
    locks.set(key, entry)
  }

  let releaseResolve: () => void
  let releaseReject: (err: Error) => void
  const releasePromise = new Promise<void>((resolve, reject) => {
    releaseResolve = resolve
    releaseReject = reject
  })

  // Shared release body (audit fix 2026-07, P2): the safety-timeout path
  // used to only reject `releasePromise` WITHOUT decrementing `holders`,
  // so a holder that never called release left the entry pinned at
  // holders>0 forever — every subsequent `tryAcquireFileLock` on that path
  // returned "File is locked" until process restart.
  let released = false
  const releaseWith = (timeoutErr?: Error): void => {
    if (released) return
    released = true
    clearTimeout(safetyTimer)
    entry!.holders--
    entry!.lastActivity = Date.now()
    if (timeoutErr) {
      releaseReject!(timeoutErr)
    } else {
      releaseResolve!()
    }
    if (entry!.holders <= 0) {
      locks.delete(key)
    }
  }

  // Safety: auto-release (with a rejection so diagnostics surface) if the
  // holder never calls release within the timeout.
  const safetyTimer = setTimeout(() => {
    releaseWith(new Error(`fileLock timeout for ${filePath}: lock held too long without release`))
  }, LOCK_TIMEOUT_MS)

  const prevQueue = entry.queue
  entry.queue = entry.queue.then(() => releasePromise).catch(() => { /* swallowed by chain */ })
  entry.holders++
  entry.lastActivity = Date.now()

  await prevQueue

  return () => releaseWith()
}

/**
 * Execute a function while holding a file lock.
 * The lock is automatically released when the function completes or throws.
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireFileLock(filePath)
  try {
    return await fn()
  } finally {
    release()
  }
}

/**
 * Check if a file is currently locked (non-blocking).
 */
export function isFileLocked(filePath: string): boolean {
  const key = normalizePath(filePath)
  const entry = locks.get(key)
  return !!entry && entry.holders > 0
}

/**
 * Try to acquire a write lock on a file path without waiting.
 *
 * If the file is already locked by another agent, returns a conflict error
 * immediately instead of queuing. This prevents multiple agents from
 * concurrently modifying the same file.
 *
 * Returns either a release function or a conflict error object.
 */
export function tryAcquireFileLock(
  filePath: string,
  agentId?: AgentId,
  description?: string,
): { release: ReleaseFunction } | { error: string } {
  const key = normalizePath(filePath)
  const entry = locks.get(key)

  if (entry && entry.holders > 0) {
    const holderInfo = entry.holderAgentId || 'another agent'
    const holderDesc = entry.holderDescription ? ` (${entry.holderDescription})` : ''
    return {
      error:
        `File is locked: "${filePath}" is currently being modified by ${holderInfo}${holderDesc}. ` +
        `Wait for the other agent to finish before modifying this file. ` +
        `Lock holder: ${holderInfo}${holderDesc}.`,
    }
  }

  let entryToUse = entry
  if (!entryToUse) {
    entryToUse = {
      queue: Promise.resolve(),
      holders: 0,
      lastActivity: Date.now(),
    }
    locks.set(key, entryToUse)
  }

  let releaseResolve: () => void
  const releasePromise = new Promise<void>((resolve) => {
    releaseResolve = resolve
  })

  let released = false
  const release: ReleaseFunction = () => {
    if (released) return
    released = true
    clearTimeout(safetyTimer)
    entryToUse!.holders--
    entryToUse!.lastActivity = Date.now()
    if (entryToUse!.holderAgentId === agentId) {
      entryToUse!.holderAgentId = undefined
      entryToUse!.holderDescription = undefined
    }
    releaseResolve!()
    if (entryToUse!.holders <= 0) {
      locks.delete(key)
    }
  }

  // Safety timeout runs the FULL release (audit fix 2026-07, P2) — the old
  // version only resolved the queue promise and left `holders` pinned >0,
  // permanently blocking every later tryAcquireFileLock on this path when
  // a holder leaked without calling release.
  const safetyTimer = setTimeout(() => {
    console.warn(`[fileLock] auto-releasing leaked exclusive lock for ${filePath} after ${LOCK_TIMEOUT_MS}ms`)
    release()
  }, LOCK_TIMEOUT_MS)

  entryToUse.queue = entryToUse.queue.then(() => releasePromise).catch(() => {
    /* swallowed by chain */
  })
  entryToUse.holders++
  entryToUse.lastActivity = Date.now()
  entryToUse.holderAgentId = agentId
  entryToUse.holderDescription = description

  return { release }
}

/**
 * Execute a function while holding an exclusive file lock with agent tracking.
 * The lock is automatically released when the function completes or throws.
 *
 * If the file is already locked by another agent, throws a clear conflict error.
 */
export async function withExclusiveFileLock<T>(
  filePath: string,
  agentId: AgentId | undefined,
  description: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const result = tryAcquireFileLock(filePath, agentId, description)
  if ('error' in result) {
    throw new Error(result.error)
  }
  try {
    return await fn()
  } finally {
    result.release()
  }
}

/**
 * Get the number of pending operations on a file.
 */
export function getPendingCount(filePath: string): number {
  const key = normalizePath(filePath)
  const entry = locks.get(key)
  return entry ? entry.holders : 0
}

/**
 * Clear all locks.
 *
 * By default, throws if any lock has pending holders (prevents accidental
 * data corruption from concurrent writes). Pass `force: true` to bypass
 * this check — use only in tests or during app shutdown when you are
 * certain no further file I/O will occur.
 */
export function clearAllLocks(options?: { force?: boolean }): void {
  const force = options?.force === true

  if (!force) {
    for (const [key, entry] of locks) {
      if (entry.holders > 0) {
        throw new Error(
          `[fileLock] clearAllLocks refused: lock "${key}" has ${entry.holders} pending holder(s). ` +
          'Wait for all writes to complete, or pass { force: true } to override.',
        )
      }
    }
  } else {
    for (const [key, entry] of locks) {
      if (entry.holders > 0) {
        console.warn(
          `[fileLock] clearAllLocks(force): dropping lock for "${key}" with ${entry.holders} pending holder(s).`,
        )
      }
    }
  }

  locks.clear()
}
