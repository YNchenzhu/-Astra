// Unified accept/reject command handler for all Diff modes.
// Coordinates permission responses and file state updates.

import type { DiffSession, FileDiff } from './DiffModel'

export interface PermissionResponder {
  (params: {
    requestId: string
    behavior: 'allow' | 'deny'
    updatedInput?: Record<string, unknown>
  }): Promise<boolean>
}

/**
 * Accept a single file: respond with the (possibly hunk-edited) modified content.
 */
export async function acceptFile(
  fileDiff: FileDiff,
  requestId: string | undefined,
  content: string,
  respond?: PermissionResponder,
): Promise<boolean> {
  if (!requestId || !respond) return true

  return respond({
    requestId,
    behavior: 'allow',
    updatedInput: {
      filePath: fileDiff.filePath,
      file_path: fileDiff.filePath,
      content,
    },
  })
}

/**
 * Reject a single file: respond with deny.
 */
export async function rejectFile(
  requestId: string | undefined,
  respond?: PermissionResponder,
): Promise<boolean> {
  if (!requestId || !respond) return true
  return respond({ requestId, behavior: 'deny' })
}

/**
 * Accept all files in a session.
 */
export async function acceptAllFiles(
  session: DiffSession,
  getRequestId: (filePath: string) => string | undefined,
  getContent: (filePath: string) => string,
  respond?: PermissionResponder,
): Promise<void> {
  for (const [, fileDiff] of session.files) {
    const reqId = getRequestId(fileDiff.filePath)
    const content = getContent(fileDiff.filePath)
    await acceptFile(fileDiff, reqId, content, respond)
  }
}

/**
 * Reject all files in a session.
 */
export async function rejectAllFiles(
  session: DiffSession,
  getRequestId: (filePath: string) => string | undefined,
  respond?: PermissionResponder,
): Promise<void> {
  for (const [, fileDiff] of session.files) {
    const reqId = getRequestId(fileDiff.filePath)
    await rejectFile(reqId, respond)
  }
}
