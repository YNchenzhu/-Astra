/**
 * Extraction state management — adapted from upstream §4.
 *
 * Manages:
 * - the IDE mechanism: tracks last processed message UUID per conversation
 * - Coalescing: stashes pending context when extraction is in-progress
 * - Mutual exclusion: prevents main agent and extract agent from writing simultaneously
 * - File-level write locks: prevents concurrent writes to the same memory file
 * - Drain: waits for in-flight extractions to complete before shutdown
 */

import path from 'node:path'
import fsp from 'node:fs/promises'

/** Per-conversation extraction cursor tracking last processed message */
interface ExtractionCursor {
  lastMemoryMessageUuid: string | null
  extractionCount: number
}

const cursors = new Map<string, ExtractionCursor>()

// ── the IDE persistence (survives process restarts) ──

function cursorFilePath(memoryDir: string, conversationId: string): string {
  return path.join(memoryDir, `.extraction-cursor-${sanitizeCursorKey(conversationId)}.json`)
}

function sanitizeCursorKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

/** Try to load a cursor from disk. Returns null if the file doesn't exist or is corrupt. */
export async function loadExtractionCursor(
  memoryDir: string,
  conversationId: string,
): Promise<ExtractionCursor | null> {
  try {
    const raw = await fsp.readFile(cursorFilePath(memoryDir, conversationId), 'utf-8')
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed.lastMemoryMessageUuid === 'string' &&
      typeof parsed.extractionCount === 'number'
    ) {
      return {
        lastMemoryMessageUuid: parsed.lastMemoryMessageUuid || null,
        extractionCount: parsed.extractionCount,
      }
    }
    return null
  } catch {
    return null
  }
}

/** Persist a cursor to disk. Errors are logged but never thrown. */
export async function saveExtractionCursor(
  memoryDir: string,
  conversationId: string,
  cursor: ExtractionCursor,
): Promise<void> {
  try {
    await fsp.mkdir(memoryDir, { recursive: true })
    await fsp.writeFile(
      cursorFilePath(memoryDir, conversationId),
      JSON.stringify(cursor),
      'utf-8',
    )
  } catch (err) {
    console.warn('[ExtractionState] Failed to save cursor:', err)
  }
}

export function getExtractionCursor(conversationId: string): ExtractionCursor {
  let c = cursors.get(conversationId)
  if (!c) {
    c = { lastMemoryMessageUuid: null, extractionCount: 0 }
    cursors.set(conversationId, c)
  }
  return c
}

export function advanceExtractionCursor(
  conversationId: string,
  lastMessageUuid: string,
): void {
  const c = getExtractionCursor(conversationId)
  c.lastMemoryMessageUuid = lastMessageUuid
  c.extractionCount++
}

/** Coalescing: stashed pending context when an extraction is already in-progress */
interface PendingContext {
  conversationId: string
  messages: Array<{ role: string; content: string; id?: string }>
  timestamp: number
}

const pendingContexts = new Map<string, PendingContext>()

export function stashPendingContext(ctx: PendingContext): void {
  pendingContexts.set(ctx.conversationId, ctx)
}

export function consumePendingContext(conversationId: string): PendingContext | null {
  const ctx = pendingContexts.get(conversationId)
  if (ctx) {
    pendingContexts.delete(conversationId)
  }
  return ctx ?? null
}

/** Mutual exclusion: track whether main agent has written to memory since cursor */
const mainAgentMemoryWrites = new Map<string, number>()

export function recordMainAgentMemoryWrite(conversationId: string): void {
  mainAgentMemoryWrites.set(conversationId, Date.now())
}

export function hasMemoryWritesSince(
  conversationId: string,
  sinceMs: number,
): boolean {
  const lastWrite = mainAgentMemoryWrites.get(conversationId)
  if (!lastWrite) return false
  return lastWrite > sinceMs
}

export function clearMainAgentMemoryWrite(conversationId: string): void {
  mainAgentMemoryWrites.delete(conversationId)
}

/** Any memory file write via app API (create/update/batch) — durable extract can skip to avoid double-write. */
let lastGlobalMemoryApiWriteAt = 0

export function recordMemoryApiWrite(): void {
  lastGlobalMemoryApiWriteAt = Date.now()
}

export function hasRecentMemoryApiWrite(withinMs: number): boolean {
  return Date.now() - lastGlobalMemoryApiWriteAt < withinMs
}

/** In-flight extraction tracking for drain */
const inFlightExtractions = new Set<Promise<void>>()

export function trackExtraction(promise: Promise<void>): void {
  inFlightExtractions.add(promise)
  promise.finally(() => inFlightExtractions.delete(promise))
}

// ---------------------------------------------------------------------------
// File-level write mutex — prevents main agent & auto-extract from colliding
// ---------------------------------------------------------------------------

/** Active file write locks (absolute path → owner hint). */
const fileWriteLocks = new Map<string, string>()

function lockKey(filePath: string): string {
  return path.resolve(filePath)
}

/**
 * Try to acquire an exclusive write lock on a memory file.
 * @param filePath - absolute or relative path to the memory file
 * @param owner - hint describing who holds the lock ('agent', 'auto-extract')
 * @returns true if lock was acquired, false if already locked
 */
export function tryAcquireFileLock(filePath: string, owner: string = 'unknown'): boolean {
  const key = lockKey(filePath)
  if (fileWriteLocks.has(key)) return false
  fileWriteLocks.set(key, owner)
  return true
}

/** Release a previously-acquired file write lock. Idempotent. */
export function releaseFileLock(filePath: string): void {
  fileWriteLocks.delete(lockKey(filePath))
}

/** Check whether a file is currently locked. */
export function isFileLocked(filePath: string): boolean {
  return fileWriteLocks.has(lockKey(filePath))
}

/** Release all locks held by a given owner (useful for batch cleanup). */
export function releaseLocksByOwner(owner: string): void {
  for (const [key, o] of fileWriteLocks) {
    if (o === owner) fileWriteLocks.delete(key)
  }
}

/**
 * Run a function while holding a file lock, releasing it afterwards
 * even if the function throws.
 */
export async function withFileLock<T>(
  filePath: string,
  owner: string,
  fn: () => T | Promise<T>,
): Promise<T | null> {
  if (!tryAcquireFileLock(filePath, owner)) return null
  try {
    return await fn()
  } finally {
    releaseFileLock(filePath)
  }
}

/**
 * Wait for all in-flight extractions to complete (with timeout).
 * Called during graceful shutdown to prevent data loss.
 * Default timeout: 60 seconds.
 */
export async function drainPendingExtractions(
  timeoutMs: number = 60_000,
): Promise<void> {
  if (inFlightExtractions.size === 0) return

  console.log(`[Memory] Draining ${inFlightExtractions.size} in-flight extraction(s)...`)

  const allDone = Promise.all([...inFlightExtractions])
  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs)
    // Audit fix F14: in Electron utility processes and some non-Node hosts
    // `setTimeout` returns a number, not a NodeJS.Timeout. The previous
    // guard checked `typeof t === 'object' && 'unref' in t` which is true
    // for the Node Timer object but is unsafe to typecast in a non-Node
    // environment (timer.unref is not actually callable in browser-like
    // hosts even when the property exists). Switch to a functional probe:
    // call .unref() only when it's a callable method on a non-numeric `t`.
    if (
      t &&
      typeof t === 'object' &&
      typeof (t as { unref?: unknown }).unref === 'function'
    ) {
      try {
        ;(t as { unref: () => void }).unref()
      } catch {
        /* hosts that expose unref but throw on call — best-effort. */
      }
    }
  })

  await Promise.race([allDone, timeout])
  console.log('[Memory] Drain complete.')
}

/**
 * Count messages that appear after the cursor position.
 * If cursorUuid is null, counts all messages.
 */
export function countMessagesSinceCursor(
  messages: Array<{ id?: string }>,
  cursorUuid: string | null,
): number {
  if (!cursorUuid) return messages.length

  const idx = messages.findIndex((m) => m.id === cursorUuid)
  if (idx === -1) return messages.length
  return messages.length - idx - 1
}

/** Throttling: track extraction rounds per conversation */
const extractionRounds = new Map<string, number>()

export function getExtractionRound(conversationId: string): number {
  return extractionRounds.get(conversationId) ?? 0
}

export function incrementExtractionRound(conversationId: string): void {
  extractionRounds.set(conversationId, getExtractionRound(conversationId) + 1)
}

/**
 * Check whether extraction should be throttled.
 * @param throttleInterval - Execute once every N rounds (default 1 = every round)
 */
export function shouldThrottleExtraction(
  conversationId: string,
  throttleInterval: number = 1,
): boolean {
  if (throttleInterval <= 1) return false
  return getExtractionRound(conversationId) % throttleInterval !== 0
}

export function resetExtractionStateForTests(): void {
  cursors.clear()
  pendingContexts.clear()
  mainAgentMemoryWrites.clear()
  inFlightExtractions.clear()
  extractionRounds.clear()
  fileWriteLocks.clear()
  lastGlobalMemoryApiWriteAt = 0
}
