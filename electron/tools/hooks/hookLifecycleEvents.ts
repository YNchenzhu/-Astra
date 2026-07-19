/**
 * Lightweight hook execution lifecycle bus (upstream §9.5-style observability).
 * Main process extensions / tests can subscribe; default install does nothing.
 */

import type { HookEvent, HookExecutionKind } from './types'

export type HookLifecycleSource = 'config' | 'agent' | 'skill'

export interface HookLifecyclePayload {
  phase: 'before' | 'after'
  event: HookEvent
  toolName: string
  hookId?: string
  command?: string
  executionKind?: HookExecutionKind
  exitCode?: number
  source: HookLifecycleSource
}

const listeners = new Set<(payload: HookLifecyclePayload) => void>()

export function onHookLifecycle(cb: (payload: HookLifecyclePayload) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function emitHookLifecycle(payload: HookLifecyclePayload): void {
  for (const cb of listeners) {
    try {
      cb(payload)
    } catch {
      /* subscriber errors must not break hook engine */
    }
  }
}
