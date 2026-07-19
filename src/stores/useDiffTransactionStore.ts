/**
 * Renderer mirror of the main-process DiffTransactionStore (P1 shadow).
 *
 * Contract:
 *   • READ-ONLY. The renderer never mutates DTs; it only observes. Any "intent" (approve,
 *     reject, retry, rebase) will land in a separate action module in P2 so the read path
 *     stays trivially correct.
 *   • Source of truth for rendering (starting from P2). In P1 this store runs in shadow;
 *     existing components (`DiffEditorView`, `InlineDiffController`) still use the legacy
 *     `useFileStore.pendingChanges`. Components that want to opt-in early can read this
 *     store for observability (e.g. diagnostics overlay).
 *   • Cold-start: `useDiffTransactionStore.getState().bootstrap()` fetches the full
 *     snapshot via IPC. We kick this off once at app mount.
 *   • Hot updates: a long-lived `onBroadcast` subscription folds each event into the map.
 */

import { create } from 'zustand'

/**
 * We keep the renderer-side type mirror minimal and intentionally loose — the serialised
 * payload shape is defined in `electron/diff/DiffTransactionTypes.ts`. Over-specifying it
 * here would force a compile-time coupling between the two package boundaries; treating
 * it as `unknown` at the edge and narrowing inside the store keeps us resilient.
 */
export interface RendererDiffTransaction {
  id: string
  filePath: string
  state: RendererDtState
  baseSnapshot: {
    content: string
    contentHash: string
    mtimeMs: number
    fileExisted: boolean
    readId: string | null
  }
  proposed: {
    content: string
    toolName: string
    toolUseId: string
    editParams?: { oldString: string; newString: string; replaceAll: boolean }
  }
  permissionRequestId: string | null
  appliedContentHash: string | null
  appliedReadId: string | null
  stateHistory: Array<{
    from: RendererDtState
    to: RendererDtState
    at: number
    reason?: string
    errorCode?: string
  }>
  error: { code: string; message: string; recoverable: boolean } | null
  riskWarnings?: string[]
  createdAt: number
  updatedAt: number
}

export type RendererDtState =
  | 'Pending'
  | 'Approved'
  | 'Writing'
  | 'Applied'
  | 'Rejected'
  | 'Failed'
  | 'Stale'

/** Loose shape matching the main-process `DtBroadcast`. We narrow via the discriminant. */
type DtBroadcast =
  | { type: 'Snapshot'; transactions: RendererDiffTransaction[] }
  | { type: 'Created'; transaction: RendererDiffTransaction }
  | {
      type: 'Transitioned'
      id: string
      from: RendererDtState
      to: RendererDtState
      transaction: RendererDiffTransaction
    }
  | { type: 'Closed'; id: string; finalState: RendererDtState }
  | { type: 'Rebased'; transaction: RendererDiffTransaction }
  | { type: 'Dropped'; id: string }

interface DiffTransactionStore {
  /** All live DTs, keyed by id. Callers that want "per file" should derive, not mutate. */
  transactionsById: Map<string, RendererDiffTransaction>
  /** Incremented on every update so selector hooks re-run cheaply. */
  revision: number
  /** True once `bootstrap()` has returned. Useful for "still loading..." placeholders. */
  bootstrapped: boolean
  /** Last received error from the bridge (IPC dropped, snapshot failed). Cleared on success. */
  lastBridgeError: string | null

  bootstrap: () => Promise<void>
  /** Internal: apply one broadcast event. Exported for tests. */
  _apply: (event: DtBroadcast) => void
  /** Release IPC subscription — call on app teardown (HMR cleanup). */
  disconnect: () => void
}

let ipcUnsubscribe: (() => void) | null = null

/** Narrowing guard — main process promises these shapes but we validate at the edge. */
function isDtBroadcast(value: unknown): value is DtBroadcast {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { type?: unknown }
  return typeof v.type === 'string'
}

export const useDiffTransactionStore = create<DiffTransactionStore>((set, get) => ({
  transactionsById: new Map(),
  revision: 0,
  bootstrapped: false,
  lastBridgeError: null,

  bootstrap: async () => {
    const api = window.electronAPI?.diffTx
    if (!api) {
      // In non-electron test harnesses the bridge simply isn't present — that's fine.
      set({ bootstrapped: true })
      return
    }

    // Subscribe FIRST so we don't miss events emitted between snapshot and subscribe.
    // Broadcasts received before the snapshot fold onto an empty map, then the snapshot
    // rebuilds the authoritative set; duplicates are OK because Created/Transitioned use
    // the same id and Map.set is idempotent for same-id updates.
    if (ipcUnsubscribe) ipcUnsubscribe()
    ipcUnsubscribe = api.onBroadcast((event) => {
      if (isDtBroadcast(event)) get()._apply(event)
    })

    try {
      const snap = (await api.requestSnapshot()) as { transactions: RendererDiffTransaction[] }
      get()._apply({ type: 'Snapshot', transactions: snap.transactions })
      set({ bootstrapped: true, lastBridgeError: null })
    } catch (err) {
      set({
        bootstrapped: true,
        lastBridgeError: err instanceof Error ? err.message : String(err),
      })
    }
  },

  _apply: (event) => {
    const { transactionsById, revision } = get()
    const next = new Map(transactionsById)
    switch (event.type) {
      case 'Snapshot': {
        next.clear()
        for (const tx of event.transactions) next.set(tx.id, tx)
        break
      }
      case 'Created':
      case 'Transitioned':
      case 'Rebased': {
        next.set(event.transaction.id, event.transaction)
        break
      }
      case 'Closed': {
        // Keep the record in the map so UI can show the final state briefly (e.g. "Applied"
        // checkmark). A follow-up 'Dropped' event clears it from memory.
        const existing = next.get(event.id)
        if (existing) {
          next.set(event.id, { ...existing, state: event.finalState, updatedAt: Date.now() })
        }
        break
      }
      case 'Dropped': {
        next.delete(event.id)
        break
      }
    }
    set({ transactionsById: next, revision: revision + 1 })
  },

  disconnect: () => {
    if (ipcUnsubscribe) {
      ipcUnsubscribe()
      ipcUnsubscribe = null
    }
  },
}))

/** Selector: all DTs touching a given file path (normalized). */
export function selectDtsForPath(filePath: string): (state: DiffTransactionStore) => RendererDiffTransaction[] {
  const key = filePath.replace(/\\/g, '/').toLowerCase()
  return (state) => {
    const out: RendererDiffTransaction[] = []
    for (const tx of state.transactionsById.values()) {
      if (tx.filePath.replace(/\\/g, '/').toLowerCase() === key) out.push(tx)
    }
    return out
  }
}

/** Selector: active (non-terminal) DTs, sorted newest first. Cheap for UI lists. */
export function selectActiveDts(state: DiffTransactionStore): RendererDiffTransaction[] {
  const out: RendererDiffTransaction[] = []
  for (const tx of state.transactionsById.values()) {
    if (tx.state !== 'Applied' && tx.state !== 'Rejected') out.push(tx)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}
