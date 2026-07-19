/**
 * Adapter from the legacy `DiffPreview` (permission UI input) to a DiffTransaction creation.
 *
 * Kept in its own file because:
 *   • `runAgenticToolUse` already depends on `DiffPreview`; we only add a single helper import.
 *   • Mapping logic (pulling `editParams` out of the tool input, deciding `fileExisted`, etc.)
 *     has a non-trivial surface that we want unit-tested in isolation.
 */

import type { DiffPreview } from '../ai/interactionState'
import type { DiffTxId } from './DiffTransactionTypes'
import { shadowCreateDiffTransaction } from './shadowIntegration'

export interface CreateDtFromPreviewInput {
  toolUseId: string
  toolName: string
  /** Raw tool input so we can recover old_string/new_string for P4 rebase replay. */
  toolInput: Record<string, unknown>
  /** The same `DiffPreview` the permission UI is about to receive. */
  preview: DiffPreview
  /** Whether the target file existed at the moment the preview was built. */
  fileExisted: boolean
  /**
   * If the tool call was already anchored to a readId (new `baseReadId` param from the
   * Content-Hash rollout), surface it here so the DT's baseSnapshot can reference it.
   */
  baseReadId?: string | null
}

export function createDiffTransactionFromPreview(params: CreateDtFromPreviewInput): DiffTxId | null {
  const { toolInput } = params
  const oldString =
    typeof toolInput.oldString === 'string'
      ? (toolInput.oldString as string)
      : typeof toolInput.old_string === 'string'
        ? (toolInput.old_string as string)
        : ''
  const newString =
    typeof toolInput.newString === 'string'
      ? (toolInput.newString as string)
      : typeof toolInput.new_string === 'string'
        ? (toolInput.new_string as string)
        : ''
  const replaceAll = toolInput.replaceAll === true || toolInput.replace_all === true
  const hasEditParams = oldString !== '' || newString !== '' || replaceAll

  // `riskWarnings` is an optional field the user's working tree sometimes has and
  // sometimes doesn't (the `DiffPreview` type has been reshaped multiple times in this
  // repo). Read it defensively from an `unknown` cast so we don't depend on a specific
  // version of the type to compile.
  const previewLike = params.preview as unknown as { riskWarnings?: string[] }
  const riskWarnings =
    Array.isArray(previewLike.riskWarnings) && previewLike.riskWarnings.length > 0
      ? [...previewLike.riskWarnings]
      : undefined

  return shadowCreateDiffTransaction({
    toolUseId: params.toolUseId,
    toolName: params.toolName,
    filePath: params.preview.filePath,
    originalContent: params.preview.originalContent,
    modifiedContent: params.preview.modifiedContent,
    fileExisted: params.fileExisted,
    baseReadId: params.baseReadId ?? null,
    ...(hasEditParams ? { editParams: { oldString, newString, replaceAll } } : {}),
    ...(riskWarnings ? { riskWarnings } : {}),
  })
}
