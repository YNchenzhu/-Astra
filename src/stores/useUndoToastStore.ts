/**
 * Undo toast store (P4c).
 *
 * Mirrors the main-process UndoQueue for the renderer so a small toast component can
 * surface "Applied — [Undo]" notifications without polling. The strategy matches the
 * DiffTransaction store: observe the DT broadcast stream, pick out
 * `Transitioned → Applied` events, and register them as local toast entries with
 * auto-expiry.
 *
 * Kept separate from `useDiffTransactionStore` because the lifecycles differ:
 *   • DT store: entire lifecycle, every state, for rendering diff views.
 *   • Undo toast: only the Applied event, for a short-lived UI notification.
 *
 * Why mirror state in the renderer rather than query on every render:
 *   IPC round-trips cost ~1ms; timer-driven state transitions (toast expiry) would
 *   turn that into a busy loop. A local mirror driven by broadcasts is O(1) per event.
 *
 * Safety rails:
 *   • Only activates when `diffPrecisionMode === 'dt'` — in legacy mode the feature
 *     is opt-out (we don't know which writes were atomic, so offering "Undo" would lie).
 *   • Retention bound matches the main-process queue default (5 min). If the two drift
 *     you'd see expired toasts whose undo call fails — not catastrophic but visible.
 */

import { create } from 'zustand'

/** One toast entry. Matches a subset of the main-process UndoQueueEntry. */
export interface UndoToast {
  dtId: string
  filePath: string
  appliedAt: number
  expiresAt: number
  /** Bytes that'll be restored. Used only for the tooltip ("Undo this 42-byte change"). */
  approximateBytes: number
  /**
   * Local state:
   *   • 'active' — user can click Undo.
   *   • 'undoing' — optimistic UI while the IPC is in flight.
   *   • 'undone' — main confirmed the undo; kept for a moment so the user sees a check.
   *   • 'failed' — undo returned !ok; kept briefly with the error message.
   *   • 'expired' — retention window passed; cleaned up on next tick.
   */
  status: 'active' | 'undoing' | 'undone' | 'failed' | 'expired'
  errorMessage?: string
}

const TOAST_RETENTION_MS = 5 * 60 * 1000
const POST_UNDONE_LINGER_MS = 2500
const POST_FAILED_LINGER_MS = 5000

interface UndoToastStore {
  toasts: UndoToast[]
  addFromApplied: (tx: {
    id: string
    filePath: string
    proposedBytes: number
  }) => void
  markUndoing: (dtId: string) => void
  markUndone: (dtId: string) => void
  markFailed: (dtId: string, reason: string) => void
  dismiss: (dtId: string) => void
  /** Sweep expired / lingered entries. Called by the expiry timer. */
  sweep: () => void
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

export const useUndoToastStore = create<UndoToastStore>((set, get) => ({
  toasts: [],

  addFromApplied: (tx) => {
    const now = Date.now()
    const toast: UndoToast = {
      dtId: tx.id,
      filePath: tx.filePath,
      appliedAt: now,
      expiresAt: now + TOAST_RETENTION_MS,
      approximateBytes: tx.proposedBytes,
      status: 'active',
    }
    // De-dupe: if the same DT id is already toasted (shouldn't happen), replace.
    set((s) => ({
      toasts: [toast, ...s.toasts.filter((t) => t.dtId !== tx.id)],
    }))
    ensureSweeper()
  },

  markUndoing: (dtId) => {
    set((s) => ({
      toasts: s.toasts.map((t) => (t.dtId === dtId ? { ...t, status: 'undoing' } : t)),
    }))
  },

  markUndone: (dtId) => {
    set((s) => ({
      toasts: s.toasts.map((t) =>
        t.dtId === dtId
          ? { ...t, status: 'undone', expiresAt: Date.now() + POST_UNDONE_LINGER_MS }
          : t,
      ),
    }))
  },

  markFailed: (dtId, reason) => {
    set((s) => ({
      toasts: s.toasts.map((t) =>
        t.dtId === dtId
          ? {
              ...t,
              status: 'failed',
              errorMessage: reason,
              expiresAt: Date.now() + POST_FAILED_LINGER_MS,
            }
          : t,
      ),
    }))
  },

  dismiss: (dtId) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.dtId !== dtId) }))
  },

  sweep: () => {
    const now = Date.now()
    const next = get().toasts.filter((t) => t.expiresAt > now)
    if (next.length !== get().toasts.length) set({ toasts: next })
  },
}))

/** Single shared sweep timer — created lazily on first toast, torn down when empty. */
function ensureSweeper(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    // `getState()` returns a snapshot — `store.toasts` would still point at
    // the pre-sweep array even after `sweep()` calls `set({ toasts: next })`.
    // Without re-reading state we'd see length > 0 for one extra tick after
    // the last entry expired, and the timer would only self-clear on the
    // *next* iteration. Cheap to re-call; keeps the empty-shutdown exact.
    useUndoToastStore.getState().sweep()
    if (useUndoToastStore.getState().toasts.length === 0) {
      if (sweepTimer) {
        clearInterval(sweepTimer)
        sweepTimer = null
      }
    }
  }, 1000)
}

/** Test-only: force-clear toasts + timer. */
export function __resetUndoToastsForTests(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  useUndoToastStore.setState({ toasts: [] })
}
