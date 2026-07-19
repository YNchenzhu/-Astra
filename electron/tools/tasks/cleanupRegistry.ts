/**
 * Cleanup registry — manages process-exit cleanup callbacks.
 *
 * Mirrors upstream's cleanupRegistry pattern. Each task registers
 * an `unregisterCleanup` callback that fires on app shutdown.
 */

type CleanupFn = () => void | Promise<void>

const cleanupCallbacks = new Map<string, CleanupFn>()

/**
 * Register a cleanup callback for a task.
 *
 * Defensive: if the same `taskId` already has a cleanup registered,
 * `Map.set` would silently overwrite it and the previous callback would
 * NEVER fire — orphaning whatever resource the first registration was
 * scoped to. Production code paths register-once / unregister-once, but
 * a refactor accidentally re-using a taskId would otherwise leak in
 * silence. Warn loudly so the regression shows up in dev/CI logs.
 */
export function registerCleanup(taskId: string, fn: CleanupFn): void {
  if (cleanupCallbacks.has(taskId)) {
    console.warn(
      '[CleanupRegistry] duplicate cleanup registration for',
      taskId,
      '— previous callback will be dropped without firing. Did a task lifecycle skip unregisterCleanup()?',
    )
  }
  cleanupCallbacks.set(taskId, fn)
}

/** Unregister and optionally invoke a task's cleanup callback. */
export async function unregisterCleanup(taskId: string, invoke = true): Promise<void> {
  const fn = cleanupCallbacks.get(taskId)
  cleanupCallbacks.delete(taskId)
  if (invoke && fn) {
    try {
      await fn()
    } catch (err) {
      console.warn('[CleanupRegistry] cleanup error for', taskId, err)
    }
  }
}

/** Invoke all cleanup callbacks (call on app shutdown). */
export async function cleanupAll(): Promise<void> {
  const entries = [...cleanupCallbacks]
  cleanupCallbacks.clear()
  for (const [taskId, fn] of entries) {
    try {
      await fn()
    } catch (err) {
      console.warn('[CleanupRegistry] cleanup error for', taskId, err)
    }
  }
}

/** Count of registered cleanup callbacks. */
export function cleanupCount(): number {
  return cleanupCallbacks.size
}

/**
 * @internal Test-only — silently drops every registered cleanup callback
 * without invoking it. Tests need this in beforeEach to avoid the
 * "duplicate cleanup registration" warning when a task lifecycle in a
 * previous test left a callback behind (e.g. when asserting kill paths
 * that legitimately don't fire cleanup, or just to keep specs isolated
 * across files that happen to reuse task ids).
 *
 * Distinct from {@link cleanupAll}: that one INVOKES callbacks (its job
 * is to flush real resources on process exit). This one explicitly does
 * NOT invoke — tests construct controllers / intervals / handles that
 * are already gone or stubbed by Vitest's fake timers, and re-running
 * them would either error or interact with the next test's fresh setup.
 */
export function __clearAllCleanupForTests(): void {
  cleanupCallbacks.clear()
}
