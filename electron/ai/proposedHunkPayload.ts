/**
 * Build fusion-layer ProposedDiffHunk[] from two file buffers (same algorithm as renderer diff).
 */

import {
  computeDiff,
  MAX_DIFF_COMBINED_LINES,
} from '../../src/services/diff/DiffComputationService'
import type { DiffHunk } from '../../src/services/diff/DiffModel'
import type { ProposedDiffHunk } from '../../src/types/diffFusion'

function toPayload(h: DiffHunk, filePath: string): ProposedDiffHunk {
  const type: ProposedDiffHunk['type'] =
    h.type === 'add' ? 'insert' : h.type === 'delete' ? 'delete' : 'replace'
  return {
    id: h.id,
    filePath,
    originalStartLine: h.origStartLine,
    originalEndLine: h.origEndLine,
    modifiedStartLine: h.modStartLine,
    modifiedEndLine: h.modEndLine,
    type,
    originalLines: h.originalLines,
    modifiedLines: h.modifiedLines,
    status: 'pending',
  }
}

export function buildProposedHunksFromContents(
  filePath: string,
  originalContent: string,
  modifiedContent: string,
): ProposedDiffHunk[] | undefined {
  const oLines = originalContent.split('\n').length
  const mLines = modifiedContent.split('\n').length
  if (oLines + mLines > MAX_DIFF_COMBINED_LINES) return undefined
  try {
    const { hunks } = computeDiff(originalContent, modifiedContent)
    if (hunks.length === 0) return undefined
    return hunks.map((h) => toPayload(h, filePath))
  } catch {
    return undefined
  }
}
