import {
  RECENT_PROJECTS_CHANGED_EVENT,
  RECENT_PROJECTS_MAX_ENTRIES,
  RECENT_PROJECTS_STORAGE_KEY,
} from '../constants/recentProjects'
import { queueMirrorRendererPrefsToDisk } from './rendererPrefsSync'

/** Normalize so the same folder is not listed twice (e.g. `G:\a` vs `G:/a`). */
export function normalizeRecentProjectPath(p: string): string {
  return p.trim().replace(/\\/g, '/')
}

export function readRecentProjectsFromStorage(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY)
    return stored ? (JSON.parse(stored) as string[]) : []
  } catch {
    return []
  }
}

function notifyRecentProjectsChanged(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  window.dispatchEvent(new CustomEvent(RECENT_PROJECTS_CHANGED_EVENT))
}

/**
 * Keeps `recentProjects` in localStorage aligned with the active workspace root.
 * Call when `rootPath` changes (open, switch, or close). Same-tab listeners use
 * {@link RECENT_PROJECTS_CHANGED_EVENT}; other tabs use `storage`.
 */
export function syncRecentProjectsWithWorkspaceRoot(rootPath: string | null): void {
  const recent = readRecentProjectsFromStorage()
  if (rootPath) {
    const norm = normalizeRecentProjectPath(rootPath)
    if (!norm) {
      notifyRecentProjectsChanged()
      return
    }
    const normalizedExisting = recent.map(normalizeRecentProjectPath)
    const updated = [norm, ...normalizedExisting.filter((p) => p !== norm)].slice(
      0,
      RECENT_PROJECTS_MAX_ENTRIES,
    )
    const serialized = JSON.stringify(updated)
    if (localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY) !== serialized) {
      localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, serialized)
      queueMirrorRendererPrefsToDisk()
    }
    notifyRecentProjectsChanged()
    return
  }
  queueMirrorRendererPrefsToDisk()
  notifyRecentProjectsChanged()
}
