/**
 * DT-mode authoritative sync bridge (P2).
 *
 * When `diffPrecisionMode === 'dt'`, this module is the one place that translates
 * DiffTransaction state transitions into renderer-side UI updates:
 *
 *   • `Pending` / `Approved` / `Writing` → leave pendingChange + tab.content alone so the
 *     diff stays visible and the Editor keeps rendering `modifiedContent` without a flash.
 *   • `Applied`   → remove pendingChange (diff closes); tab.content will be synced by the
 *     existing `file_change_applied` stream handler (authoritative post-write bytes).
 *   • `Failed`    → keep pendingChange BUT annotate it as failed so InlineDiffController
 *     can show an error banner + Retry/Abort. Tab content remains `original`.
 *   • `Rejected`  → remove pendingChange; tab.content stays original (disk untouched).
 *   • `Stale`     → keep pendingChange with a staleness annotation (P3 implements rebase).
 *
 * Safety rails:
 *   • Feature-flagged. In `legacy` mode this bridge is a no-op.
 *   • Rescue timeout: if a DT we care about never transitions out of `Approved/Writing`
 *     within 8 seconds we assume the DT bridge dropped an event and fall back to legacy
 *     behaviour for THAT pendingChange (remove it). Prevents permanent "stuck diff" UI.
 *   • Single listener. We register once on `bootstrap()` and idempotently re-subscribe if
 *     HMR tears down the hook. No double-handling.
 */

import { useEffect, useRef } from 'react'
import { useFileStore } from './useFileStore'
import { useSettingsStore } from './useSettingsStore'
import { useDiffTransactionStore, type RendererDiffTransaction } from './useDiffTransactionStore'
import { useUndoToastStore } from './useUndoToastStore'

/**
 * Max time we'll wait for a DT to leave `Approved`/`Writing` before giving up and
 * cleaning up the pending change the legacy way. 8s is long enough for a typical
 * edit+fsync+verify round trip on slow disks, short enough that a user doesn't stare
 * at a frozen accept button.
 */
const DT_RESCUE_TIMEOUT_MS = 8_000

type FailureAnnotation = {
  failedAt: number
  errorCode: string
  errorMessage: string
}

/**
 * Side-table keyed by filePath (normalized) containing P2-specific overlays onto the
 * legacy PendingChange. We keep these out of the core `PendingChange` interface so the
 * legacy code path stays unchanged and test fixtures don't need updating.
 */
const failureByPath = new Map<string, FailureAnnotation>()

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** Read-only getter for InlineDiffController to surface the error banner. */
export function getDtFailureAnnotation(filePath: string): FailureAnnotation | undefined {
  return failureByPath.get(normalizePath(filePath))
}

/** Remove the annotation once the DT is rebased / retried / dismissed. */
export function clearDtFailureAnnotation(filePath: string): void {
  failureByPath.delete(normalizePath(filePath))
}

/**
 * Handle one DT snapshot → UI mapping step. Exported for tests; production code always
 * goes through `useDiffTxAuthoritativeSync`.
 */
export function applyDtToRendererState(tx: RendererDiffTransaction, opts: { mode: 'legacy' | 'dt' }): void {
  if (opts.mode !== 'dt') return // Inert in legacy mode.

  const pathKey = normalizePath(tx.filePath)
  const fileStore = useFileStore.getState()

  switch (tx.state) {
    case 'Pending':
    case 'Approved':
    case 'Writing':
      // In-flight: don't touch UI. Editor continues showing modifiedContent via
      // activePendingChange. Clear any stale failure from a previous attempt.
      failureByPath.delete(pathKey)
      return

    case 'Applied': {
      // Remove pending — the `file_change_applied` stream handler will authoritatively
      // set tab.content on disk content. If that event never fires (shouldn't happen in
      // DT mode because backend emits it synchronously right after successful write),
      // the UI just falls back to whatever tab.content currently is.
      failureByPath.delete(pathKey)
      const next = new Map(fileStore.pendingChanges)
      if (next.has(tx.filePath)) {
        next.delete(tx.filePath)
        fileStore.setPendingChanges(next)
      }
      return
    }

    case 'Rejected': {
      // User / hook denied. Remove pending; disk is unchanged so tab.content stays.
      failureByPath.delete(pathKey)
      const next = new Map(fileStore.pendingChanges)
      if (next.has(tx.filePath)) {
        next.delete(tx.filePath)
        fileStore.setPendingChanges(next)
      }
      return
    }

    case 'Failed': {
      // Backend refused the write (hash mismatch, integrity guard, lock timeout, ...).
      // Keep the diff visible so the user knows what was supposed to happen, and record
      // the failure reason so the toolbar can show an error banner.
      if (tx.error) {
        failureByPath.set(pathKey, {
          failedAt: tx.updatedAt,
          errorCode: tx.error.code,
          errorMessage: tx.error.message,
        })
      }
      // Bump pending to force a re-render so InlineDiffController re-reads the annotation.
      const next = new Map(fileStore.pendingChanges)
      const pending = next.get(tx.filePath)
      if (pending) {
        next.set(tx.filePath, { ...pending, timestamp: tx.updatedAt })
        fileStore.setPendingChanges(next)
      }
      return
    }

    case 'Stale': {
      // Placeholder for P3. Treat the same as Failed for now so the user is at least
      // informed. P3 wires up the real rebase affordance.
      failureByPath.set(pathKey, {
        failedAt: tx.updatedAt,
        errorCode: 'EXTERNAL_MODIFICATION',
        errorMessage: 'File changed externally since this diff was built.',
      })
      return
    }
  }
}

/**
 * Rescue scheduler: if a DT lingers in `Approved` / `Writing` longer than
 * DT_RESCUE_TIMEOUT_MS, we clean up the pendingChange the legacy way. This covers the
 * (rare) case where the DT bridge drops a terminal event — otherwise the diff would be
 * stuck on screen with no way to dismiss it.
 */
const rescueTimersByPath = new Map<string, ReturnType<typeof setTimeout>>()

function armRescueIfNeeded(tx: RendererDiffTransaction, mode: 'legacy' | 'dt'): void {
  if (mode !== 'dt') return
  const key = normalizePath(tx.filePath)
  if (tx.state === 'Approved' || tx.state === 'Writing') {
    if (rescueTimersByPath.has(key)) return // already armed
    const timer = setTimeout(() => {
      rescueTimersByPath.delete(key)
      // Re-check current state; if still in-flight, treat as abandoned.
      const latest = Array.from(useDiffTransactionStore.getState().transactionsById.values()).find(
        (t) => normalizePath(t.filePath) === key && t.id === tx.id,
      )
      if (latest && (latest.state === 'Approved' || latest.state === 'Writing')) {
        console.warn(
          `[DT-sync] Rescue timeout fired for ${tx.filePath} after ${DT_RESCUE_TIMEOUT_MS}ms. Falling back to legacy cleanup.`,
        )
        const fileStore = useFileStore.getState()
        const next = new Map(fileStore.pendingChanges)
        next.delete(tx.filePath)
        fileStore.setPendingChanges(next)
        failureByPath.set(key, {
          failedAt: Date.now(),
          errorCode: 'UNKNOWN',
          errorMessage:
            'The backend did not confirm the edit within the expected window. The change may or may not have been applied — please verify the file on disk.',
        })
      }
    }, DT_RESCUE_TIMEOUT_MS)
    rescueTimersByPath.set(key, timer)
  } else {
    // Terminal state reached → cancel any pending rescue.
    const t = rescueTimersByPath.get(key)
    if (t) {
      clearTimeout(t)
      rescueTimersByPath.delete(key)
    }
  }
}

/**
 * React hook — mount once at app root. Subscribes to the renderer DT mirror and drives
 * pendingChanges / tab.content according to `diffPrecisionMode`.
 *
 * Also emits Undo-toast side effects (P4c) when a DT transitions into `Applied`.
 */
export function useDiffTxAuthoritativeSync(): void {
  const mode = useSettingsStore((s) => s.diffPrecisionMode)
  const revision = useDiffTransactionStore((s) => s.revision)

  // Track which DT ids we've already emitted an Undo toast for, so a single `Applied`
  // transition produces exactly one toast even if the revision ticks multiple times for
  // the same underlying DT (rare but possible on rapid back-to-back broadcasts).
  const toastEmittedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    // Snapshot all DTs and apply them. Because `revision` bumps on every broadcast, this
    // effect re-runs on every DT event — simpler than maintaining our own subscription
    // plumbing at the cost of running applyDtToRendererState more often than strictly
    // necessary. The work per DT is O(1) and all state reads use getState() so there's no
    // re-render cascade.
    const all = useDiffTransactionStore.getState().transactionsById
    for (const tx of all.values()) {
      applyDtToRendererState(tx, { mode })
      armRescueIfNeeded(tx, mode)

      // Applied → Undo toast. Feature-gated on `dt` mode because legacy writes bypass the
      // atomicWriter + undoQueue pair, so offering Undo there would promise something the
      // backend cannot deliver.
      if (mode === 'dt' && tx.state === 'Applied' && !toastEmittedRef.current.has(tx.id)) {
        toastEmittedRef.current.add(tx.id)
        useUndoToastStore.getState().addFromApplied({
          id: tx.id,
          filePath: tx.filePath,
          proposedBytes: tx.proposed.content.length,
        })
      }
    }
  }, [mode, revision])
}

// ---------------------------------------------------------------------------
// DevTools kill-switch.
//
// Exposing a global mutator sounds scary, but the alternative — relying solely on the
// Settings UI toggle when a production-like bug shows up — is worse. In the worst case
// the user opens DevTools, types `__setDiffPrecisionMode('legacy')` and the whole DT
// path goes dormant until the next session.
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    __setDiffPrecisionMode?: (mode: 'legacy' | 'dt') => void
    __getDiffPrecisionMode?: () => 'legacy' | 'dt'
  }
}

export function installDiffPrecisionModeDevtoolsHook(): void {
  if (typeof window === 'undefined') return
  window.__setDiffPrecisionMode = (mode) => {
    useSettingsStore.getState().setDiffPrecisionMode(mode)
    console.info(`[DT-sync] diffPrecisionMode = ${mode}`)
  }
  window.__getDiffPrecisionMode = () => useSettingsStore.getState().diffPrecisionMode
}

/** Test-only teardown for the in-memory failure map + rescue timers. */
export function __resetDiffTxAuthoritativeSyncForTests(): void {
  failureByPath.clear()
  for (const t of rescueTimersByPath.values()) clearTimeout(t)
  rescueTimersByPath.clear()
}
