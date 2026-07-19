/**
 * Push context display updates to renderer windows (Chat header meter).
 * Throttled — {@link updateConversationContextDisplay} can run often during streaming.
 *
 * Uses lazy `require('electron')` so unit tests can import {@link conversationDisplayState}
 * without a full Electron main-process environment.
 */

const lastSentMs = new Map<string, number>()
const MIN_INTERVAL_MS = 500

export function notifyContextDisplayUpdated(conversationId?: string): void {
  const id = typeof conversationId === 'string' ? conversationId.trim() : ''
  const key = id || '__all__'
  const now = Date.now()
  const prev = lastSentMs.get(key) ?? 0
  if (now - prev < MIN_INTERVAL_MS) return
  lastSentMs.set(key, now)

  const payload = { conversationId: id || (null as string | null) }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BrowserWindow } = require('electron') as typeof import('electron')
    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      if (win.isDestroyed()) continue
      win.webContents.send('context:display-updated', payload)
    }
  } catch {
    /* vitest / non-main */
  }
}
