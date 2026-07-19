/**
 * Fusion-layer diff hunks for main/renderer alignment (see electron/ai/proposedHunkPayload.ts).
 */

export type ProposedDiffHunk = {
  id: string
  filePath: string
  originalStartLine: number
  originalEndLine: number
  modifiedStartLine: number
  modifiedEndLine: number
  type: 'insert' | 'delete' | 'replace'
  originalLines: string[]
  modifiedLines: string[]
  status: 'pending'
}
