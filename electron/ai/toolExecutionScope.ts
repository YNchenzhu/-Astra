/**
 * AsyncLocalStorage scope so nested tools (e.g. Agent) can merge the chat abort signal with the
 * current tool_use stop controller from {@link registerToolStopController}.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

type Scope = { toolUseId: string; stopController: AbortController }

const storage = new AsyncLocalStorage<Scope>()

export function runWithToolStopScope<T>(
  toolUseId: string,
  stopController: AbortController,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ toolUseId, stopController }, fn)
}

export function getToolStopControllerFromScope(): AbortController | undefined {
  return storage.getStore()?.stopController
}

export function getToolUseIdFromStopScope(): string | undefined {
  return storage.getStore()?.toolUseId
}

/** Combine parent (stream) abort with optional per-tool stop; if no scope, returns parent. */
export function mergeWithParentToolStop(parent: AbortSignal): AbortSignal {
  const scoped = getToolStopControllerFromScope()
  if (!scoped) return parent
  return mergeAbortSignals(parent, scoped.signal)
}

export function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const merged = new AbortController()
  const fire = () => {
    try {
      merged.abort()
    } catch {
      /* ignore */
    }
  }
  if (a.aborted || b.aborted) {
    fire()
    return merged.signal
  }
  a.addEventListener('abort', fire, { once: true })
  b.addEventListener('abort', fire, { once: true })
  return merged.signal
}
