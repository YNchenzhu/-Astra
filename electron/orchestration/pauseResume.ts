/**
 * Pause / Resume semantics for OrchestrationKernel.
 *
 * Strategic alignment with the IDE pausable background agents:
 *   - `pause()` flips a kernel-internal flag. The next iteration boundary observes it and awaits
 *     until `resume()` is called. This is cooperative: pause only takes effect between steps, not
 *     mid-tool. For hard cancellation use `interrupt()` .
 *   - `persist()` serializes the kernel state (transcript + inbox + counters + interrupt state +
 *     pause flag) to disk via SessionStorePort so the session survives process restart.
 *   - `restore()` reverses the persist, producing a fresh kernel seeded from the last saved blob.
 *
 * The cooperative checkpoint is exposed via {@link createPauseGate} which kernel's drive mode
 * (future) awaits inside its `while` loop. Legacy delegate path (`runLegacyDelegateMainChat`) can
 * call the gate at the single CallModel boundary today for minimal integration.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { KernelLoopState } from './kernelTypes'
import { cloneTranscript, normalizeKernelLoopState } from './kernelTypes'

export type PauseGate = {
  /** Async — resolves immediately if not paused, otherwise awaits until resume(). */
  awaitResume(): Promise<void>
  pause(): void
  resume(): void
  /** For tests + telemetry. */
  isPaused(): boolean
}

/**
 * Factory for a cooperative pause gate. Multiple `awaitResume()` callers share a single waiter
 * promise so they all unblock atomically on `resume()`.
 */
export function createPauseGate(): PauseGate {
  let paused = false
  let waitPromise: Promise<void> | null = null
  let resolveWait: (() => void) | null = null

  const ensureWaiter = () => {
    if (!waitPromise) {
      waitPromise = new Promise<void>((resolve) => {
        resolveWait = resolve
      })
    }
    return waitPromise
  }

  return {
    async awaitResume(): Promise<void> {
      if (!paused) return
      await ensureWaiter()
    },
    pause(): void {
      paused = true
    },
    resume(): void {
      if (!paused) return
      paused = false
      const r = resolveWait
      resolveWait = null
      waitPromise = null
      r?.()
    },
    isPaused(): boolean {
      return paused
    },
  }
}

/**
 * Persistable snapshot of the kernel — intentionally a plain JSON-safe object so durable stores
 * (file, SQLite, IndexedDB) do not need custom serializers.
 */
export type PersistedKernelState = {
  version: 1
  savedAt: number
  conversationId: string
  state: KernelLoopState
  paused: boolean
  interruptReason?: string
}

export interface KernelPersistenceAdapter {
  /** Write a persisted state blob for `conversationId`. */
  save(blob: PersistedKernelState): Promise<void> | void
  /** Read latest blob for `conversationId`, or null if none exists. */
  load(conversationId: string): Promise<PersistedKernelState | null> | PersistedKernelState | null
  /** Remove blob (e.g. on explicit delete or after Terminal commits). */
  delete(conversationId: string): Promise<void> | void
}

/**
 * File-backed adapter under `<baseDir>/kernel-state/<safe-conv-id>.json`. Safe for Electron
 * userData path + session rollbacks (writes are atomic via tmp+rename).
 */
export function createFileKernelPersistenceAdapter(
  baseDir: string,
): KernelPersistenceAdapter {
  const dir = path.join(baseDir, 'kernel-state')
  const ensureDir = () => {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
  }
  const safeId = (id: string): string =>
    id.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200) || 'default'
  const filePath = (id: string): string => path.join(dir, `${safeId(id)}.json`)

  return {
    save(blob) {
      ensureDir()
      const p = filePath(blob.conversationId)
      const tmp = `${p}.tmp`
      // Deep clone transcript for JSON safety.
      const safeBlob: PersistedKernelState = {
        ...blob,
        state: {
          ...blob.state,
          transcript: cloneTranscript(blob.state.transcript),
          inbox: blob.state.inbox.map((item) => ({ ...item })),
        },
      }
      try {
        fs.writeFileSync(tmp, JSON.stringify(safeBlob), 'utf-8')
        fs.renameSync(tmp, p)
      } catch (e) {
        console.warn('[KernelPersistenceAdapter] save failed:', e)
      }
    },
    load(conversationId) {
      const p = filePath(conversationId)
      if (!fs.existsSync(p)) return null
      try {
        const raw = fs.readFileSync(p, 'utf-8')
        const parsed = JSON.parse(raw) as PersistedKernelState
        if (parsed.version !== 1) return null
        if (parsed.conversationId !== conversationId) return null
        return {
          ...parsed,
          state: normalizeKernelLoopState(parsed.state),
        }
      } catch (e) {
        console.warn('[KernelPersistenceAdapter] load failed:', e)
        return null
      }
    },
    delete(conversationId) {
      const p = filePath(conversationId)
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p)
      } catch (e) {
        console.warn('[KernelPersistenceAdapter] delete failed:', e)
      }
    },
  }
}

/** Build a persisted blob from a kernel's current observable state. */
export function buildPersistedState(args: {
  conversationId: string
  state: KernelLoopState
  paused: boolean
  interruptReason?: string
}): PersistedKernelState {
  return {
    version: 1,
    savedAt: Date.now(),
    conversationId: args.conversationId,
    state: normalizeKernelLoopState({
      ...args.state,
      transcript: cloneTranscript(args.state.transcript),
      inbox: args.state.inbox.map((item) => ({ ...item })),
    }),
    paused: args.paused,
    ...(args.interruptReason ? { interruptReason: args.interruptReason } : {}),
  }
}
