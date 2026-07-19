/**
 * Shadow-mode integration helpers for `runAgenticToolUse`.
 *
 * Design intent:
 *   • These helpers are the ONLY seam between the main agentic loop and the DT store in P1.
 *   • Every helper is safe to call from anywhere — failures never propagate back into the
 *     agentic loop (observability must never break execution).
 *   • All ids flow in from the caller; no hidden state binding toolUseId → dtId. The caller
 *     holds the `DiffTxId` it got from `shadowCreateDiffTransaction` and passes it back on
 *     subsequent transitions.
 *
 * The idea is: from P2 onwards we flip an `authoritativeDtMode` flag and these helpers
 * become the control path rather than the observation path. Swapping the call sites is a
 * no-op because the API is already state-machine shaped.
 */

import { hashFileContent } from '../tools/readFileState'
import { getDiffTxStore } from './DiffTransactionStore'
import type { DiffTxId, DtError, DiffTransaction } from './DiffTransactionTypes'

/**
 * Best-effort wrapper for `getDiffTxStore().create()`. Returns `null` if anything goes
 * wrong so the caller can use `?` checks instead of try/catch. We also return null when
 * the filePath looks empty / malformed — the caller's existing guard logic stays untouched.
 */
export function shadowCreateDiffTransaction(params: {
  toolUseId: string
  toolName: string
  filePath: string
  originalContent: string
  modifiedContent: string
  fileExisted: boolean
  baseReadId: string | null
  editParams?: {
    oldString: string
    newString: string
    replaceAll: boolean
  }
  riskWarnings?: string[]
}): DiffTxId | null {
  try {
    if (!params.filePath || typeof params.filePath !== 'string') return null
    const store = getDiffTxStore()
    const id = store.newId()
    const baseContentHash = hashFileContent(params.originalContent)
    const dt = store.create({
      id,
      filePath: params.filePath.replace(/\\/g, '/'),
      baseSnapshot: {
        content: params.originalContent,
        contentHash: baseContentHash,
        mtimeMs: 0, // P1 shadow: we don't have a fresh stat here. P3 wires real mtime.
        fileExisted: params.fileExisted,
        readId: params.baseReadId,
      },
      proposed: {
        content: params.modifiedContent,
        toolName: params.toolName,
        toolUseId: params.toolUseId,
        editParams: params.editParams,
      },
      ...(params.riskWarnings && params.riskWarnings.length > 0
        ? { riskWarnings: params.riskWarnings }
        : {}),
    })
    return dt.id
  } catch (e) {
    console.warn('[DT-shadow] create failed (non-fatal):', e)
    return null
  }
}

/** Record a permission request id onto an existing DT. No state transition. */
export function shadowLinkPermissionRequest(id: DiffTxId | null, permissionRequestId: string): void {
  if (!id) return
  try {
    getDiffTxStore().dispatch({ type: 'LinkPermissionRequest', id, permissionRequestId })
  } catch (e) {
    console.warn('[DT-shadow] linkPermissionRequest failed:', e)
  }
}

/** Pending → Approved. Called from the agentic loop right after `decision.behavior === 'allow'`. */
export function shadowMarkPermissionApproved(id: DiffTxId | null, reason?: string): void {
  if (!id) return
  try {
    const r = getDiffTxStore().dispatch({ type: 'PermissionApproved', id, reason })
    if (!r.ok) console.warn('[DT-shadow] PermissionApproved ignored:', r.reason)
  } catch (e) {
    console.warn('[DT-shadow] PermissionApproved failed:', e)
  }
}

/** Pending → Rejected. Called when the user denies or permission hook auto-denies. */
export function shadowMarkPermissionRejected(id: DiffTxId | null, reason?: string): void {
  if (!id) return
  try {
    const r = getDiffTxStore().dispatch({ type: 'PermissionRejected', id, reason })
    if (!r.ok) console.warn('[DT-shadow] PermissionRejected ignored:', r.reason)
  } catch (e) {
    console.warn('[DT-shadow] PermissionRejected failed:', e)
  }
}

/** Approved → Writing. For bypassed / auto-applied writes, call with no prior Approved. */
export function shadowMarkWriteStart(id: DiffTxId | null): void {
  if (!id) return
  try {
    const r = getDiffTxStore().dispatch({ type: 'WriteStart', id })
    if (!r.ok) console.warn('[DT-shadow] WriteStart ignored:', r.reason)
  } catch (e) {
    console.warn('[DT-shadow] WriteStart failed:', e)
  }
}

/**
 * Writing → Applied. Called after the tool succeeded and we've observed post-write content.
 * The post-write hash is computed here so callers don't have to thread it through.
 */
export function shadowMarkWriteApplied(
  id: DiffTxId | null,
  params: { postWriteContent: string; postWriteReadId: string | null },
): void {
  if (!id) return
  try {
    const r = getDiffTxStore().dispatch({
      type: 'WriteApplied',
      id,
      appliedContentHash: hashFileContent(params.postWriteContent),
      appliedReadId: params.postWriteReadId,
    })
    if (!r.ok) console.warn('[DT-shadow] WriteApplied ignored:', r.reason)
  } catch (e) {
    console.warn('[DT-shadow] WriteApplied failed:', e)
  }
}

/** Writing → Failed. Caller supplies a structured reason. */
export function shadowMarkWriteFailed(id: DiffTxId | null, error: DtError): void {
  if (!id) return
  try {
    const r = getDiffTxStore().dispatch({ type: 'WriteFailed', id, error })
    if (!r.ok) console.warn('[DT-shadow] WriteFailed ignored:', r.reason)
  } catch (e) {
    console.warn('[DT-shadow] WriteFailed failed:', e)
  }
}

/**
 * Fold the tool-result `{ success, error }` into the right terminal transition. This is
 * the one-call convenience helper the agentic loop uses after executing the tool — it
 * decides between Applied and Failed and handles the "bypass mode went straight to
 * Writing" vs "already Approved" cases.
 */
export function shadowResolveToolResult(
  id: DiffTxId | null,
  params: {
    success: boolean
    error?: string
    postWriteContent?: string
    postWriteReadId?: string | null
  },
): void {
  if (!id) return
  const store = getDiffTxStore()
  const current = store.get(id)
  if (!current) return
  // If the DT never entered Writing (edge case: tool skipped pre-write side effects), fake
  // it so the state history reflects the real lifecycle.
  if (current.state === 'Approved' || current.state === 'Pending') {
    shadowMarkWriteStart(id)
  }
  if (params.success && typeof params.postWriteContent === 'string') {
    shadowMarkWriteApplied(id, {
      postWriteContent: params.postWriteContent,
      postWriteReadId: params.postWriteReadId ?? null,
    })
  } else if (!params.success) {
    shadowMarkWriteFailed(id, {
      code: 'TOOL_CRASH',
      message: params.error || 'Tool execution failed (no error detail).',
      recoverable: true,
    })
  } else {
    // success === true but no postWriteContent (e.g. no-op edits that matched existing content).
    // Treat as Applied with same content as baseSnapshot so the UI closes the DT cleanly.
    shadowMarkWriteApplied(id, {
      postWriteContent: current.baseSnapshot.content,
      postWriteReadId: params.postWriteReadId ?? null,
    })
  }
}

/** Inspector helper for tests / diagnostics; NOT part of the renderer-facing API. */
export function shadowInspect(id: DiffTxId): DiffTransaction | undefined {
  return getDiffTxStore().get(id)
}
