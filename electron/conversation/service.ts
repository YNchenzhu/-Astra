/**
 * Conversation service — orchestrates persistence operations.
 * Singleton pattern matching other subsystems (memory, context, session).
 */

import path from 'node:path'
import type {
  ConversationData,
  ConversationMessage,
  ConversationMeta,
  ConversationSearchResult,
  SaveConversationParams,
} from './types'
import * as storage from './storage'
import { isTodoV1Enabled } from '../tools/todoMode'
import { resetTodos, setTodos, setTodoObjective } from '../tools/TodoWriteTool'
import { extractTodosFromTranscript } from './extractTodos'

let userDataPath = ''
let dataStoragePath = ''

export function initConversationService(userData: string, storagePath?: string): void {
  userDataPath = userData
  dataStoragePath = storagePath || userData
  // Ensure base directory exists
  storage.ensureProjectDir(dataStoragePath, '__init__')
}

/** Update the data storage path at runtime (e.g. when user changes settings). */
export function setConversationServiceDataStorage(storagePath: string): void {
  dataStoragePath = storagePath
  storage.ensureProjectDir(dataStoragePath, '__init__')
}

// ---------------------------------------------------------------------------
// Title (persisted meta + autoTitle IPC)
// ---------------------------------------------------------------------------

/** First non-empty line of the first user message, collapsed whitespace, max 50 chars. */
export function buildTitleFromMessages(messages: ConversationMessage[]): string {
  const firstUserMsg = messages.find((m) => m.role === 'user')
  const raw =
    firstUserMsg && typeof firstUserMsg.content === 'string' ? firstUserMsg.content : ''
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? raw.replace(/\s+/g, ' ').trim()
  const title = firstLine.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50)
  return title || '新对话'
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export function saveConversation(params: SaveConversationParams): ConversationMeta {
  const now = Date.now()
  const title = buildTitleFromMessages(params.messages)

  // Try loading existing to preserve createdAt. Partition by the same
  // bundleId the caller used when saving, or fall back to the default
  // bundle when the param is absent (legacy callers).
  const existing = storage.loadConversationFile(
    dataStoragePath,
    params.id,
    params.workspacePath,
    params.bundleId,
  )
  const createdAt = existing ? existing.meta.createdAt : now

  const meta: ConversationMeta = {
    id: params.id,
    title,
    workspacePath: params.workspacePath,
    createdAt,
    updatedAt: now,
    messageCount: params.messages.length,
    model: params.model,
    providerId: params.providerId,
  }

  const data: ConversationData = { meta, messages: params.messages, todos: params.todos }
  storage.saveConversationFile(dataStoragePath, data, params.bundleId)

  return meta
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export function loadConversation(
  convId: string,
  workspacePath: string,
  bundleId?: string,
  options?: { restoreMainTodoState?: boolean },
): ConversationData | null {
  const data = storage.loadConversationFile(dataStoragePath, convId, workspacePath, bundleId)
  // Audit A1: the main-process `main` todo/objective rehydrate+reset below is
  // a SIDE EFFECT meant for the desktop renderer's conversation SWITCH only.
  // `loadConversation` is also called from H5 (phone) paths
  // (`imBridge.ensureRehydratedSession`, `h5Server`), which must NOT clobber
  // the desktop's live `main` todos / objective. Those callers pass
  // `restoreMainTodoState: false`. Defaults to true so the renderer switch
  // path and existing tests keep their behaviour.
  const restoreMainTodoState = options?.restoreMainTodoState !== false
  // upstream parity (`sessionRestore.ts:138-149`): when the V1 todo
  // surface is enabled (V1-only OR coexist), rehydrate the
  // main-process `todoStore` from the transcript so the stale-todo
  // nudge collector — and any other main-process reader — sees the
  // same state the renderer is already painting. Switching to a
  // conversation with no TodoWrite history still resets the store
  // so the prior conversation's checklist doesn't bleed into this one.
  //
  // V2 state restore is a separate path: TaskManager files are the
  // source of truth there. In coexist mode both restores happen,
  // each scoped to its own surface — the renderer-cached
  // `data.todos` field is intentionally NOT consulted; the
  // transcript is the single source of truth so the main process
  // can never drift away from what the model has actually emitted.
  if (data && restoreMainTodoState && isTodoV1Enabled()) {
    try {
      const todos = extractTodosFromTranscript(data.messages ?? [])
      if (todos.length > 0) setTodos('main', todos)
      else resetTodos('main')
    } catch (err) {
      console.warn('[conversation] todo transcript restore failed:', err)
    }
  } else if (data && restoreMainTodoState) {
    // v2-only / no-V1 surface (audit F-26): the V1 rehydrate above is gated on
    // V1 being enabled, so without this branch a prior conversation's captured
    // `objective` (set via TaskCreate, read by goalRecitation's V2 fallback)
    // leaked across a conversation switch. Clear ONLY the objective — NOT the
    // V1 todo store: in v2-only mode the TaskManager owns task state and the
    // V1 todo store must stay untouched (see the "does NOT touch the V1 todo
    // store in v2-only mode" contract). `setTodoObjective('main', '')` deletes
    // just the objective entry.
    try {
      setTodoObjective('main', '')
    } catch (err) {
      console.warn('[conversation] objective reset failed:', err)
    }
  }
  return data
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function listConversations(
  workspacePath: string,
  bundleId?: string,
): ConversationMeta[] {
  return storage.listConversationFiles(dataStoragePath, workspacePath, bundleId)
}

/** Persist manual sort order for the history panel (per workspace + bundle bucket). */
export function setConversationOrder(
  workspacePath: string,
  orderedIds: string[],
  bundleId?: string,
): void {
  storage.writeConversationOrder(dataStoragePath, workspacePath, orderedIds, bundleId)
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export function deleteConversation(
  convId: string,
  workspacePath: string,
  bundleId?: string,
): boolean {
  return storage.deleteConversationFile(dataStoragePath, convId, workspacePath, bundleId)
}

export function renameConversation(
  convId: string,
  workspacePath: string,
  newTitle: string,
  bundleId?: string,
): boolean {
  return storage.renameConversationTitle(
    dataStoragePath,
    convId,
    workspacePath,
    newTitle,
    bundleId,
  )
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function searchConversations(
  query: string,
  workspacePath?: string,
  bundleId?: string,
): ConversationSearchResult[] {
  return storage.searchConversationFiles(dataStoragePath, query, workspacePath, bundleId)
}

/**
 * Absolute path to the persisted conversation JSON (same file the UI saves), for hook `transcript_path`.
 * Empty string if storage is not initialized or ids are missing.
 */
export function getConversationFilePathForHooks(
  conversationId: string,
  workspacePath: string,
  bundleId?: string,
): string {
  const base = (dataStoragePath || userDataPath || '').trim()
  const cid = conversationId.trim()
  const ws = workspacePath.trim()
  if (!base || !cid || !ws) return ''
  return path.join(storage.getProjectDir(base, ws, bundleId), `${cid}.json`)
}

/**
 * Recompute topic title from persisted messages and update disk if it changed.
 * Returns the title now on file (or empty if conversation missing).
 */
export function autoTitle(
  convId: string,
  workspacePath: string,
  bundleId?: string,
): string {
  const data = loadConversation(convId, workspacePath, bundleId)
  if (!data) return ''
  const next = buildTitleFromMessages(data.messages)
  if (next && next !== data.meta.title) {
    renameConversation(convId, workspacePath, next, bundleId)
  }
  return next || data.meta.title
}
