/**
 * Pure FSM reducer for DiffTransaction. No I/O, no store access — taking a (DT, event)
 * pair and returning either the next DT or a structured "illegal transition" result.
 *
 * Why a pure reducer:
 *  • Makes the state machine trivially testable (property-tested in diffTransactionFsm.test.ts).
 *  • Keeps the store boring: receive event → call reducer → if ok, swap DT and broadcast.
 *  • P1 shadow observers can replay events on any baseline without touching the live store.
 */

import type {
  DiffTransaction,
  DtBaseSnapshot,
  DtError,
  DtEvent,
  DtHistoryEntry,
  DtState,
} from './DiffTransactionTypes'
import { isTerminalState } from './DiffTransactionTypes'

export type ReducerResult =
  | { ok: true; next: DiffTransaction; transition?: { from: DtState; to: DtState } }
  | { ok: false; reason: string }

const ILLEGAL = (from: DtState, evt: string): ReducerResult => ({
  ok: false,
  reason: `Illegal transition: event '${evt}' is not valid from state '${from}'.`,
})

function nextHistoryEntry(
  from: DtState,
  to: DtState,
  at: number,
  reason?: string,
  errorCode?: DtError['code'],
): DtHistoryEntry {
  const entry: DtHistoryEntry = { from, to, at }
  if (reason !== undefined) entry.reason = reason
  if (errorCode !== undefined) entry.errorCode = errorCode
  return entry
}

function transition(
  dt: DiffTransaction,
  to: DtState,
  at: number,
  reason?: string,
  errorCode?: DtError['code'],
): DiffTransaction {
  return {
    ...dt,
    state: to,
    updatedAt: at,
    stateHistory: [...dt.stateHistory, nextHistoryEntry(dt.state, to, at, reason, errorCode)],
  }
}

/**
 * Legal-transition table, centralised here so "what can happen from X?" is answered in one
 * place. The reducer consults this before dispatching — additions should be made here first
 * and then the corresponding `case` branch added below.
 */
export const LEGAL_TRANSITIONS: Record<DtState, readonly DtState[]> = {
  Pending: ['Approved', 'Rejected', 'Stale'],
  Approved: ['Writing', 'Rejected', 'Stale'],
  Writing: ['Applied', 'Failed', 'Stale'],
  Failed: ['Writing', 'Rejected', 'Pending'], // Retry → Writing; Abort → Rejected; Rebase → Pending
  Stale: ['Pending', 'Rejected'], // Rebase → Pending (fresh snapshot); Abandon → Rejected
  Applied: [], // terminal
  Rejected: [], // terminal
}

export function canTransition(from: DtState, to: DtState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to)
}

/**
 * Apply one event. Returns the next DT + which transition fired (for broadcast), or an
 * illegal-transition explanation. Never throws — invalid input is a normal failure case.
 */
export function reduce(dt: DiffTransaction, evt: DtEvent): ReducerResult {
  const at = evt.at ?? Date.now()

  switch (evt.type) {
    case 'Create':
      // Create is not applied via reduce — it is handled by the store (needs to build a
      // fresh DT, not transition an existing one). We guard here so tests can assert it.
      return { ok: false, reason: `Create is not a reducer event — use createDiffTransaction().` }

    case 'LinkPermissionRequest':
      // Metadata-only event — does NOT change state. We still return a next DT so the store
      // can persist the linkage.
      return {
        ok: true,
        next: {
          ...dt,
          permissionRequestId: evt.permissionRequestId,
          updatedAt: at,
        },
      }

    case 'PermissionApproved': {
      if (!canTransition(dt.state, 'Approved')) return ILLEGAL(dt.state, evt.type)
      return {
        ok: true,
        next: transition(dt, 'Approved', at, evt.reason),
        transition: { from: dt.state, to: 'Approved' },
      }
    }

    case 'PermissionRejected': {
      if (!canTransition(dt.state, 'Rejected')) return ILLEGAL(dt.state, evt.type)
      return {
        ok: true,
        next: transition(dt, 'Rejected', at, evt.reason),
        transition: { from: dt.state, to: 'Rejected' },
      }
    }

    case 'WriteStart': {
      if (!canTransition(dt.state, 'Writing')) return ILLEGAL(dt.state, evt.type)
      return {
        ok: true,
        next: transition(dt, 'Writing', at),
        transition: { from: dt.state, to: 'Writing' },
      }
    }

    case 'WriteApplied': {
      if (!canTransition(dt.state, 'Applied')) return ILLEGAL(dt.state, evt.type)
      return {
        ok: true,
        next: {
          ...transition(dt, 'Applied', at),
          appliedContentHash: evt.appliedContentHash,
          appliedReadId: evt.appliedReadId,
        },
        transition: { from: dt.state, to: 'Applied' },
      }
    }

    case 'WriteFailed': {
      if (!canTransition(dt.state, 'Failed')) return ILLEGAL(dt.state, evt.type)
      return {
        ok: true,
        next: {
          ...transition(dt, 'Failed', at, evt.error.message, evt.error.code),
          error: evt.error,
        },
        transition: { from: dt.state, to: 'Failed' },
      }
    }

    case 'MarkStale': {
      if (!canTransition(dt.state, 'Stale')) return ILLEGAL(dt.state, evt.type)
      return {
        ok: true,
        next: transition(dt, 'Stale', at, evt.reason),
        transition: { from: dt.state, to: 'Stale' },
      }
    }

    case 'Rebase': {
      // Rebase is only legal from Stale or Failed. It resets the baseSnapshot and proposed
      // content, and transitions back to Pending so the user can re-approve with fresh eyes.
      if (!canTransition(dt.state, 'Pending')) return ILLEGAL(dt.state, evt.type)
      return {
        ok: true,
        next: {
          ...transition(dt, 'Pending', at, 'rebased onto new baseSnapshot'),
          baseSnapshot: evt.newBaseSnapshot,
          proposed: { ...dt.proposed, content: evt.newProposedContent },
          error: null,
        },
        transition: { from: dt.state, to: 'Pending' },
      }
    }

    case 'Retry': {
      // Retry from Failed → Writing. The caller (writer) is responsible for actually doing
      // the write again; we just flip the state so UI can show "writing..." immediately.
      if (dt.state !== 'Failed' || !canTransition('Failed', 'Writing')) {
        return ILLEGAL(dt.state, evt.type)
      }
      return {
        ok: true,
        next: transition({ ...dt, error: null }, 'Writing', at, 'retry'),
        transition: { from: 'Failed', to: 'Writing' },
      }
    }

    default: {
      // Exhaustiveness — if someone adds a new event type they'll get a compile error here.
      const _exhaustive: never = evt
      return { ok: false, reason: `Unknown event: ${JSON.stringify(_exhaustive)}` }
    }
  }
}

/**
 * Construct a brand-new DT. Kept separate from `reduce` because creation needs all the
 * metadata the reducer doesn't have access to.
 */
export function createDiffTransaction(params: {
  id: DiffTransaction['id']
  filePath: string
  baseSnapshot: DtBaseSnapshot
  proposed: DiffTransaction['proposed']
  riskWarnings?: string[]
  at?: number
}): DiffTransaction {
  const at = params.at ?? Date.now()
  const dt: DiffTransaction = {
    id: params.id,
    filePath: params.filePath,
    state: 'Pending',
    baseSnapshot: params.baseSnapshot,
    proposed: params.proposed,
    permissionRequestId: null,
    appliedContentHash: null,
    appliedReadId: null,
    stateHistory: [{ from: 'Pending', to: 'Pending', at, reason: 'created' }],
    error: null,
    createdAt: at,
    updatedAt: at,
  }
  if (params.riskWarnings && params.riskWarnings.length > 0) {
    dt.riskWarnings = [...params.riskWarnings]
  }
  return dt
}

/** Convenience for "is this DT done, the store can forget about it eventually?". */
export function isDtClosed(dt: DiffTransaction): boolean {
  return isTerminalState(dt.state)
}
