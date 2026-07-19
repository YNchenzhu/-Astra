/**
 * Bundle disk IO — atomic writes, target-path resolution, preset fork.
 *
 * Phase 2 Sprint 2a introduces the first write paths for the Bundle
 * system. The core rule is:
 *
 *   **Presets are immutable.** User edits to a preset-sourced bundle
 *   are written to the *user* tier with the same `meta.id`; because
 *   User tier has higher priority than Preset, the next registry
 *   reload surfaces the user copy as the effective bundle while the
 *   original preset file stays byte-identical on disk. Ship-updates
 *   can therefore replace presets without clobbering user edits.
 *
 * This module deliberately stays:
 *   - pure-data (no registry coupling — the registry calls us)
 *   - synchronous (small JSON files, atomic rename is fast, and the
 *     entire call happens in the main process so event loop impact
 *     is minimal); matches the existing `writeJsonFileAtomic` pattern.
 *   - filesystem-aware but path-policy-aware via `BundlePaths` only,
 *     so no hard-coded directories leak into callers.
 */

import path from 'node:path'
import type {
  Bundle,
  BundleMetadata,
  BundleSource,
} from './types'
import type { BundlePaths } from './paths'
import { writeJsonFileAtomic } from '../../fs/atomicWrite'

/** Writable tiers — preset is intentionally excluded. */
export type WritableTier = Extract<BundleSource, 'user' | 'project'>

export interface PersistBundleResult {
  /** The absolute path the bundle was written to. */
  filePath: string
  /** Which tier the write landed in. Differs from the input bundle's
   *  `meta.source` when a preset was forked into user. */
  tier: WritableTier
  /** The bundle as serialized (with `updatedAt`/`source` normalised
   *  to match the write target). Caller should replace its in-memory
   *  copy with this so renderer reads are consistent. */
  persisted: Bundle
}

/**
 * Compute a safe filesystem name for a bundle. We purposely keep this
 * deterministic (derived from `meta.id`) so:
 *   1. `bundleId ↔ filename` is 1:1 — no orphan files on rename.
 *   2. The same bundle id overlaid in multiple tiers lands in
 *      matching filenames, making tier priority transparent on disk.
 *
 * Allowed chars: `a-z 0-9 _ -`. Any other char collapses to `_`.
 * Empty inputs are rejected by the caller via `isBundleLike` earlier.
 */
export function bundleFileNameFor(id: string): string {
  const slug = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  // Defensive: an all-symbol id like "///" would collapse to empty.
  // Fall back to a hash-ish token so we still produce a valid name.
  const safe = slug.length > 0 ? slug : `bundle_${Date.now().toString(36)}`
  return `${safe}.json`
}

/**
 * Pick where to write a bundle's updates:
 *
 *   - `preset` source ⇒ fork to **user** tier.
 *   - `user` source   ⇒ stay in **user** tier.
 *   - `project` source ⇒ stay in **project** tier iff a project dir
 *     is configured; otherwise fall back to user (prevents data loss
 *     when the workspace is closed mid-edit).
 *   - `imported` source ⇒ land in user tier.
 */
export function resolveWriteTarget(
  bundle: Bundle,
  paths: BundlePaths,
): { filePath: string; tier: WritableTier } {
  const filename = bundleFileNameFor(bundle.meta.id)
  if (bundle.meta.source === 'project' && paths.projectDir) {
    return { filePath: path.join(paths.projectDir, filename), tier: 'project' }
  }
  return { filePath: path.join(paths.userDir, filename), tier: 'user' }
}

/**
 * Persist a Bundle to disk. Performs:
 *   1. Resolve target path via `resolveWriteTarget` (auto-forks presets).
 *   2. Update `meta.updatedAt` + ensure `meta.source` matches target.
 *   3. Atomic write.
 *
 * Does NOT mutate the input object — callers receive a new Bundle
 * via `persisted` they should install into the registry.
 *
 * Throws on IO failure; callers in IPC handlers convert to JSON error
 * responses via the existing `validatedHandle` error path.
 */
export function persistBundle(
  bundle: Bundle,
  paths: BundlePaths,
): PersistBundleResult {
  const { filePath, tier } = resolveWriteTarget(bundle, paths)

  const nextMeta: BundleMetadata = {
    ...bundle.meta,
    updatedAt: Date.now(),
    source: tier,
  }
  const persisted: Bundle = {
    ...bundle,
    meta: nextMeta,
  }

  writeJsonFileAtomic(filePath, persisted)

  return { filePath, tier, persisted }
}
