/**
 * Bundle runtime registry — the single source of truth for:
 *
 *   - Which bundles are known to the app right now (preset + user + project)
 *   - Which bundle is currently active
 *   - Subscribers to activation changes
 *
 * Deliberately keeps zero coupling to the agent orchestration layer:
 * the registry is a pure data hub. Agent/tool/session integration is
 * done by higher layers reading from here (IPC, stores, middleware)
 * via `onActiveBundleChange`.
 *
 * Merge semantics (Plan §4.5.10.3):
 *   When the same `meta.id` appears in multiple tiers, Project > User
 *   > Preset. Losing tiers are dropped completely — no field-level
 *   merging (keeps the data model simple; users who want partial
 *   overrides can copy-then-edit via the Workbench).
 *
 * This module must remain side-effect free at import time so main.ts
 * can mount it lazily.
 */

// State & listeners
export { state, onActiveBundleChange, onBundleChange, emitActiveChange, emitBundleChange, __resetBundleRegistryForTests } from './bundleRegistryState'

// Queries & activation
export {
  reloadBundles,
  listBundles,
  getBundle,
  getBundleSourcePath,
  getLoadErrors,
  getActiveBundle,
  getActiveBundleId,
  activateBundle,
  resolveInitialActiveBundleId,
  reloadAndActivate,
} from './bundleRegistryQueries'

// Mutations
export {
  saveAgentEntry,
  saveTeamEntry,
  saveBundleMeta,
  addAgent,
  removeAgent,
  addTeam,
  removeTeam,
} from './bundleRegistryMutations'
export type { AddAgentSeed, AddTeamSeed } from './bundleRegistryMutations'

// Lifecycle
export {
  createBundle,
  deleteBundle,
  snapshotBundleForExport,
  importBundleFromJson,
} from './bundleRegistryLifecycle'
export type { CreateBundleParams, DeleteBundleOutcome, ImportBundleOutcome, ImportBundleOptions } from './bundleRegistryLifecycle'
