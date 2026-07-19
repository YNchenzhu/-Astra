/**
 * Lightweight per-conversation inbox persistence.
 *
 * Why this exists: {@link applySessionCommands} keeps inbox state in memory only. If the
 * Electron process crashes (power loss, OOM, hard kill) before the inbox is drained, queued
 * `synthetic_user_text`, slash commands, and inter-agent mailbox drafts are lost. A simple
 * per-conversation JSON file (mirroring the `.consolidation-gate.json` pattern in the memory
 * subsystem) gives crash-survivable inbox semantics with negligible cost — write once on
 * EnqueueInbox, delete on ClearInbox.
 *
 * The full {@link KernelPersistenceAdapter} can persist the entire kernel state including
 * inbox, but it is not wired by default in the main-chat path. This module provides the
 * narrower inbox-only path that runs unconditionally for every active kernel.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { KernelInboxItem } from './kernelTypes'

const DIRNAME = 'orchestration-inbox'
const FILENAME_VERSION = 1

interface PersistedInboxBlob {
  version: number
  conversationId: string
  savedAt: number
  inbox: KernelInboxItem[]
}

function safeConvId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200) || 'default'
}

function tryGetUserDataDir(): string | undefined {
  try {
    // Lazy require so this module can be imported (and `saveInboxToDisk` /
    // `loadInboxFromDisk` invoked) by unit tests that run outside Electron
    // (`vitest`'s node environment).  Top-level `import { app } from
    // 'electron'` would crash at module-load time without a vi.mock setup.
    // Mirrors the pattern in `electron/telemetry/contextEvents.ts`,
    // `electron/ai/toolResultBudget.ts`, etc.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronMod = require('electron') as typeof import('electron')
    return electronMod.app?.getPath('userData')
  } catch {
    return undefined
  }
}

function resolveBaseDir(override?: string): string | undefined {
  if (override && override.trim()) return path.join(override, DIRNAME)
  const userData = tryGetUserDataDir()
  if (userData) return path.join(userData, DIRNAME)
  return undefined
}

function fileFor(conversationId: string, baseOverride?: string): string | undefined {
  const base = resolveBaseDir(baseOverride)
  if (!base) return undefined
  return path.join(base, `${safeConvId(conversationId)}.json`)
}

/**
 * P2-1 — Save result. Callers that hold HITL `pending_human_resume` items
 * MUST inspect this result and surface failures to the user; a silently
 * dropped HITL answer is the worst possible UX (the user's answer to an
 * AskUserQuestion dialog vanishes between turns).
 */
export type SaveInboxResult =
  | { ok: true }
  /** No userData path resolvable (e.g. test environment) — not a real failure. */
  | { ok: false; reason: 'no_user_data_path' }
  /** Disk write threw; carries the underlying error message for telemetry. */
  | { ok: false; reason: 'disk_error'; error: string }
  /** Cleanup of a stale file failed but the inbox was empty so no items lost. */
  | { ok: false; reason: 'cleanup_failed'; error: string }

/**
 * Persist the inbox for a conversation. Best-effort by default — callers
 * that need to react to failure inspect the returned result. Failures are
 * still console-logged so silent debugging is unaffected.
 *
 * P2-1: previously this returned `void` and only emitted `console.warn` on
 * failure. The `kernel.persistInbox()` caller now propagates the result so
 * a `hitl_persistence_failed` phase event surfaces to the renderer when
 * the in-memory inbox contained a `pending_human_resume` and disk-write
 * failed — the user gets a toast instead of a silently lost answer.
 *
 * No-op (returns `{ ok: false, reason: 'no_user_data_path' }`) when no
 * userData path is available (e.g. unit tests without Electron).
 */
export function saveInboxToDisk(
  conversationId: string,
  inbox: KernelInboxItem[],
  baseOverride?: string,
): SaveInboxResult {
  const file = fileFor(conversationId, baseOverride)
  if (!file) return { ok: false, reason: 'no_user_data_path' }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (inbox.length === 0) {
      // Empty inbox → remove the file rather than write a stub. Keeps the cache clean and
      // means crash-recovery skips conversations that had nothing pending at last save.
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn('[inboxPersistence] cleanup failed:', e)
        return { ok: false, reason: 'cleanup_failed', error: msg }
      }
      return { ok: true }
    }
    const blob: PersistedInboxBlob = {
      version: FILENAME_VERSION,
      conversationId,
      savedAt: Date.now(),
      inbox: inbox.map((item) => ({ ...item })),
    }
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(blob), 'utf-8')
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn('[inboxPersistence] save failed:', e)
    return { ok: false, reason: 'disk_error', error: msg }
  }
}

/**
 * Load the persisted inbox for a conversation, or undefined if none/invalid.
 * Callers should merge the returned items at the head of the kernel's seed inbox so they
 * are processed before any newly-buffered items.
 */
export function loadInboxFromDisk(
  conversationId: string,
  baseOverride?: string,
): KernelInboxItem[] | undefined {
  const file = fileFor(conversationId, baseOverride)
  if (!file) return undefined
  try {
    if (!fs.existsSync(file)) return undefined
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as PersistedInboxBlob
    if (parsed.version !== FILENAME_VERSION) return undefined
    if (parsed.conversationId !== conversationId) return undefined
    return Array.isArray(parsed.inbox) ? parsed.inbox : undefined
  } catch (e) {
    console.warn('[inboxPersistence] load failed:', e)
    return undefined
  }
}

/** Drop the persisted file (called on explicit ClearInbox/Terminal). */
export function deleteInboxFromDisk(conversationId: string, baseOverride?: string): void {
  const file = fileFor(conversationId, baseOverride)
  if (!file) return
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch (e) {
    console.warn('[inboxPersistence] delete failed:', e)
  }
}
