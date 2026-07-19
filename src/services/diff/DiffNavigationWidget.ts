// Hunk navigation logic — shared across all Diff modes.
// Provides previous/next hunk traversal with wrapping.

import type { DiffHunk } from './DiffModel'

export interface NavigationState {
  focusedHunkId: string | null
  unresolvedHunks: DiffHunk[]
}

export interface FocusMeta {
  hunkId: string | null
  index: number
  total: number
}

export function getFocusMeta(state: NavigationState): FocusMeta {
  const { unresolvedHunks, focusedHunkId } = state
  if (unresolvedHunks.length === 0) return { hunkId: null, index: 0, total: 0 }
  if (!focusedHunkId) return { hunkId: unresolvedHunks[0].id, index: 1, total: unresolvedHunks.length }

  const idx = unresolvedHunks.findIndex((h) => h.id === focusedHunkId)
  if (idx === -1) return { hunkId: unresolvedHunks[0].id, index: 1, total: unresolvedHunks.length }
  return { hunkId: focusedHunkId, index: idx + 1, total: unresolvedHunks.length }
}

/**
 * Compute the next focused hunk id when navigating in a direction.
 * Returns the new hunk id or null if no hunks available.
 */
export function navigateHunk(
  state: NavigationState,
  direction: 1 | -1,
): string | null {
  const { unresolvedHunks, focusedHunkId } = state
  if (unresolvedHunks.length === 0) return null

  if (!focusedHunkId) return unresolvedHunks[0].id

  const currentIndex = unresolvedHunks.findIndex((h) => h.id === focusedHunkId)
  const nextIndex =
    currentIndex === -1
      ? 0
      : (currentIndex + direction + unresolvedHunks.length) % unresolvedHunks.length

  return unresolvedHunks[nextIndex].id
}

/**
 * Determine the next focused hunk after resolving (accept/reject) one.
 */
export function focusAfterResolve(
  resolvedHunkId: string,
  currentFocusId: string | null,
  unresolvedHunks: DiffHunk[],
): string | null {
  if (unresolvedHunks.length === 0) return null
  if (currentFocusId !== resolvedHunkId) return currentFocusId
  return unresolvedHunks[0].id
}
