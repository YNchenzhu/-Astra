/**
 * Bundle registry lifecycle — create, delete, import, export.
 */

import type { App } from 'electron'
import type { Bundle } from './types'
import fs from 'node:fs'
import { getBundlePaths } from './paths'
import { normalizeBundle, parseBundle, validateBundleSemantics } from './bundleSerialize'
import { persistBundle, resolveWriteTarget } from './bundleIO'
import { state, emitBundleChange } from './bundleRegistryState'
import { activateBundle, resolveInitialActiveBundleId } from './bundleRegistryQueries'
import { makePlaceholderAgent } from './bundleRegistryPlaceholders'

// ─── Mutation: create a new bundle ───────────────────────────────────

export interface CreateBundleParams {
  /** Proposed bundle id — normalized to `[a-z0-9_-]+`. Must not collide
   *  with an existing bundle. */
  id: string
  /** Human-readable name. Falls back to `id` when missing. */
  name?: string
  /** Optional one-liner description. */
  description?: string
  /** Optional domain tag (e.g. "编程", "法律"). */
  domain?: string
  /** Optional author string. */
  author?: string
  /** When set, deep-clone this bundle's agents/teams/capabilities/
   *  layout/etc. into the new one. When unset, a minimal bundle with
   *  a single placeholder "assistant" agent is created. */
  copyFromId?: string
}

export function createBundle(
  params: CreateBundleParams,
  app: App,
  workspacePath?: string | undefined | null,
): Bundle {
  const paths = getBundlePaths(app, workspacePath ?? undefined)
  state.paths = paths

  const idRaw = (params.id ?? '').trim().toLowerCase()
  const id = idRaw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (id.length === 0) {
    throw new Error('[bundleRegistry] Cannot create: bundle id is empty')
  }
  if (state.entries.has(id)) {
    throw new Error(`[bundleRegistry] Cannot create: bundle id "${id}" already exists`)
  }

  const now = Date.now()
  const seed: Bundle = params.copyFromId
    ? (() => {
        const src = state.entries.get(params.copyFromId)
        if (!src) {
          throw new Error(
            `[bundleRegistry] Cannot copy: source bundle "${params.copyFromId}" not found`,
          )
        }
        // Structured clone via JSON — bundles are all POJO, no funcs.
        const cloned: Bundle = JSON.parse(JSON.stringify(src.bundle))
        cloned.meta = {
          ...cloned.meta,
          id,
          name: params.name?.trim() || `${src.bundle.meta.name} (副本)`,
          description: params.description?.trim() || src.bundle.meta.description,
          domain: params.domain?.trim() || src.bundle.meta.domain,
          author: params.author?.trim() || src.bundle.meta.author,
          version: '0.0.1',
          createdAt: now,
          updatedAt: now,
          source: 'user',
        }
        return cloned
      })()
    : (() => {
        const meta = {
          id,
          name: params.name?.trim() || id,
          description: params.description?.trim() ?? '',
          domain: params.domain?.trim(),
          author: params.author?.trim(),
          version: '0.0.1' as const,
          createdAt: now,
          updatedAt: now,
          source: 'user' as const,
        }
        return {
          meta,
          agents: [
            makePlaceholderAgent({
              name: meta.name,
              domain: meta.domain,
              description: meta.description,
            }),
          ],
          teams: [],
          defaultAgent: 'assistant',
          capabilities: {
            enabledTools: '*' as const,
            enabledSkills: [],
            enabledMcpServers: [],
          },
          layout: { type: 'chat-centric' as const },
        }
      })()

  // Always land new bundles in the user tier (creating in project tier
  // would require an explicit workspace switch; we'll add that in a
  // future Sprint together with "export to workspace").
  const normalized = normalizeBundle(seed, 'user')
  const semanticError = validateBundleSemantics(normalized)
  if (semanticError !== null) {
    throw new Error(`[bundleRegistry] Create rejected: ${semanticError}`)
  }

  // Force write into user tier regardless of source field; we've set
  // it to 'user' above but re-resolve defensively.
  const target = resolveWriteTarget(normalized, paths)
  const { filePath, tier, persisted } = persistBundle(normalized, paths)

  state.entries.set(id, { bundle: persisted, filePath, tier })

  emitBundleChange(persisted, {
    reason: 'fork',
    previousTier: 'user',
    nextTier: tier,
    filePath,
  })
  // Intentionally don't activate — the renderer decides whether to
  // switch to the new bundle after creation.
  // `target` is read above to trigger path-policy (and to satisfy the
  // linter if strict-no-unused-vars ever tightens).
  void target
  return persisted
}

// ─── Mutation: delete a bundle ───────────────────────────────────────

export interface DeleteBundleOutcome {
  /** Whether the disk file was actually removed. Preset-tier bundles
   *  return false (we never delete shipped files). */
  deletedOnDisk: boolean
  /** If the deleted bundle was the active one, this is the bundle
   *  we auto-switched to (or null when there's nothing else loaded). */
  newActive: Bundle | null
}

export function deleteBundle(
  bundleId: string,
  app: App,
  workspacePath?: string | undefined | null,
): DeleteBundleOutcome {
  const entry = state.entries.get(bundleId)
  if (!entry) {
    throw new Error(`[bundleRegistry] Cannot delete: bundle "${bundleId}" not found`)
  }
  if (entry.tier === 'preset') {
    throw new Error(
      `[bundleRegistry] Cannot delete: bundle "${bundleId}" is a built-in preset (内置工作包不可删除)`,
    )
  }

  // Drop from memory first so listeners see a consistent state.
  const wasActive = state.activeId === bundleId
  state.entries.delete(bundleId)

  // If this was the active bundle, pick a fallback. Prefer code-dev,
  // otherwise any remaining bundle, otherwise leave unset.
  let newActive: Bundle | null = null
  if (wasActive) {
    const nextId = resolveInitialActiveBundleId(undefined)
    if (nextId) {
      try {
        newActive = activateBundle(nextId)
      } catch (err) {
        console.warn('[bundleRegistry] auto-activate after delete failed:', err)
      }
    } else {
      state.activeId = undefined
    }
  }

  // Try to remove the disk file. A failure here is non-fatal — the
  // bundle is already gone from memory; at worst the next `reload`
  // will re-ingest the file. We log and move on.
  let deletedOnDisk = false
  try {
    if (fs.existsSync(entry.filePath)) {
      fs.unlinkSync(entry.filePath)
      deletedOnDisk = true
    }
  } catch (err) {
    console.warn(`[bundleRegistry] Failed to unlink ${entry.filePath}:`, err)
  }

  // Refresh paths cache (workspace may have changed).
  state.paths = getBundlePaths(app, workspacePath ?? undefined)

  return { deletedOnDisk, newActive }
}

/** Return a JSON-serializable snapshot of a bundle suitable for export.
 *  Writes no files — IPC layer handles the actual `dialog.showSaveDialog`
 *  + `fs.writeFileSync` round-trip. Returns null when the id is unknown. */
export function snapshotBundleForExport(bundleId: string): Bundle | null {
  const entry = state.entries.get(bundleId)
  if (!entry) return null
  // Return the bundle as-is. Receivers can write it to disk verbatim;
  // normalizeBundle on re-load handles any forward-compat quirks.
  return entry.bundle
}

// ─── Mutation: import a bundle from external JSON text ──────────────

export type ImportBundleOutcome =
  | { ok: true; bundle: Bundle; usedId: string; replaced: boolean }
  | {
      ok: false
      /** Discriminant — lets the caller branch on "retry with newId /
       *  replace" vs "show error toast and stop". */
      reason: 'parse-error' | 'id-conflict' | 'preset-conflict' | 'write-error'
      error: string
      /** Only set when reason === 'id-conflict'; a suggested non-colliding id
       *  the caller can offer the user. */
      suggestedId?: string
      /** The parsed bundle's original id (pre-rename) — useful for error text. */
      attemptedId?: string
    }

export interface ImportBundleOptions {
  /** Rename the bundle to this id on write. Caller-supplied when the
   *  user resolved a conflict by picking a new id. */
  newId?: string
  /** When true and `newId` is unset, replace an existing user/project
   *  bundle with the same id. Preset-tier collisions are ALWAYS
   *  rejected (`preset-conflict`). */
  replaceExisting?: boolean
}

/**
 * Import a bundle from raw JSON text. Three failure modes are
 * distinguished so the UI can respond appropriately:
 *   - `parse-error`   → malformed JSON / invalid shape; no retry helps
 *   - `preset-conflict` → id matches a preset; suggest user pick a
 *     new id (never overwrite preset)
 *   - `id-conflict`   → id matches a user/project bundle; UI may
 *     prompt "use suggested id / replace / cancel"
 *   - `write-error`   → disk write failed after validation; rare
 *
 * Success returns the freshly-loaded Bundle. `replaced=true` indicates
 * an existing bundle was deleted to make room.
 */
export function importBundleFromJson(
  raw: string,
  sourceLabel: string,
  app: App,
  workspacePath: string | undefined | null,
  options: ImportBundleOptions = {},
): ImportBundleOutcome {
  const parseResult = parseBundle(raw, sourceLabel, 'imported')
  if (!parseResult.ok) {
    return { ok: false, reason: 'parse-error', error: parseResult.error }
  }

  const parsedBundle = parseResult.bundle
  const originalId = parsedBundle.meta.id
  const targetId = options.newId?.trim() || originalId

  // Conflict detection against the current loaded set.
  const existing = state.entries.get(targetId)
  if (existing) {
    if (existing.tier === 'preset') {
      return {
        ok: false,
        reason: 'preset-conflict',
        error: `工作包 ID "${targetId}" 与内置工作包冲突,内置工作包不可覆盖。请导入时使用不同的 ID。`,
        attemptedId: targetId,
        suggestedId: suggestNonConflictingId(targetId),
      }
    }
    if (!options.replaceExisting && !options.newId) {
      return {
        ok: false,
        reason: 'id-conflict',
        error: `工作包 ID "${targetId}" 已存在。`,
        attemptedId: targetId,
        suggestedId: suggestNonConflictingId(targetId),
      }
    }
    if (options.replaceExisting && !options.newId) {
      // Delete the existing one first so persistBundle can land fresh
      // content at the same path. Safe because we're on user/project tier.
      try {
        deleteBundle(targetId, app, workspacePath)
      } catch (err) {
        return {
          ok: false,
          reason: 'write-error',
          error: `覆盖旧工作包失败:${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
  }

  // Apply targetId + force source to 'user' (imports always land in user
  // tier; project-tier imports would need a dedicated UX for workspace
  // opt-in, we skip for now).
  const adjusted: Bundle = {
    ...parsedBundle,
    meta: {
      ...parsedBundle.meta,
      id: targetId,
      source: 'user',
      updatedAt: Date.now(),
    },
  }

  // Re-normalize + validate with the new tier so normalizeBundle can
  // stamp source and fix inconsistencies.
  const normalized = normalizeBundle(adjusted, 'user')
  const semanticError = validateBundleSemantics(normalized)
  if (semanticError !== null) {
    return { ok: false, reason: 'parse-error', error: `导入内容校验失败:${semanticError}` }
  }

  const paths = getBundlePaths(app, workspacePath ?? undefined)
  state.paths = paths

  let result
  try {
    result = persistBundle(normalized, paths)
  } catch (err) {
    return {
      ok: false,
      reason: 'write-error',
      error: `写入磁盘失败:${err instanceof Error ? err.message : String(err)}`,
    }
  }

  state.entries.set(targetId, {
    bundle: result.persisted,
    filePath: result.filePath,
    tier: result.tier,
  })

  emitBundleChange(result.persisted, {
    reason: 'fork',
    previousTier: 'imported',
    nextTier: result.tier,
    filePath: result.filePath,
  })

  return {
    ok: true,
    bundle: result.persisted,
    usedId: targetId,
    replaced: !!existing && !options.newId,
  }
}

/** Suggest an id that doesn't conflict with any loaded bundle by
 *  appending `-imported`, `-imported-2`, etc. until free. */
function suggestNonConflictingId(base: string): string {
  const root = `${base.replace(/-imported(-\d+)?$/, '')}-imported`
  if (!state.entries.has(root)) return root
  let n = 2
  while (state.entries.has(`${root}-${n}`)) n++
  return `${root}-${n}`
}
