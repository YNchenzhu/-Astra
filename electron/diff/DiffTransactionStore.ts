/**
 * Main-process store for DiffTransactions.
 *
 * Responsibilities:
 *   1. Hold the canonical DT map (by id) and an index by filePath for queue lookups (P2+).
 *   2. Serialise all mutations through the pure FSM reducer.
 *   3. Emit broadcast events to anyone listening (IPC layer, in-proc logs, tests).
 *   4. Expose query helpers that never expose mutable internals (deep-cloneable snapshots).
 *
 * Explicitly NOT responsible for (stays outside the store for testability):
 *   • IPC plumbing (see `diffTxIpc.ts`).
 *   • File I/O, hashing (done by the caller — e.g. `shadowIntegration.ts` — using the
 *     existing `readFileState.hashFileContent`).
 *   • File watchers / staleness detection (P3).
 *
 * Concurrency: Electron main process is single-threaded JavaScript; all mutations run on
 * the event loop. No locks needed as long as the reducer remains synchronous.
 */

import { randomUUID } from 'node:crypto'
import type {
  DiffTransaction,
  DiffTxId,
  DtBroadcast,
  DtEvent,
  DtState,
} from './DiffTransactionTypes'
import { createDiffTransaction, isDtClosed, reduce } from './diffTransactionFsm'

type Listener = (event: DtBroadcast) => void

export class DiffTransactionStore {
  private readonly byId = new Map<DiffTxId, DiffTransaction>()
  /** `pathKey -> Set<DiffTxId>`. Same path can have multiple queued DTs (see P3). */
  private readonly byPath = new Map<string, Set<DiffTxId>>()
  private readonly listeners = new Set<Listener>()

  /** Mint a fresh, distinguishable DT id. Exposed so callers can reference it before create. */
  newId(): DiffTxId {
    return `dt-${randomUUID()}` as DiffTxId
  }

  /** Normalised key used for path lookups — cross-platform, case-insensitive on Windows-style paths. */
  private keyFor(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase()
  }

  /**
   * Create and insert a brand-new DT. Returns the stored clone (never the internal ref).
   * If an `id` is supplied it must be unused; collisions throw (the caller's UUID gen is
   * expected to be reliable). We broadcast a `Created` event so IPC subscribers can sync.
   */
  create(params: {
    id?: DiffTxId
    filePath: string
    baseSnapshot: DiffTransaction['baseSnapshot']
    proposed: DiffTransaction['proposed']
    riskWarnings?: string[]
    at?: number
  }): DiffTransaction {
    const id = params.id ?? this.newId()
    if (this.byId.has(id)) {
      throw new Error(`DiffTransactionStore.create: id collision ${id}`)
    }
    const dt = createDiffTransaction({ ...params, id })
    this.byId.set(id, dt)
    const pk = this.keyFor(params.filePath)
    let set = this.byPath.get(pk)
    if (!set) {
      set = new Set()
      this.byPath.set(pk, set)
    }
    set.add(id)
    this.emit({ type: 'Created', transaction: this.cloneFor(dt) })
    return this.cloneFor(dt)
  }

  /**
   * Dispatch a (non-Create) event. Returns the updated DT on success, or a structured error.
   * All errors are swallowed into the return value — the store itself never throws for
   * protocol violations (ie. callers misusing the API); that way one buggy call site can't
   * take down the whole DT layer.
   */
  dispatch(evt: DtEvent): { ok: true; transaction: DiffTransaction } | { ok: false; reason: string } {
    if (evt.type === 'Create') {
      return { ok: false, reason: 'Use DiffTransactionStore.create() for Create events.' }
    }
    const dt = this.byId.get(evt.id)
    if (!dt) {
      return { ok: false, reason: `DiffTransaction ${evt.id} not found (already closed?)` }
    }
    const r = reduce(dt, evt)
    if (!r.ok) return r
    const next = r.next
    this.byId.set(next.id, next)
    // Broadcast ordering contract (stable, renderer may rely on it):
    //   1. `Transitioned`  — always emitted when state changed.
    //   2. `Rebased`       — additionally emitted for Rebase events so UI can flash a
    //                        banner without parsing reason strings. Rebase always comes
    //                        with a state change, so this fires AFTER `Transitioned`.
    //   3. `Closed`        — if the new state is terminal.
    // Metadata-only events (LinkPermissionRequest) emit nothing; observers diff on the
    // next state-changing event.
    if (r.transition) {
      this.emit({
        type: 'Transitioned',
        id: next.id,
        from: r.transition.from,
        to: r.transition.to,
        transaction: this.cloneFor(next),
      })
      if (evt.type === 'Rebase') {
        this.emit({ type: 'Rebased', transaction: this.cloneFor(next) })
      }
      if (isDtClosed(next)) {
        this.emit({ type: 'Closed', id: next.id, finalState: next.state })
      }
    }
    return { ok: true, transaction: this.cloneFor(next) }
  }

  /** Drop a DT from the store. Used by GC to reclaim memory after terminal state is observed. */
  drop(id: DiffTxId): void {
    const dt = this.byId.get(id)
    if (!dt) return
    const pk = this.keyFor(dt.filePath)
    const set = this.byPath.get(pk)
    if (set) {
      set.delete(id)
      if (set.size === 0) this.byPath.delete(pk)
    }
    this.byId.delete(id)
    this.emit({ type: 'Dropped', id })
  }

  /** Retrieve one DT by id (clone — callers can't mutate). */
  get(id: DiffTxId): DiffTransaction | undefined {
    const dt = this.byId.get(id)
    return dt ? this.cloneFor(dt) : undefined
  }

  /** All non-terminal DTs for a file (used by conflict / queue logic). */
  getActiveForFile(filePath: string): DiffTransaction[] {
    const set = this.byPath.get(this.keyFor(filePath))
    if (!set) return []
    const out: DiffTransaction[] = []
    for (const id of set) {
      const dt = this.byId.get(id)
      if (dt && !isDtClosed(dt)) out.push(this.cloneFor(dt))
    }
    return out
  }

  /** Snapshot of every live DT (clones). Used by the IPC bridge on renderer connect. */
  snapshot(): DiffTransaction[] {
    const out: DiffTransaction[] = []
    for (const dt of this.byId.values()) out.push(this.cloneFor(dt))
    return out
  }

  /** Count (excluding dropped). Cheap for test assertions. */
  size(): number {
    return this.byId.size
  }

  // ---------- subscription ----------

  addListener(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /**
   * Send a full snapshot to a single listener — used by IPC when a new renderer attaches
   * so it can bootstrap its mirror store without racing live events.
   */
  sendSnapshotTo(fn: Listener): void {
    fn({ type: 'Snapshot', transactions: this.snapshot() })
  }

  private emit(event: DtBroadcast): void {
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch (e) {
        // A misbehaving listener must never stall the store.
        console.error('[DiffTransactionStore] listener threw:', e)
      }
    }
  }

  /**
   * Deep-ish clone for output. stateHistory + riskWarnings are arrays we want defensively
   * copied; everything else is primitives or frozen-by-convention. We avoid JSON.parse(
   * JSON.stringify(...)) because `state` could theoretically grow methods in the future.
   */
  private cloneFor(dt: DiffTransaction): DiffTransaction {
    const clone: DiffTransaction = {
      ...dt,
      baseSnapshot: { ...dt.baseSnapshot },
      proposed: { ...dt.proposed, editParams: dt.proposed.editParams ? { ...dt.proposed.editParams } : undefined },
      stateHistory: dt.stateHistory.map((h) => ({ ...h })),
      error: dt.error ? { ...dt.error } : null,
    }
    if (dt.riskWarnings) clone.riskWarnings = [...dt.riskWarnings]
    return clone
  }

  /** Test-only: hard reset. Production code should use `drop`. */
  reset(): void {
    this.byId.clear()
    this.byPath.clear()
    this.listeners.clear()
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton. Modules throughout the main process import `getDiffTxStore()`.
// Unit tests should construct their own DiffTransactionStore to stay isolated.
// ---------------------------------------------------------------------------

let globalStore: DiffTransactionStore | null = null

export function getDiffTxStore(): DiffTransactionStore {
  if (!globalStore) globalStore = new DiffTransactionStore()
  return globalStore
}

/** Test-only: replace or clear the singleton between tests. */
export function __resetDiffTxStoreForTests(): void {
  globalStore = null
}

/** Expose DtState re-export for callers that need to branch on terminal/non-terminal. */
export type { DtState }
