/**
 * Session service orchestration.
 * Tracks tool usage and session notes per (workspace, conversationId) for continuity across user turns.
 */

import type { SessionNote } from './types'
import { asSessionId, type SessionId } from '../tools/ids'
import {
  hashProjectPath,
  startNewSession,
  writeSessionNote,
  formatSessionForPrompt,
  listSessions as listSessionFiles,
} from './storage'
import { extractFromToolUse } from './extractor'
import { getAgentContext } from '../agents/agentContext'
import { getWorkspacePath } from '../tools/workspaceState'
import { runSessionStartHooks, runSessionEndHooks } from '../tools/hooks/engine'

let userDataPath: string = ''
let dataStoragePath: string = ''

type SessionSlot = {
  projectHash: string
  sessionId: SessionId
  note: SessionNote
}

/** Key: `${projectHash}::${conversationId}` */
const slots = new Map<string, SessionSlot>()

function conversationKey(conversationId: string | undefined): string {
  const c = typeof conversationId === 'string' && conversationId.trim() ? conversationId.trim() : 'default'
  return c
}

function slotKey(workspacePath: string, conversationId: string | undefined): string {
  return `${hashProjectPath(workspacePath)}::${conversationKey(conversationId)}`
}

export function initSessionService(userData: string, storagePath?: string): void {
  userDataPath = userData
  dataStoragePath = storagePath || userData
}

/** Update the data storage path at runtime (e.g. when user changes settings). */
export function setSessionServiceDataStorage(storagePath: string): void {
  dataStoragePath = storagePath
}

/**
 * @deprecated Workspace moves are reflected via getWorkspacePath + slot keys; kept for API stability.
 */
export function setActiveWorkspace(workspacePath: string | null): void {
  void workspacePath
  /* no-op: slots are keyed per path + conversation */
}

export function startSession(workspacePath: string, conversationId?: string): void {
  if (!userDataPath || !workspacePath?.trim()) return
  const ws = workspacePath.trim()
  const key = slotKey(ws, conversationId)
  const existing = slots.get(key)
  if (existing && existing.note.state === 'active') {
    return
  }

  const projectHash = hashProjectPath(ws)
  const result = startNewSession(userDataPath, projectHash, dataStoragePath)
  const typed = result as SessionNote & { _sessionId?: string }
  const sessionId: SessionId = asSessionId(typed._sessionId || `session-${Date.now()}`)
  const { _sessionId, ...noteRest } = typed
  void _sessionId
  const note: SessionNote = {
    ...(noteRest as SessionNote),
    state: 'active',
  }

  slots.set(key, {
    projectHash,
    sessionId,
    note,
  })

  // Surface hook failures instead of silently swallowing them — a broken
  // session-start hook would otherwise be invisible to both user and
  // telemetry. We don't re-throw (hooks are advisory), but we log so
  // bundle-log / Output panel surfaces the problem.
  void runSessionStartHooks(ws, ws).catch((err) => {
    console.warn('[session] runSessionStartHooks failed:', err)
  })
}

function getSlotForContext(): SessionSlot | undefined {
  const ws = getWorkspacePath()
  if (!ws) return undefined
  const ctx = getAgentContext()
  const key = slotKey(ws, ctx?.streamConversationId)
  return slots.get(key)
}

export function updateFromToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: { success: boolean; output?: string; error?: string },
): void {
  const slot = getSlotForContext()
  if (!slot) return

  try {
    const updates = extractFromToolUse(toolName, toolInput, toolResult)
    const next: SessionNote = {
      ...slot.note,
      tasks: updates.tasks ? [...slot.note.tasks, ...updates.tasks] : slot.note.tasks,
      files: updates.files ? [...slot.note.files, ...updates.files] : slot.note.files,
      errors: updates.errors ? [...slot.note.errors, ...updates.errors] : slot.note.errors,
      worklog: updates.worklog ? [...slot.note.worklog, ...updates.worklog] : slot.note.worklog,
      lastUpdated: updates.lastUpdated || slot.note.lastUpdated,
    }
    slot.note = next
    writeSessionNote(userDataPath, slot.projectHash, slot.sessionId, next, dataStoragePath)
    const key = slotKey(getWorkspacePath()!, getAgentContext()?.streamConversationId)
    slots.set(key, slot)
  } catch (err) {
    console.warn('[SessionService] Failed to update session note:', err)
  }
}

/** Session summary for system prompt (explicit scope — used by streamHandler). */
export function getSessionSummaryForScope(
  workspacePath: string | undefined,
  conversationId: string | undefined,
): string | null {
  if (!workspacePath?.trim()) return null
  const key = slotKey(workspacePath.trim(), conversationId)
  const slot = slots.get(key)
  if (!slot?.note) return null
  return formatSessionForPrompt(slot.note)
}

/** @deprecated Prefer {@link getSessionSummaryForScope}; uses agent/workspace context when inside a tool run. */
export function getSessionSummary(): string | null {
  const slot = getSlotForContext()
  if (!slot?.note) return null
  return formatSessionForPrompt(slot.note)
}

export function getCurrentSession(): SessionNote | null {
  const slot = getSlotForContext()
  return slot?.note ?? null
}

/**
 * Session note for a workspace + conversation without ALS (e.g. renderer IPC).
 * `conversationId` omitted or empty uses the same default bucket as {@link startSession}.
 */
export function getSessionForScope(
  workspacePath: string | undefined,
  conversationId: string | undefined,
): SessionNote | null {
  if (!workspacePath?.trim()) return null
  const key = slotKey(workspacePath.trim(), conversationId)
  return slots.get(key)?.note ?? null
}

/** Mark the given chat scope's session complete and persist. */
export function completeSessionScope(
  workspacePath: string | undefined,
  conversationId: string | undefined,
): void {
  if (!workspacePath?.trim()) return
  const key = slotKey(workspacePath.trim(), conversationId)
  const slot = slots.get(key)
  if (!slot) return

  const note: SessionNote = {
    ...slot.note,
    state: 'completed',
    lastUpdated: new Date().toISOString(),
  }
  if (dataStoragePath) {
    try {
      writeSessionNote(userDataPath, slot.projectHash, slot.sessionId, note, dataStoragePath)
    } catch {
      // ignore
    }
  }
  const wsTrim = workspacePath.trim()
  void runSessionEndHooks(wsTrim, wsTrim).catch((err) => {
    console.warn('[session] runSessionEndHooks failed:', err)
  })
  slots.delete(key)
}

/** @deprecated Use {@link completeSessionScope} */
export function endSession(): void {
  const ws = getWorkspacePath()
  const ctx = getAgentContext()
  completeSessionScope(ws ?? undefined, ctx?.streamConversationId)
}

/** When no streams remain, complete any in-memory active slots (defensive cleanup). */
export function completeAllActiveSessions(): void {
  const now = new Date().toISOString()
  for (const [key, slot] of [...slots.entries()]) {
    if (slot.note.state !== 'active') continue
    const note: SessionNote = { ...slot.note, state: 'completed', lastUpdated: now }
    if (dataStoragePath) {
      try {
        writeSessionNote(userDataPath, slot.projectHash, slot.sessionId, note, dataStoragePath)
      } catch {
        /* ignore */
      }
    }
    slots.delete(key)
  }
}

export function listSessions(
  workspacePath: string,
): Array<{ sessionId: SessionId; title: string; state: string; lastUpdated: string }> {
  const hash = hashProjectPath(workspacePath)
  return listSessionFiles(userDataPath, hash, dataStoragePath).map((s) => ({
    ...s,
    sessionId: asSessionId(s.sessionId),
  }))
}
