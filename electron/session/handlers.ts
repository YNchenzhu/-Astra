/**
 * IPC handlers for session management.
 */

import {
  listSessions as listSessionFiles,
  getCurrentSession,
  getSessionForScope,
  completeAllActiveSessions,
  completeSessionScope,
} from './service'
import { runManualSessionMemoryExtractFromMessages } from './manualSessionMemoryExtract'
import { getSessionMemoryMarkdownPath } from './sessionMemoryPaths'

export function registerSessionHandlers(ipcMain: Electron.IpcMain): void {
  ipcMain.handle('session:get-current', () => {
    return getCurrentSession()
  })

  ipcMain.handle(
    'session:get-scoped',
    (
      _e,
      payload: { workspacePath: string; conversationId?: string },
    ) => {
      const ws = payload?.workspacePath?.trim()
      if (!ws) return null
      return getSessionForScope(ws, payload.conversationId)
    },
  )

  ipcMain.handle(
    'session:end',
    (
      _e,
      opt?: { workspacePath?: string; conversationId?: string },
    ) => {
      if (opt?.workspacePath?.trim()) {
        completeSessionScope(opt.workspacePath.trim(), opt.conversationId)
      } else {
        completeAllActiveSessions()
      }
      return { success: true }
    },
  )

  ipcMain.handle('session:list', (_event, workspacePath: string) => {
    return listSessionFiles(workspacePath)
  })

  ipcMain.handle(
    'session:manual-memory-extract',
    async (
      _e,
      payload: { conversationId: string; messages: Array<Record<string, unknown>> },
    ) => {
      return runManualSessionMemoryExtractFromMessages({
        conversationId: payload?.conversationId ?? '',
        messages: Array.isArray(payload?.messages) ? payload.messages : [],
      })
    },
  )

  // Where the `session-memory-internal` scribe writes its markdown for
  // (conversationId, workspacePath). Surfaced by the header indicator's
  // tooltip so users can find the file — the legacy static text said
  // `~/.claude/session-memory/<convId>.md`, which is wrong whenever a
  // workspace is open (the real layout is project-scoped under
  // `~/.claude/projects/<slug>/session-memory/`).
  ipcMain.handle(
    'session:get-memory-path',
    (
      _e,
      payload: { conversationId: string; workspacePath?: string | null },
    ): string | null => {
      const cid = payload?.conversationId?.trim()
      if (!cid) return null
      const ws = payload?.workspacePath?.trim()
      return getSessionMemoryMarkdownPath(cid, ws || null)
    },
  )
}
