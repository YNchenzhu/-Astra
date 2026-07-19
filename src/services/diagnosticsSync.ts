/**
 * Renderer-side mirror of the main-process DiagnosticsHub.
 *
 * Boot sequence:
 *   1. `getSnapshot()` — primes `useDiagnosticStore` with current authoritative state.
 *   2. `onPatch(...)` — applies per-URI patches to keep the mirror live.
 *
 * Resilience:
 *   - If a patch reports a revision equal to / behind the mirror's revision we
 *     request a fresh snapshot (treats as "gap") — this also covers the case
 *     where main restarted and its revision counter reset to 0.
 *   - Subscription is idempotent: `initDiagnosticsSync()` may be called multiple
 *     times; only the first call actually subscribes, subsequent calls are no-ops.
 */

import { useDiagnosticStore } from '../stores/useDiagnosticStore'
import type { DiagnosticsHubPatch, DiagnosticsHubSnapshot } from '../types'

let initialized = false
let unsubscribePatch: (() => void) | undefined
let resyncPending = false

/**
 * Patch coalescing. During LSP pre-warm of a large workspace the Hub emits a
 * dense burst of patches; applying each one individually re-copied the whole
 * mirror map and re-flattened every diagnostic (O(total) per patch), which
 * showed up as a visible renderer stall right after opening a folder. We
 * buffer arrivals for a short window and flush them through
 * `applyPatches(...)` — one map copy + one flatten + one store update per
 * window. 60ms is imperceptible for the Problems panel / squigglies while
 * collapsing a pre-warm burst into a handful of applications.
 */
const PATCH_COALESCE_MS = 60
let pendingPatches: DiagnosticsHubPatch[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flushPendingPatches(): void {
  flushTimer = null
  if (pendingPatches.length === 0) return
  const batch = pendingPatches
  pendingPatches = []
  const result = useDiagnosticStore.getState().applyPatches(batch)
  if (result === 'gap') {
    void ensureSnapshotAfterGap()
  }
}

function enqueuePatch(patch: DiagnosticsHubPatch): void {
  pendingPatches.push(patch)
  if (flushTimer === null) {
    flushTimer = setTimeout(flushPendingPatches, PATCH_COALESCE_MS)
  }
}

function dropPendingPatches(): void {
  pendingPatches = []
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

async function pullSnapshot(): Promise<boolean> {
  const api = window.electronAPI?.diagnostics
  if (!api?.getSnapshot) return false
  try {
    const snapshot = (await api.getSnapshot()) as DiagnosticsHubSnapshot
    // The snapshot supersedes anything sitting in the coalescing buffer —
    // applying stale buffered patches after it would only trigger another
    // spurious gap→resync round-trip.
    dropPendingPatches()
    useDiagnosticStore.getState().applySnapshot(snapshot)
    return true
  } catch (err) {
    console.warn('[diagnosticsSync] snapshot fetch failed:', (err as Error).message)
    return false
  }
}

async function ensureSnapshotAfterGap(): Promise<void> {
  if (resyncPending) return
  resyncPending = true
  try {
    // Small back-off so a burst of stale patches collapses into one resync.
    await new Promise((r) => setTimeout(r, 80))
    await pullSnapshot()
  } finally {
    resyncPending = false
  }
}

export async function initDiagnosticsSync(): Promise<void> {
  if (initialized) return
  const api = window.electronAPI?.diagnostics
  if (!api?.getSnapshot || !api?.onPatch) {
    console.info('[diagnosticsSync] main-process diagnostics bridge unavailable')
    return
  }
  initialized = true

  await pullSnapshot()

  unsubscribePatch = api.onPatch((patch: DiagnosticsHubPatch) => {
    enqueuePatch(patch)
  })
}

/** Full resync — used when the workspace switches or on demand. */
export async function refreshDiagnosticsSync(): Promise<void> {
  if (!initialized) {
    await initDiagnosticsSync()
    return
  }
  await pullSnapshot()
}

export function disposeDiagnosticsSync(): void {
  if (unsubscribePatch) {
    unsubscribePatch()
    unsubscribePatch = undefined
  }
  dropPendingPatches()
  initialized = false
}
