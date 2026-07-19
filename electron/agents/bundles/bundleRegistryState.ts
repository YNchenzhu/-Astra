/**
 * Bundle registry — internal state and listener infrastructure.
 *
 * This module must remain side-effect free at import time so main.ts
 * can mount it lazily.
 */

import type { Bundle, BundleSource } from './types'

// ─── Internal state ──────────────────────────────────────────────────

interface InternalEntry {
  bundle: Bundle
  filePath: string
  tier: BundleSource
}

interface RegistryState {
  /** Loaded bundles, keyed by `meta.id` after tier-priority merge. */
  entries: Map<string, InternalEntry>
  /** Errors from the latest reload, for surfacing in UI. */
  loadErrors: Array<{ filePath: string; error: string }>
  /** Currently active bundle id (undefined = none activated yet). */
  activeId: string | undefined
  /** Paths used by the latest reload — cached for `reload()` without arg. */
  paths: import('./paths').BundlePaths | undefined
}

export const state: RegistryState = {
  entries: new Map(),
  loadErrors: [],
  activeId: undefined,
  paths: undefined,
}

// ─── Listeners ───────────────────────────────────────────────────────

type ActiveChangeListener = (bundle: Bundle | undefined, previous: Bundle | undefined) => void
const activeListeners = new Set<ActiveChangeListener>()

/** Register a callback for activation changes. Returns an unsubscribe fn. */
export function onActiveBundleChange(listener: ActiveChangeListener): () => void {
  activeListeners.add(listener)
  return () => {
    activeListeners.delete(listener)
  }
}

export function emitActiveChange(next: Bundle | undefined, previous: Bundle | undefined): void {
  for (const listener of activeListeners) {
    try {
      listener(next, previous)
    } catch (e) {
      console.error('[bundleRegistry] listener threw:', e)
    }
  }
}

/**
 * Mutation listeners — fired on any in-memory bundle change (save /
 * fork / future: delete / create). Separate from activation listeners
 * because the active bundle set may not change even when a loaded
 * bundle is re-written (e.g. editing a non-active bundle's agent).
 */
type BundleChangeReason = 'agent-saved' | 'fork' | 'reload'
type BundleChangeListener = (
  bundle: Bundle,
  info: {
    reason: BundleChangeReason
    /** Previous tier — different from next tier on preset → user fork. */
    previousTier: BundleSource
    nextTier: BundleSource
    filePath: string
  },
) => void

const changeListeners = new Set<BundleChangeListener>()

/** Register a listener for bundle content mutations. */
export function onBundleChange(listener: BundleChangeListener): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

export function emitBundleChange(
  bundle: Bundle,
  info: {
    reason: BundleChangeReason
    previousTier: BundleSource
    nextTier: BundleSource
    filePath: string
  },
): void {
  for (const listener of changeListeners) {
    try {
      listener(bundle, info)
    } catch (e) {
      console.error('[bundleRegistry] change listener threw:', e)
    }
  }
}

// ─── Test helpers ────────────────────────────────────────────────────

/**
 * Reset the registry — exposed for test harnesses only. Not invoked by
 * production code paths; prod uses `reloadBundles` to refresh.
 */
export function __resetBundleRegistryForTests(): void {
  state.entries.clear()
  state.loadErrors = []
  state.activeId = undefined
  state.paths = undefined
  activeListeners.clear()
  changeListeners.clear()
}
