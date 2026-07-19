/**
 * Single source of truth for IPC file/shell sandboxing: paths must stay under opened workspace roots.
 * Synced from {@link setWorkspacePath} in workspaceState (primary root today; array-ready for multi-root).
 */

import path from 'node:path'
import { resolveWithDriftFallback } from '../utils/charDriftCanonical'

let roots: string[] = []

export function setSecurityWorkspaceRoots(next: string[]): void {
  roots = [
    ...new Set(
      next
        .map((p) => path.resolve(String(p).trim()))
        .filter((p) => p.length > 0),
    ),
  ]
}

export function getSecurityWorkspaceRoots(): string[] {
  return [...roots]
}

export function hasSecurityWorkspaceRoot(): boolean {
  return roots.length > 0
}

export function pathWithinAnyRoot(resolvedAbs: string): boolean {
  const norm = normalizePath(resolvedAbs)
  for (const r of roots) {
    const root = normalizePath(path.resolve(r))
    const prefix = root.endsWith('/') ? root : `${root}/`
    if (norm === root || norm.startsWith(prefix)) return true
  }
  return false
}

function normalizePath(p: string): string {
  return path.resolve(p).toLowerCase().replace(/\\/g, '/')
}

/**
 * Resolve a path for FS IPC: absolute or relative to primary workspace root.
 *
 * Applies the LLM character-drift fallback so a renderer-side IPC call (file
 * tree click, Open File menu, drag-drop) that round-trips through a string
 * the model just emitted still hits the right on-disk entry when the model
 * drifted curly quotes / fullwidth CJK punctuation. The boundary check is
 * performed AFTER drift resolution because drift fallback only ever
 * substitutes a sibling already inside the same parent directory — the
 * resolved path can never escape the workspace as a side-effect.
 */
export function resolvePathForWorkspaceAccess(
  filePath: string,
): { ok: true; resolved: string } | { ok: false; reason: string } {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { ok: false, reason: 'Path is empty.' }
  }
  if (roots.length === 0) {
    return {
      ok: false,
      reason: 'No workspace folder is open. Open a folder before using file operations.',
    }
  }
  const primary = roots[0]!
  const trimmed = filePath.trim()
  const resolvedRaw = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(primary, trimmed)
  const resolved = resolveWithDriftFallback(resolvedRaw) ?? resolvedRaw
  if (!pathWithinAnyRoot(resolved)) {
    return { ok: false, reason: 'Path is outside the opened workspace.' }
  }
  return { ok: true, resolved }
}

/** Default cwd for terminal when workspace is open */
export function getPrimaryWorkspaceRoot(): string | null {
  return roots[0] ?? null
}
