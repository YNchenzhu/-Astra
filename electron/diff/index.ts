/**
 * Public API of the DiffTransaction subsystem. Consumers (agentic loop, IPC bridge, tests)
 * should import from here; everything else is implementation detail.
 */

export type {
  DiffTransaction,
  DiffTxId,
  DtBaseSnapshot,
  DtBroadcast,
  DtError,
  DtErrorCode,
  DtEvent,
  DtHistoryEntry,
  DtProposed,
  DtState,
} from './DiffTransactionTypes'
export { isTerminalState, TERMINAL_STATES } from './DiffTransactionTypes'

export {
  createDiffTransaction,
  canTransition,
  isDtClosed,
  LEGAL_TRANSITIONS,
  reduce,
} from './diffTransactionFsm'
export type { ReducerResult } from './diffTransactionFsm'

export {
  __resetDiffTxStoreForTests,
  DiffTransactionStore,
  getDiffTxStore,
} from './DiffTransactionStore'

export {
  shadowCreateDiffTransaction,
  shadowInspect,
  shadowLinkPermissionRequest,
  shadowMarkPermissionApproved,
  shadowMarkPermissionRejected,
  shadowMarkWriteApplied,
  shadowMarkWriteFailed,
  shadowMarkWriteStart,
  shadowResolveToolResult,
} from './shadowIntegration'

export { createDiffTransactionFromPreview } from './diffPreviewAdapter'
export type { CreateDtFromPreviewInput } from './diffPreviewAdapter'

// ---------------------------------------------------------------------------
// P3: atomic writer + stale watcher + renderer intents.
// ---------------------------------------------------------------------------

export { atomicWriteFile } from './atomicWriter'
export type {
  AtomicWriteError,
  AtomicWriteErrorCode,
  AtomicWriteOk,
  AtomicWriteOptions,
  AtomicWriteResult,
} from './atomicWriter'

export {
  __resetStaleWatcherForTests,
  attachStaleWatcher,
  DiffTxStaleWatcher,
  shutdownStaleWatcher,
} from './diffTxWatcher'
export type { IFsWatcher, WatcherFactory } from './diffTxWatcher'

export {
  __resetDiffTxIntentsIpcForTests,
  initDiffTxIntentsIpc,
  intentAbort,
  intentRebase,
  intentRetry,
  intentUndo,
} from './diffTxIntents'
export type { IntentErr, IntentOk, IntentResult } from './diffTxIntents'

// P4a — per-hunk composition.
export { applyAcceptedHunks, computeHunks } from './hunkSelection'
export type { Hunk, HunkDiff } from './hunkSelection'

// P4c — undo queue.
export {
  __resetUndoQueueForTests,
  attachUndoQueue,
  DEFAULT_UNDO_RETENTION_MS,
  getUndoQueue,
  shutdownUndoQueue,
  UndoQueue,
} from './undoQueue'
export type { UndoErr, UndoOk, UndoQueueEntry, UndoResult } from './undoQueue'

// P4d — WAL persistence.
export {
  __resetWalForTests,
  attachWal,
  DtWalStore,
  getWalStore,
  shutdownWal,
  TERMINAL_RETENTION_MS,
} from './diffTxWal'
export type { WalOptions } from './diffTxWal'
