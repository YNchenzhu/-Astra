import type { DiffPreview } from '../../types'
import { useFileStore, findTabForWorkspacePath } from '../useFileStore'
import { useWorkspaceStore } from '../useWorkspaceStore'
import { toRelativePath } from '../../services/pathUtils'

/**
 * Extension → Monaco language id mapping used for AI-opened diff tabs.
 * Previously duplicated inline in three stream-event handlers.
 */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  json: 'json',
  css: 'css',
  html: 'html',
  md: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shell',
  sql: 'sql',
  xml: 'xml',
}

export function resolveLanguageForPath(relativePath: string): string {
  const ext = relativePath.split('.').pop() || ''
  return LANGUAGE_BY_EXTENSION[ext] || 'plaintext'
}

/**
 * Shared focus-steal policy for diff / file-write events.
 *
 * Historically three stream handlers (`permission_request`,
 * `team_permission_request`, `file_change_applied`) each carried an inline
 * copy of "find matching tab → decide whether to focus-steal → either
 * update existing tab or open a new one → restore previous active tab".
 *
 * Rules (mirrors the original inline code):
 *  - If there is NO active tab, or the active tab already IS the diff
 *    target, take focus.
 *  - Otherwise keep the user's focus where it is; we still open/update
 *    the diff tab behind the scenes so the Inline Diff controller can
 *    pick it up.
 *  - When opening a brand-new tab, `useFileStore.openFile` unconditionally
 *    sets `activeTabId` to the new tab; we restore the previous active
 *    tab if we weren't supposed to steal focus.
 *  - For `file_change_applied`, we also sync an existing, non-dirty tab's
 *    buffer to the new content. Dirty buffers are left alone so unsaved
 *    user edits aren't destroyed.
 */
export interface OpenOrFocusDiffOptions {
  filePath: string
  originalContent: string
  modifiedContent: string
  /**
   * For `file_change_applied`: when a matching non-dirty tab exists,
   * overwrite its buffer with `modifiedContent`. For permission previews
   * we keep the current buffer untouched.
   */
  syncExistingTabBufferOnApply?: boolean
  /** Suffix/prefix for the synthetic tab id when opening a new tab (default: `ai-diff-`). */
  newTabIdPrefix?: string
}

export function openOrFocusDiffTarget(opts: OpenOrFocusDiffOptions): void {
  const fileState = useFileStore.getState()
  const wsRoot = useWorkspaceStore.getState().rootPath
  const { filePath, originalContent, modifiedContent } = opts
  const relativePath = toRelativePath(filePath, wsRoot)
  const existingTab = findTabForWorkspacePath(fileState.tabs, filePath, wsRoot)

  // Focus-steal policy (fix for low-controllability diff UX):
  // Only commandeer the active tab when the user is NOT in the middle of
  // something else — i.e. there is no active tab at all, or the active
  // tab already IS the diff target. Otherwise the user keeps their focus
  // and can click into the diff from the Inline Diff file-tabs or the
  // tab bar at their own pace. This also removes the race where an
  // unrelated active tab was forced to swap models mid-diff.
  const activeTabBefore = fileState.tabs.find((t) => t.id === fileState.activeTabId)
  const activeIsDiffTarget =
    !!activeTabBefore && !!existingTab && activeTabBefore.id === existingTab.id
  const shouldFocusDiff = !activeTabBefore || activeIsDiffTarget

  if (existingTab) {
    if (opts.syncExistingTabBufferOnApply && !existingTab.isModified) {
      // Only overwrite the tab buffer from disk if it isn't carrying
      // unsaved user edits. Blowing away a dirty buffer because the AI
      // happened to touch the same path would destroy the user's work.
      fileState.syncTabContentFromDisk(existingTab.id, modifiedContent, filePath)
    }
    if (shouldFocusDiff) {
      fileState.setActiveTab(existingTab.id)
    }
    return
  }

  const language = resolveLanguageForPath(relativePath)
  const newTabId = `${opts.newTabIdPrefix || 'ai-diff-'}${Date.now()}`
  fileState.openFile({
    id: newTabId,
    name: relativePath.split('/').pop() || relativePath,
    path: relativePath,
    language,
    content: opts.syncExistingTabBufferOnApply ? modifiedContent : originalContent,
    isModified: false,
  })

  // openFile always sets activeTabId to the new tab; restore the caller's
  // previous active tab when we weren't supposed to steal focus.
  if (!shouldFocusDiff && activeTabBefore) {
    useFileStore.setState({ activeTabId: activeTabBefore.id })
  }
}

/** Pending-change record shorthand used by permission handlers. */
export function addPendingDiffChange(params: {
  changeId: string
  requestId: string
  toolUseId: string
  toolName: string
  diffPreview: DiffPreview
}): void {
  const fileState = useFileStore.getState()
  fileState.addPendingChange({
    id: params.changeId,
    filePath: params.diffPreview.filePath,
    originalContent: params.diffPreview.originalContent,
    modifiedContent: params.diffPreview.modifiedContent,
    toolUseId: params.toolUseId,
    toolName: (params.toolName as 'write_file' | 'edit_file') || 'edit_file',
    timestamp: Date.now(),
    requestId: params.requestId,
    ...(params.diffPreview.riskWarnings?.length
      ? { riskWarnings: params.diffPreview.riskWarnings }
      : {}),
  })
}
