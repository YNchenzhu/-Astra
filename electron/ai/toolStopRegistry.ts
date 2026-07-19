/**
 * Per–tool_use stop handles: IPC / UI "stop task" aborts in-flight work without cancelling the whole chat.
 * Ref-counted so foreground tools unregister when execute returns while background Agent work continues.
 */

type Entry = { controller: AbortController; refCount: number }

const stopEntries = new Map<string, Entry>()

export function registerToolStopController(toolUseId: string, controller: AbortController): void {
  const cur = stopEntries.get(toolUseId)
  if (cur) {
    cur.refCount += 1
    return
  }
  stopEntries.set(toolUseId, { controller, refCount: 1 })
}

/** Pair with {@link registerToolStopController} / retain when the tool_use scope ends. */
export function releaseToolStopController(toolUseId: string): void {
  const cur = stopEntries.get(toolUseId)
  if (!cur) return
  cur.refCount -= 1
  if (cur.refCount <= 0) {
    stopEntries.delete(toolUseId)
  }
}

/** Background work that outlives the initial execute() return must hold an extra ref until it finishes. */
export function retainToolStopController(toolUseId: string): boolean {
  const cur = stopEntries.get(toolUseId)
  if (!cur) return false
  cur.refCount += 1
  return true
}

/** @returns true if a controller was found and aborted */
export function abortToolExecutionById(toolUseId: string): boolean {
  const e = stopEntries.get(toolUseId)
  if (!e) return false
  try {
    e.controller.abort()
  } catch {
    /* ignore */
  }
  return true
}

/**
 * P2-6: pair register / release as a try/finally so callers can't leak
 * controllers when their inner work throws synchronously or rejects.
 * Returns whatever the inner function returns, propagating any error.
 *
 * Use this from foreground tool execution paths (where the controller's
 * lifecycle ends with the tool call). Background work that outlives the
 * initial call should still retain a separate ref via
 * {@link retainToolStopController} and release it manually when done.
 */
export async function withToolStopController<T>(
  toolUseId: string,
  controller: AbortController,
  fn: () => Promise<T>,
): Promise<T> {
  registerToolStopController(toolUseId, controller)
  try {
    return await fn()
  } finally {
    releaseToolStopController(toolUseId)
  }
}
