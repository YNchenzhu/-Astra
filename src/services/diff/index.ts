export {
  type DiffOp,
  type DiffLine,
  type CharRange,
  type DiffHunk,
  type DiffStats,
  type DiffResult,
  type FileDiff,
  type DiffSessionMode,
  type DiffSession,
} from './DiffModel'

export {
  computeLineDiff,
  computeCharDiff,
  groupIntoHunks,
  computeDiff,
  /**
   * Apply a subset of hunks (by id) from a prior `computeDiff()` to `original`,
   * returning the composed content. Powered by the P4a engine — CRLF/BOM/trailing
   * newline safe. See `DiffComputationService.applyAcceptedHunks`.
   */
  applyAcceptedHunks,
  MAX_DIFF_COMBINED_LINES,
} from './DiffComputationService'

export {
  type RuntimeHunkState,
  type DecorationContext,
  buildDiffDecorations,
  applyDecorations,
  clearDecorations,
  buildGhostNode,
  createHunkButtons,
} from './DiffDecorationManager'

export {
  type NavigationState,
  type FocusMeta,
  getFocusMeta,
  navigateHunk,
  focusAfterResolve,
} from './DiffNavigationWidget'

// NOTE: `AcceptRejectAction.ts` was removed — `useFileStore.acceptAllChanges`
// / `rejectAllChanges` / `acceptPendingChange` / `rejectPendingChange` are a
// strict superset (they also update editor tabs, trigger LSP save notifications,
// and refresh diagnostics, none of which the removed helpers did).
