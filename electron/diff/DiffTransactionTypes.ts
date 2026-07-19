/**
 * DiffTransaction — the one first-class object that represents a single AI-proposed file
 * mutation from "AI emitted a tool_use" through "bytes on disk are committed" (or rejected /
 * failed / stale).
 *
 * Architectural notes:
 *  • The DT lives in the main process (`DiffTransactionStore`). The renderer only receives
 *    snapshots and transition events — it NEVER mutates the DT directly. This enforces the
 *    "single source of truth" invariant from the P1→P4 design doc.
 *  • Every state change is captured in `stateHistory` so UI, logs, and tests can reconstruct
 *    the timeline without reading external sources.
 *  • The FSM reducer in `diffTransactionFsm.ts` is the ONLY legal path to mutate a DT. The
 *    store applies reducer outputs and broadcasts the delta.
 *  • During P1 (shadow mode) the DT observes but does not drive; from P2 onwards the UI
 *    reads DT state to decide what to render. See `docs/` (future).
 */

/** Branded id to prevent confusing DT ids with other string ids (toolUse.id, requestId, etc). */
export type DiffTxId = string & { readonly __brand: 'DiffTxId' }

/**
 * The nine canonical states. `Writing` is a distinct phase from `Approved` because between
 * "user said yes" and "bytes hit disk" we may still abort (stale, lock timeout, verify fail);
 * collapsing them would hide genuine failures from the UI.
 */
export type DtState =
  | 'Pending'
  | 'Approved'
  | 'Writing'
  | 'Applied'
  | 'Rejected'
  | 'Failed'
  | 'Stale'

/** Stable, structured error codes. UI / logs / hooks can branch on these without parsing strings. */
export type DtErrorCode =
  | 'HASH_MISMATCH_PRE_WRITE'
  | 'HASH_MISMATCH_POST_WRITE'
  | 'OLD_STRING_NOT_FOUND'
  | 'INTEGRITY_CLEAR'
  | 'LOCK_TIMEOUT'
  | 'DISK_IO'
  | 'PERMISSION_DENIED_OS'
  | 'TOOL_CRASH'
  | 'EXTERNAL_MODIFICATION'
  | 'USER_CANCELLED'
  | 'UNKNOWN'

export interface DtError {
  code: DtErrorCode
  message: string
  recoverable: boolean
}

/**
 * The exact bytes the AI proposal was based on. Captured ONCE at DT creation; it is the
 * authoritative "before" side of the diff shown to the user and the rebase anchor if the
 * file later drifts on disk.
 */
export interface DtBaseSnapshot {
  /** Complete file body at read time (BOM-stripped). May be '' for brand-new-file creations. */
  content: string
  /** sha256 of `content`. Computed via `hashFileContent` from readFileState. */
  contentHash: string
  /** `fs.stat().mtimeMs` at read time — secondary staleness signal. */
  mtimeMs: number
  /** Whether the file existed on disk when the snapshot was taken. */
  fileExisted: boolean
  /** The readId that surfaced this snapshot to the AI (ties DT to `readFileState`). */
  readId: string | null
}

/** What the AI wants to produce. For `edit_file` this is the final reconciled content. */
export interface DtProposed {
  /** Full target file content if the edit is applied as-is. */
  content: string
  /** Originating tool. Determines the write code path and hash gate in P3. */
  toolName: 'edit_file' | 'write_file' | 'NotebookEdit' | string
  /** Matches `toolUse.id` in the agentic loop; stable for the DT's lifetime. */
  toolUseId: string
  /** `old_string` / `new_string` / `replace_all` for edit_file; preserved for rebase in P4. */
  editParams?: {
    oldString: string
    newString: string
    replaceAll: boolean
  }
}

/** One history entry per state transition (audit + debugging). */
export interface DtHistoryEntry {
  from: DtState
  to: DtState
  at: number
  reason?: string
  errorCode?: DtErrorCode
}

/**
 * Full DiffTransaction. In shadow-mode (P1), UI does not consume this yet; but every field
 * is already populated because P2 refactors consume these same shapes without migration.
 */
export interface DiffTransaction {
  id: DiffTxId
  filePath: string
  state: DtState
  baseSnapshot: DtBaseSnapshot
  proposed: DtProposed
  /**
   * The permission-request id the UI raised, if the tool went through an approval prompt.
   * `null` under auto-apply / bypass permission mode — DT still progresses through the same
   * states so observers don't need to special-case that branch.
   */
  permissionRequestId: string | null
  /**
   * Authoritative post-write hash once `Applied`. Enables "view applied diff" audit without
   * re-reading disk, and lets us detect if another tool clobbered our bytes.
   */
  appliedContentHash: string | null
  appliedReadId: string | null
  stateHistory: DtHistoryEntry[]
  error: DtError | null
  /**
   * Optional: destructive-clear banners etc. Populated from `computeFileMutationRiskWarnings`
   * at creation time.
   */
  riskWarnings?: string[]
  /** Creation timestamp (ms). */
  createdAt: number
  /** Last state transition (ms). Makes UI "how long has this been pending" trivially computable. */
  updatedAt: number
}

// ---------------------------------------------------------------------------
// FSM event DSL — the ONLY legal way to mutate a DT from outside the store.
// ---------------------------------------------------------------------------

export type DtEvent =
  | {
      type: 'Create'
      id: DiffTxId
      filePath: string
      baseSnapshot: DtBaseSnapshot
      proposed: DtProposed
      riskWarnings?: string[]
      at?: number
    }
  | { type: 'LinkPermissionRequest'; id: DiffTxId; permissionRequestId: string; at?: number }
  | { type: 'PermissionApproved'; id: DiffTxId; at?: number; reason?: string }
  | { type: 'PermissionRejected'; id: DiffTxId; at?: number; reason?: string }
  | { type: 'WriteStart'; id: DiffTxId; at?: number }
  | {
      type: 'WriteApplied'
      id: DiffTxId
      appliedContentHash: string
      appliedReadId: string | null
      at?: number
    }
  | { type: 'WriteFailed'; id: DiffTxId; error: DtError; at?: number }
  | { type: 'MarkStale'; id: DiffTxId; reason?: string; at?: number }
  | {
      type: 'Rebase'
      id: DiffTxId
      newBaseSnapshot: DtBaseSnapshot
      newProposedContent: string
      at?: number
    }
  | { type: 'Retry'; id: DiffTxId; at?: number }

/**
 * Broadcast-shaped event for IPC. All renderer subscribers see exactly these. We keep the
 * discriminant literal strings stable forever — changing them is a protocol break.
 */
export type DtBroadcast =
  | { type: 'Snapshot'; transactions: DiffTransaction[] }
  | { type: 'Created'; transaction: DiffTransaction }
  | {
      type: 'Transitioned'
      id: DiffTxId
      from: DtState
      to: DtState
      transaction: DiffTransaction
    }
  | { type: 'Closed'; id: DiffTxId; finalState: DtState }
  | { type: 'Rebased'; transaction: DiffTransaction }
  | { type: 'Dropped'; id: DiffTxId }

/**
 * Terminal states: no further transitions allowed. Used by the store to decide when to
 * un-index a DT and by the renderer to know it can free related UI caches.
 */
export const TERMINAL_STATES: ReadonlySet<DtState> = new Set(['Applied', 'Rejected'])

export function isTerminalState(s: DtState): boolean {
  return TERMINAL_STATES.has(s)
}
