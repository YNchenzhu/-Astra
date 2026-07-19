/**
 * Bundle storage path resolution.
 *
 * Three tiers, searched in ascending priority (later overrides earlier):
 *
 *   1. Preset    : read-only, ships with the app. Source of truth for
 *                  built-in bundles (`code-dev`, `notes`, …).
 *   2. User      : per-user writable. User-created / imported bundles
 *                  live here. Follows the same `星构Astra-data` root
 *                  that memory/cache/logs use (see `bundleDataPaths.ts`).
 *   3. Project   : per-workspace — lets teams check Bundle JSONs into
 *                  the repo so every clone picks them up automatically.
 *
 * When the same bundle id appears in multiple tiers, Project > User >
 * Preset — so a workspace can tailor a preset without modifying it.
 *
 * Dev vs packaged preset location:
 *   - Dev: read from `<appPath>/electron/agents/bundles/presets/`.
 *     This lets developers iterate on preset JSON without rebuilding.
 *   - Packaged: `electron-builder` copies `electron/agents/bundles/presets/`
 *     into `<resourcesPath>/bundles-presets/` via `extraResources` (see
 *     build config; added alongside this file). We try both locations
 *     to stay forgiving if the packaging path shifts.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { App } from 'electron'
import { getBundleDataRoot } from '../../paths/bundleDataPaths'

export interface BundlePaths {
  /** Read-only preset directory (ships with app). */
  presetDir: string
  /** Writable user-level bundles directory. */
  userDir: string
  /** Workspace-level bundles directory, undefined when no workspace. */
  projectDir: string | undefined
}

const USER_BUNDLES_DIRNAME = 'bundles'
const PROJECT_BUNDLES_DIRNAME = path.join('.astra', 'bundles')
const PACKAGED_PRESETS_DIRNAME = 'bundles-presets'

/** Resolve the preset directory based on dev vs packaged layout. */
function resolvePresetDir(app: App): string {
  // In dev we run straight off the repo; appPath is the repo root.
  // The source file for presets lives next to this module.
  const devPath = path.join(app.getAppPath(), 'electron', 'agents', 'bundles', 'presets')
  if (fs.existsSync(devPath)) return devPath

  // Packaged: prefer `extraResources` location.
  // `process.resourcesPath` is defined at runtime in packaged builds.
  const resourcesPath =
    typeof process !== 'undefined' && typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === 'string'
      ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      : undefined

  if (resourcesPath) {
    const packedPath = path.join(resourcesPath, PACKAGED_PRESETS_DIRNAME)
    if (fs.existsSync(packedPath)) return packedPath
  }

  // Last-ditch fallback: appPath-relative (may not exist in packaged bundle,
  // but returning the dev path keeps error messages debuggable).
  return devPath
}

/** Resolve the user-level bundles directory, creating it if needed. */
function resolveUserDir(app: App): string {
  const root = getBundleDataRoot(app)
  const dir = path.join(root, USER_BUNDLES_DIRNAME)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* non-fatal: first write will retry / surface the real error */
  }
  return dir
}

/** Resolve the project-level bundles directory for the given workspace,
 *  or `undefined` when the app is not opened against a workspace. */
function resolveProjectDir(workspacePath: string | undefined | null): string | undefined {
  if (!workspacePath || typeof workspacePath !== 'string') return undefined
  const trimmed = workspacePath.trim()
  if (trimmed.length === 0) return undefined
  return path.join(trimmed, PROJECT_BUNDLES_DIRNAME)
}

/**
 * Compute all three bundle directories for the current runtime.
 * Does NOT create the project dir (we read from it lazily; creating it
 * unsolicited would leave untracked directories in user repos).
 */
export function getBundlePaths(app: App, workspacePath?: string | undefined | null): BundlePaths {
  return {
    presetDir: resolvePresetDir(app),
    userDir: resolveUserDir(app),
    projectDir: resolveProjectDir(workspacePath ?? undefined),
  }
}

/** Enumerate *.json files inside a bundle directory, returning absolute
 *  paths. Returns [] for missing / non-readable directories so callers
 *  don't need per-tier existence checks. */
export function listBundleJsonFiles(dir: string | undefined): string[] {
  if (!dir) return []
  try {
    if (!fs.existsSync(dir)) return []
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const out: string[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.toLowerCase().endsWith('.json')) continue
      out.push(path.join(dir, entry.name))
    }
    return out
  } catch {
    return []
  }
}

/** Human-friendly tier label for debugging / UI. */
export type BundleTier = 'preset' | 'user' | 'project'

/** Classify a bundle file path back to its originating tier. */
export function classifyBundlePath(
  filePath: string,
  paths: BundlePaths,
): BundleTier | undefined {
  const normalized = path.normalize(filePath)
  if (normalized.startsWith(path.normalize(paths.presetDir))) return 'preset'
  if (normalized.startsWith(path.normalize(paths.userDir))) return 'user'
  if (paths.projectDir && normalized.startsWith(path.normalize(paths.projectDir))) return 'project'
  return undefined
}
