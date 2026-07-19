/**
 * Indexer type system — shared types for the workspace semantic index
 * manager and its IPC protocol.
 *
 * The indexer runs a three-phase pipeline inside the embedding worker:
 *   walk → chunk → embed → upsert
 * This module defines the state machine, progress events, and result
 * types that the manager exposes to callers.
 */

import type { WorkspaceIndexStatus, BuildProgressTick, BuildOptions, QueryHit } from '../embedding/workspaceIndex'

// ---------------------------------------------------------------------------
// Indexer lifecycle phases
// ---------------------------------------------------------------------------

export type IndexerPhase =
  | 'idle'
  | 'building'
  | 'updating'
  | 'cancelling'
  | 'error'

// ---------------------------------------------------------------------------
// Indexer state (observable via getState())
// ---------------------------------------------------------------------------

export interface IndexerState {
  /** Current lifecycle phase. */
  phase: IndexerPhase

  /** Workspace root currently being indexed (null when idle). */
  currentRoot: string | null

  /** Wall-clock ms when the current build started (null when idle). */
  startedAt: number | null

  /** Latest progress tick from the build pipeline. */
  progress: BuildProgressTick | null
}

// ---------------------------------------------------------------------------
// Re‑export workspace-index types for one‑stop imports
// ---------------------------------------------------------------------------

export type {
  WorkspaceIndexStatus,
  BuildProgressTick,
  BuildOptions,
  QueryHit,
}
