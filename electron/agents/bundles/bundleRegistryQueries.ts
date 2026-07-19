/**
 * Bundle registry queries — loading, listing, activation.
 */

import type { App } from 'electron'
import type { Bundle, BundleSource } from './types'
import { CODE_DEV_BUNDLE_ID } from './types'
import { getBundlePaths, listBundleJsonFiles } from './paths'
import { loadBundleFromFile, type LoadBundleResult } from './bundleSerialize'
import { persistBundle } from './bundleIO'
import { state, emitActiveChange } from './bundleRegistryState'
import { maybeUpgradeLegacyPlaceholder } from './bundleRegistryPlaceholders'

/**
 * Discover and load bundles from the three tiers. Later tiers override
 * earlier ones on id collision (Project > User > Preset). Returns a
 * summary of what got loaded / rejected.
 */
export function reloadBundles(app: App, workspacePath?: string | null): {
  loaded: Bundle[]
  errors: Array<{ filePath: string; error: string }>
} {
  const paths = getBundlePaths(app, workspacePath)
  state.paths = paths

  const newEntries = new Map<string, { bundle: Bundle; filePath: string; tier: BundleSource }>()
  const errors: Array<{ filePath: string; error: string }> = []

  // Order: preset → user → project. Later writes win.
  const tiers: Array<{ dir: string | undefined; tier: BundleSource }> = [
    { dir: paths.presetDir, tier: 'preset' },
    { dir: paths.userDir, tier: 'user' },
    { dir: paths.projectDir, tier: 'project' },
  ]

  for (const { dir, tier } of tiers) {
    const files = listBundleJsonFiles(dir)
    for (const filePath of files) {
      const result: LoadBundleResult = loadBundleFromFile(filePath, tier)
      if (!result.ok) {
        errors.push({ filePath: result.source, error: result.error })
        continue
      }
      // 就地升级老版占位 prompt。只对可写 tier(user / project)回写
      // 磁盘;preset tier 改内存态就行,避免污染 repo 里的 preset JSON。
      const upgraded = maybeUpgradeLegacyPlaceholder(result.bundle)
      if (upgraded && (tier === 'user' || tier === 'project')) {
        try {
          const writeRes = persistBundle(result.bundle, paths)
          if (writeRes.persisted) {
            result.bundle.meta = writeRes.persisted.meta
          }
        } catch (e) {
          console.warn(
            `[bundleRegistry] placeholder upgrade persist failed for "${result.bundle.meta.id}":`,
            e,
          )
        }
      }
      newEntries.set(result.bundle.meta.id, {
        bundle: result.bundle,
        filePath: result.source,
        tier,
      })
    }
  }

  state.entries = newEntries
  state.loadErrors = errors

  return {
    loaded: Array.from(newEntries.values()).map((e) => e.bundle),
    errors,
  }
}

// ─── Queries ─────────────────────────────────────────────────────────

/** Return all currently-loaded bundles (post-merge). Safe to call
 *  before `reloadBundles` — returns empty array. */
export function listBundles(): Bundle[] {
  return Array.from(state.entries.values()).map((e) => e.bundle)
}

/** Get a loaded bundle by id, or `undefined` if not present. */
export function getBundle(id: string): Bundle | undefined {
  return state.entries.get(id)?.bundle
}

/** Get the file path a bundle was loaded from (useful for "Reveal in
 *  Explorer" and save-back). */
export function getBundleSourcePath(id: string): string | undefined {
  return state.entries.get(id)?.filePath
}

/** Return the latest load errors so the UI can surface them. */
export function getLoadErrors(): Array<{ filePath: string; error: string }> {
  return state.loadErrors.slice()
}

/** Return the currently active bundle, or `undefined` before activation. */
export function getActiveBundle(): Bundle | undefined {
  if (!state.activeId) return undefined
  return state.entries.get(state.activeId)?.bundle
}

/** Return the currently active bundle id, or `undefined`. */
export function getActiveBundleId(): string | undefined {
  return state.activeId
}

// ─── Activation ──────────────────────────────────────────────────────

/**
 * Activate a bundle by id. Notifies listeners. Returns the newly active
 * bundle, or throws when the id is unknown.
 *
 * No-op when `id` is already active (no listener spam).
 */
export function activateBundle(id: string): Bundle {
  const entry = state.entries.get(id)
  if (!entry) {
    throw new Error(`[bundleRegistry] Cannot activate: bundle "${id}" not found`)
  }
  if (state.activeId === id) {
    return entry.bundle
  }
  const previous = getActiveBundle()
  state.activeId = id
  emitActiveChange(entry.bundle, previous)
  return entry.bundle
}

/**
 * Pick the best bundle to activate given an optional preferred id.
 * Resolution order:
 *   1. `preferredId` if loaded
 *   2. `CODE_DEV_BUNDLE_ID` if loaded (matches the migration default)
 *   3. First bundle in iteration order
 *   4. undefined — no bundles available
 */
export function resolveInitialActiveBundleId(preferredId?: string | null): string | undefined {
  if (preferredId && state.entries.has(preferredId)) return preferredId
  if (state.entries.has(CODE_DEV_BUNDLE_ID)) return CODE_DEV_BUNDLE_ID
  const first = state.entries.keys().next()
  return first.done ? undefined : first.value
}

/** Convenience: reload then activate using the resolved id. */
export function reloadAndActivate(
  app: App,
  workspacePath: string | null | undefined,
  preferredId?: string | null,
): Bundle | undefined {
  reloadBundles(app, workspacePath)
  const id = resolveInitialActiveBundleId(preferredId)
  if (!id) return undefined
  return activateBundle(id)
}
