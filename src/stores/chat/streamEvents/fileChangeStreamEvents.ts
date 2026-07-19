/**
 * `file_change_applied` handler split out of `mainStreamRouter.ts`. Reconciles
 * the pending-change queue with the configured diff-permission mode and opens
 * (or syncs) the affected file tab.
 */
import { useFileStore, findTabForWorkspacePath } from '../../useFileStore'
import { useWorkspaceStore } from '../../useWorkspaceStore'
import { normalizePath, toRelativePath } from '../../../services/pathUtils'
import { computeFileMutationRiskWarnings } from '../../../services/fileMutationRisk'
import { LANG_MAP, type MainRouterContext } from './mainRouterShared'

export function handleFileChangeAppliedEvent({ event, api }: MainRouterContext): void {
  if (!event.filePath || event.originalContent === undefined || event.modifiedContent === undefined) return
  const fileState = useFileStore.getState()
  const wsRoot = useWorkspaceStore.getState().rootPath
  const existingPending = fileState.pendingChanges.get(normalizePath(event.filePath))
  const live = api.getState()
  const storeSaysAuto =
    live.diffPermissionMode === 'bypassPermissions' || live.permissionMode === 'bypassPermissions'
  const fileWritesAreAuto = event.autoCommitted === true || storeSaysAuto
  if (fileWritesAreAuto && existingPending) {
    const next = new Map(fileState.pendingChanges)
    next.delete(normalizePath(event.filePath))
    fileState.setPendingChanges(next)
  }
  if (!existingPending && !fileWritesAreAuto && !event.alreadyReviewedViaPermissionUi) {
    const fcRisk = computeFileMutationRiskWarnings(event.originalContent, event.modifiedContent)
    fileState.addPendingChange({
      id: `change-${event.toolUseId || Date.now()}`,
      filePath: event.filePath,
      originalContent: event.originalContent,
      modifiedContent: event.modifiedContent,
      toolUseId: event.toolUseId || '',
      toolName: (event.toolName as 'write_file' | 'edit_file') || 'edit_file',
      timestamp: Date.now(),
      ...(fcRisk.length > 0 ? { riskWarnings: fcRisk } : {}),
    })
  }
  const filePath = event.filePath
  const relativePath = toRelativePath(filePath, wsRoot)
  const existingTab = findTabForWorkspacePath(fileState.tabs, filePath, wsRoot)
  if (existingTab) {
    fileState.syncTabContentFromDisk(existingTab.id, event.modifiedContent, filePath)
    fileState.setActiveTab(existingTab.id)
  } else {
    const ext = relativePath.split('.').pop() || ''
    fileState.openFile({
      id: `ai-diff-${Date.now()}`,
      name: relativePath.split('/').pop() || relativePath,
      path: relativePath,
      language: LANG_MAP[ext] || 'plaintext',
      content: event.modifiedContent,
      isModified: false,
    })
  }
}
