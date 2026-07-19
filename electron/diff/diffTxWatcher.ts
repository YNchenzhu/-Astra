/**
 * DT-scoped file watcher (P3a).
 *
 * Purpose: detect the "someone modified the file while it was pending review" race and
 * drive the DT into `Stale` so the renderer shows a rebase affordance instead of a
 * silently stale diff.
 *
 * Design:
 *   • One chokidar watcher per distinct filePath. Reference-counted by active DT id so
 *     closing a DT does not rip the watcher out from under a parallel DT on the same
 *     path (rare, but allowed by the queue model in P4).
 *   • On `change`:
 *       1. Read current content → compute hash.
 *       2. Compare with every active DT on that path.
 *       3. If hash differs from a DT's baseSnapshot.contentHash → dispatch `MarkStale`.
 *       4. If hash equals baseSnapshot.contentHash (e.g. our own write on `Applied`
 *          bounce) → no-op. Saves spurious Stale transitions for our own writes.
 *   • Debounced 120ms to collapse editor save bursts (save + format + fix = 3 events).
 *   • `attachStaleWatcher({ autoStart })` defaults `autoStart=true`; the
 *     production caller (`electron/lifecycle/appBootstrap.ts`) currently
 *     attaches with `autoStart: true`, so the watcher runs by default in
 *     packaged builds. Tests pass `{ autoStart: false }` and drive it
 *     manually. (Earlier revisions documented a `DT_STALE_WATCHER=off`
 *     env switch — that switch was never wired and has been removed
 *     from this comment to avoid misleading readers.)
 *
 * Testability: chokidar is imported indirectly through the `createFsWatcher` factory so
 * unit tests can inject a fake that emits events synchronously. Production callers use
 * the default factory, which lazy-imports chokidar on first use.
 */

import fs from 'node:fs'
import { hashFileContent } from '../tools/readFileState'
import { getDiffTxStore, type DiffTransactionStore } from './DiffTransactionStore'
import { isDtClosed } from './diffTransactionFsm'
import type { DiffTransaction } from './DiffTransactionTypes'

/** Minimal abstract watcher surface — the slice of chokidar we actually use. */
export interface IFsWatcher {
  on(event: 'change', handler: (path: string) => void): this
  on(event: 'unlink', handler: (path: string) => void): this
  on(event: 'error', handler: (err: unknown) => void): this
  close(): Promise<void> | void
}

export type WatcherFactory = (filePath: string) => IFsWatcher

function defaultWatcherFactory(filePath: string): IFsWatcher {
  // Lazy-require so unit tests that never trigger it don't pay the chokidar load cost.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const chokidar = require('chokidar') as typeof import('chokidar')
  const w = chokidar.watch(filePath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      // Chokidar's built-in "file stopped changing" debouncer. 80ms is tight enough
      // for interactive feel, loose enough to collapse common save+format bursts.
      stabilityThreshold: 80,
      pollInterval: 40,
    },
    atomic: true,
  })
  return w
}

type WatcherEntry = {
  watcher: IFsWatcher
  /** DT ids currently anchored to this path. Empty set → watcher can be closed. */
  anchors: Set<string>
  /** Debounce handle for collapsing rapid-fire events. */
  pending: ReturnType<typeof setTimeout> | null
}

/**
 * Watcher manager. One instance per process is usually enough; we expose the class so
 * tests can construct isolated managers.
 */
export class DiffTxStaleWatcher {
  private readonly entries = new Map<string, WatcherEntry>()
  private storeUnsubscribe: (() => void) | null = null
  // Parameter-properties aren't erasable — expand to explicit fields so the class
  // compiles under tsconfig `erasableSyntaxOnly`.
  private readonly store: DiffTransactionStore
  private readonly opts: {
    watcherFactory?: WatcherFactory
    debounceMs?: number
  }

  constructor(
    store: DiffTransactionStore,
    opts: {
      watcherFactory?: WatcherFactory
      debounceMs?: number
    } = {},
  ) {
    this.store = store
    this.opts = opts
  }

  private keyFor(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase()
  }

  /**
   * Subscribe to the DT store and mirror its lifecycle onto watcher refcounts. Safe to
   * call multiple times; re-subscription replaces the prior one.
   */
  start(): void {
    if (this.storeUnsubscribe) this.storeUnsubscribe()
    this.storeUnsubscribe = this.store.addListener((event) => {
      switch (event.type) {
        case 'Snapshot':
          for (const tx of event.transactions) this.syncAnchor(tx)
          break
        case 'Created':
          this.syncAnchor(event.transaction)
          break
        case 'Transitioned':
          this.syncAnchor(event.transaction)
          break
        case 'Rebased':
          this.syncAnchor(event.transaction)
          break
        case 'Closed':
        case 'Dropped':
          this.unanchor(event.id)
          break
      }
    })
    // Also fold in whatever is already in the store (for late starts).
    for (const tx of this.store.snapshot()) this.syncAnchor(tx)
  }

  /** Tear everything down. Safe to call multiple times. */
  stop(): void {
    if (this.storeUnsubscribe) {
      this.storeUnsubscribe()
      this.storeUnsubscribe = null
    }
    for (const entry of this.entries.values()) {
      if (entry.pending) clearTimeout(entry.pending)
      try {
        void entry.watcher.close()
      } catch {
        /* ignore */
      }
    }
    this.entries.clear()
  }

  /** Expose for diagnostics / tests. */
  hasWatcherFor(filePath: string): boolean {
    return this.entries.has(this.keyFor(filePath))
  }

  anchorsFor(filePath: string): number {
    return this.entries.get(this.keyFor(filePath))?.anchors.size ?? 0
  }

  // ---------- internals ----------

  private syncAnchor(tx: DiffTransaction): void {
    const key = this.keyFor(tx.filePath)
    const shouldWatch = !isDtClosed(tx)
    const entry = this.entries.get(key)

    if (!shouldWatch) {
      this.unanchor(tx.id)
      return
    }

    if (entry) {
      entry.anchors.add(tx.id)
      return
    }

    // Create a new watcher.
    const factory = this.opts.watcherFactory ?? defaultWatcherFactory
    let watcher: IFsWatcher
    try {
      watcher = factory(tx.filePath)
    } catch (e) {
      console.warn('[DT-watcher] chokidar construction failed:', e)
      return
    }
    const newEntry: WatcherEntry = {
      watcher,
      anchors: new Set([tx.id]),
      pending: null,
    }
    this.entries.set(key, newEntry)

    const onChange = (eventKind: 'change' | 'unlink') => () => {
      this.scheduleStaleCheck(tx.filePath, eventKind)
    }
    watcher.on('change', onChange('change'))
    watcher.on('unlink', onChange('unlink'))
    watcher.on('error', (err) => {
      console.warn(`[DT-watcher] ${tx.filePath} watcher error:`, err)
    })
  }

  private unanchor(txId: string): void {
    // The caller may not know which filePath's entry holds this txId, so scan.
    for (const [key, entry] of this.entries.entries()) {
      if (!entry.anchors.has(txId)) continue
      entry.anchors.delete(txId)
      if (entry.anchors.size === 0) {
        if (entry.pending) clearTimeout(entry.pending)
        try {
          void entry.watcher.close()
        } catch {
          /* ignore */
        }
        this.entries.delete(key)
      }
      return
    }
  }

  private scheduleStaleCheck(filePath: string, eventKind: 'change' | 'unlink'): void {
    const key = this.keyFor(filePath)
    const entry = this.entries.get(key)
    if (!entry) return

    if (entry.pending) clearTimeout(entry.pending)
    entry.pending = setTimeout(() => {
      entry.pending = null
      this.runStaleCheck(filePath, eventKind)
    }, this.opts.debounceMs ?? 120)
  }

  /** The heart of the watcher. Public for tests that want to drive it synchronously. */
  runStaleCheck(filePath: string, eventKind: 'change' | 'unlink'): void {
    const key = this.keyFor(filePath)
    const entry = this.entries.get(key)
    if (!entry) return

    // For unlink we can skip the read; for change we compute fresh hash.
    let currentHash: string | null = null
    if (eventKind === 'change') {
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        currentHash = hashFileContent(content)
      } catch {
        // File disappeared between event and read — treat as unlink.
        currentHash = null
      }
    }

    for (const txId of Array.from(entry.anchors)) {
      const tx = this.store.get(txId as DiffTransaction['id'])
      if (!tx || isDtClosed(tx)) {
        entry.anchors.delete(txId)
        continue
      }

      // If the hash on disk equals our baseSnapshot we did not drift — common when WE
      // just wrote the file ourselves via `atomicWriteFile` and chokidar is echoing
      // our own change. Don't spam Stale in that case.
      if (currentHash !== null && currentHash === tx.baseSnapshot.contentHash) continue

      // Also: if hash matches the PROPOSED content, this is the expected "Applied"
      // bounce. The DT will transition to Applied elsewhere; no need for Stale.
      if (currentHash !== null && tx.appliedContentHash !== null && currentHash === tx.appliedContentHash) continue

      // Genuine external drift → mark stale.
      const reason =
        eventKind === 'unlink'
          ? 'file was deleted on disk'
          : 'external modification detected via fs watcher'
      this.store.dispatch({ type: 'MarkStale', id: tx.id, reason })
    }

    if (entry.anchors.size === 0) {
      try {
        void entry.watcher.close()
      } catch {
        /* ignore */
      }
      this.entries.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// Process-wide convenience — matches the pattern used by DiffTransactionStore.
// ---------------------------------------------------------------------------

let globalWatcher: DiffTxStaleWatcher | null = null

/**
 * Attach (and auto-start) the stale watcher to the global DT store. No-op if already
 * running. The opt-in flag is deliberately verbose because watchers are a real resource
 * drain on large projects.
 */
export function attachStaleWatcher(opts: { autoStart: boolean } = { autoStart: true }): DiffTxStaleWatcher {
  if (!globalWatcher) {
    globalWatcher = new DiffTxStaleWatcher(getDiffTxStore())
  }
  if (opts.autoStart) globalWatcher.start()
  return globalWatcher
}

export function shutdownStaleWatcher(): void {
  if (globalWatcher) {
    globalWatcher.stop()
    globalWatcher = null
  }
}

/** Test-only: replace the singleton. */
export function __resetStaleWatcherForTests(): void {
  if (globalWatcher) globalWatcher.stop()
  globalWatcher = null
}
