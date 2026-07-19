import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import type * as monaco from 'monaco-editor'
import {
  AlertTriangle,
  AlignJustify,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Columns2,
  FileCode,
  GitBranch,
  RotateCw,
  X,
  XCircle,
} from 'lucide-react'
import { InlineDiffDecorator, runWithSuppressedOnChange } from './InlineDiffDecorator'
import type { PendingChange } from '../../stores/useFileStore'
import { findTabForWorkspacePath, useFileStore, workspacePathsReferToSameFile } from '../../stores/useFileStore'
import { useChatStore } from '../../stores/useChatStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useDiffTransactionStore } from '../../stores/useDiffTransactionStore'
import {
  clearDtFailureAnnotation,
  getDtFailureAnnotation,
} from '../../stores/diffTxAuthoritativeSync'
import { MAX_DIFF_COMBINED_LINES } from '../../services/diff'
import { normalizePath, toRelativePath, toWorkspaceAbsoluteFilePath } from '../../services/pathUtils'
import { refreshMarkersForModelPath } from '../../services/monacoDiagnostics'
import { notifyLspDocumentSave } from '../../services/lspDocumentSync'
import { reportUserActionError } from '../../utils/reportUserActionError'
import '../../styles/inlineDiff.css'

function getEditorModelAbsolutePath(editor: monaco.editor.IStandaloneCodeEditor): string | null {
  const uri = editor.getModel()?.uri
  if (!uri || uri.scheme !== 'file') return null
  try {
    const fp = uri.fsPath
    return fp && fp.length > 0 ? fp.replace(/\\/g, '/') : null
  } catch {
    return null
  }
}

interface InlineDiffControllerProps {
  pendingChange: PendingChange
  editor: monaco.editor.IStandaloneCodeEditor | null
  diffViewMode: 'inline' | 'side-by-side'
  onDiffViewModeChange: (mode: 'inline' | 'side-by-side') => void
  inlineModeEnabled?: boolean
}

export const InlineDiffController: React.FC<InlineDiffControllerProps> = ({
  pendingChange,
  editor,
  diffViewMode,
  onDiffViewModeChange,
  inlineModeEnabled = true,
}) => {
  const decoratorRef = useRef<InlineDiffDecorator | null>(null)
  const [stats, setStats] = useState<{ added: number; removed: number; hunks: number } | null>(null)
  const [skippedLargeDiff, setSkippedLargeDiff] = useState(false)
  const [unresolvedCount, setUnresolvedCount] = useState(0)
  const [focusedHunk, setFocusedHunk] = useState<{ index: number; total: number }>({ index: 0, total: 0 })
  const resolvingRef = useRef(false)
  const pendingChangeRef = useRef(pendingChange)
  pendingChangeRef.current = pendingChange

  const respondToPermissionRequest = useChatStore((s) => s.respondToPermissionRequest)
  const setAutoApproveRemainingDiffs = useChatStore((s) => s.setAutoApproveRemainingDiffs)
  const allPendingChanges = useFileStore((s) => s.pendingChanges)
  const acceptAllChanges = useFileStore((s) => s.acceptAllChanges)
  const rejectAllChanges = useFileStore((s) => s.rejectAllChanges)
  const rootPath = useWorkspaceStore((s) => s.rootPath)

  const totalPendingFiles = useMemo(() => allPendingChanges.size, [allPendingChanges])

  const pendingFiles = useMemo(() => {
    return Array.from(allPendingChanges.values())
  }, [allPendingChanges])

  const currentIndex = useMemo(() => {
    const targetPath = normalizePath(pendingChange.filePath)
    return pendingFiles.findIndex((f) => normalizePath(f.filePath) === targetPath)
  }, [pendingFiles, pendingChange.filePath])

  const navigateToFile = useCallback((change: PendingChange) => {
    const fileState = useFileStore.getState()
    const tab = findTabForWorkspacePath(fileState.tabs, change.filePath, rootPath)
    if (tab) {
      fileState.setActiveTab(tab.id)
    }
  }, [rootPath])

  const resolvePermission = useCallback(async (
    behavior: 'allow' | 'deny',
    content?: string,
  ) => {
    if (resolvingRef.current) return
    resolvingRef.current = true
    const pc = pendingChangeRef.current
    const respond = useChatStore.getState().respondToPermissionRequest
    // Read feature flag at dispatch time so toggling via DevTools has immediate effect
    // without a remount.
    const dtMode = useSettingsStore.getState().diffPrecisionMode === 'dt'
    try {
      if (pc.requestId) {
        try {
          const updatedInput = behavior === 'allow' && typeof content === 'string'
            ? {
                filePath: pc.filePath,
                file_path: pc.filePath,
                content,
              }
            : undefined

          const ok = await respond({
            requestId: pc.requestId,
            behavior,
            ...(updatedInput ? { updatedInput } : {}),
          })

          // Allow needs a main-process waiter; deny should still clear UI if the waiter is already gone
          // (e.g. stream abort resolved the promise) — same idea as rejectAllChanges.
          if (!ok && behavior === 'allow') {
            return
          }
        } catch {
          if (behavior === 'allow') {
            return
          }
        }
      }

      // P2 feature-flagged branch:
      //   In `dt` mode the DT authoritative sync hook is responsible for removing the
      //   pending entry + updating tab.content in response to the backend's Applied /
      //   Failed / Rejected broadcast. We must NOT do any of those things optimistically
      //   here — doing so re-introduces the "brief flash" UX regression and, for failure
      //   paths, leaves the tab out of sync with disk. Legacy mode keeps the original
      //   behaviour below untouched.
      if (dtMode) {
        return
      }

      const fileState = useFileStore.getState()
      const normalizedPath = normalizePath(pc.filePath)
      const next = new Map(fileState.pendingChanges)
      next.delete(normalizedPath)

      const tab = findTabForWorkspacePath(fileState.tabs, pc.filePath, rootPath)
      const targetContent = behavior === 'allow'
        ? (content ?? pc.modifiedContent)
        : pc.originalContent

      const updatedTabs = tab
        ? fileState.tabs.map((t) =>
            t.id === tab.id
              ? { ...t, content: targetContent, isModified: false }
              : t,
          )
        : fileState.tabs

      fileState.setPendingChanges(next)
      if (tab) {
        useFileStore.setState({ tabs: updatedTabs })
      }
      if (behavior === 'allow') {
        refreshMarkersForModelPath(pc.filePath)
        const abs = toWorkspaceAbsoluteFilePath(pc.filePath, rootPath)
        if (abs && !abs.startsWith('untitled')) notifyLspDocumentSave(abs)
      }

      // Sync Monaco editor model only when it is still showing this file.
      // The resolve flow is async; user may switch tabs before it finishes.
      // Writing unconditionally would leak file B's content into tab A's model.
      //
      // Wrap in the suppression helper so Monaco's resulting onChange is not
      // re-interpreted by `EditorArea.handleEditorChange` as a user edit (even
      // though the ghost-event guard there would usually skip it thanks to the
      // just-applied `tabs` store update, any future reordering would reopen
      // the same "tab flashes dirty after accept" hole).
      const modelPath = editor ? getEditorModelAbsolutePath(editor) : null
      if (editor && modelPath && workspacePathsReferToSameFile(modelPath, pc.filePath, rootPath)) {
        const model = editor.getModel()
        if (model && model.getValue() !== targetContent) {
          runWithSuppressedOnChange(() => model.setValue(targetContent))
        }
      }
    } finally {
      resolvingRef.current = false
    }
  }, [editor, rootPath])

  useEffect(() => {
    if (!editor || !pendingChange || diffViewMode !== 'inline') {
      if (decoratorRef.current) {
        decoratorRef.current.dispose()
        decoratorRef.current = null
      }
      if (!pendingChange) setStats(null)
      setSkippedLargeDiff(false)
      return
    }

    resolvingRef.current = false
    setSkippedLargeDiff(false)

    if (decoratorRef.current) {
      decoratorRef.current.dispose()
      decoratorRef.current = null
    }

    const origLines = pendingChangeRef.current.originalContent.split('\n')
    const modLines = pendingChangeRef.current.modifiedContent.split('\n')
    if (origLines.length + modLines.length > MAX_DIFF_COMBINED_LINES) {
      setSkippedLargeDiff(true)
      setStats({ added: 0, removed: 0, hunks: 0 })
      setUnresolvedCount(0)
      setFocusedHunk({ index: 0, total: 0 })
      return
    }

    let cancelled = false
    let modelListener: monaco.IDisposable | null = null

    const tryAttach = (): boolean => {
      if (cancelled) return true
      const modelPath = getEditorModelAbsolutePath(editor)

      // Fallback: if model URI is not a file:// scheme (e.g. inmemory://),
      // resolve the tab's absolute path and use that for matching.
      let resolvedPath = modelPath
      if (!resolvedPath) {
        const fileState = useFileStore.getState()
        const matches = fileState.tabs.filter((t) => {
          const abs = toWorkspaceAbsoluteFilePath(t.path, rootPath)
          return workspacePathsReferToSameFile(abs, pendingChange.filePath, rootPath)
        })
        const tab =
          matches.length === 1
            ? matches[0]
            : matches.length > 1
              ? matches.find((t) => t.id === fileState.activeTabId) ?? matches[0]
              : undefined
        if (tab) {
          resolvedPath = toWorkspaceAbsoluteFilePath(tab.path, rootPath)
        }
      }

      if (!resolvedPath || !workspacePathsReferToSameFile(resolvedPath, pendingChange.filePath, rootPath)) {
        return false
      }

      modelListener?.dispose()
      modelListener = null

      if (decoratorRef.current) {
        decoratorRef.current.dispose()
        decoratorRef.current = null
      }

      const decorator = new InlineDiffDecorator(
        editor,
        pendingChangeRef.current.originalContent,
        pendingChangeRef.current.modifiedContent,
      )

      decorator.onAcceptHunk = () => {
        setUnresolvedCount(decorator.getUnresolvedCount())
      }

      decorator.onRejectHunk = () => {
        setUnresolvedCount(decorator.getUnresolvedCount())
      }

      decorator.onFocusChange = (meta) => {
        setFocusedHunk({ index: meta.index, total: meta.total })
      }

      decorator.onAllResolved = async () => {
        const currentContent = decorator.getCurrentContent()
        const orig = pendingChangeRef.current.originalContent
        const behavior = currentContent === orig ? 'deny' : 'allow'
        await resolvePermission(behavior, currentContent)
      }

      decorator.apply()
      setStats(decorator.getStats())
      setUnresolvedCount(decorator.getUnresolvedCount())
      const focus = decorator.getFocusMeta()
      setFocusedHunk({ index: focus.index, total: focus.total })
      decoratorRef.current = decorator
      return true
    }

    if (!tryAttach()) {
      setStats(null)
      // Retry via setTimeout in case the editor model hasn't fully initialized yet.
      // (Result handle unused: the cleanup path relies on `cancelled` / the model
      // listener dispose below rather than clearing this timer.)
      setTimeout(() => {
        if (cancelled) return
        if (!tryAttach()) {
          modelListener = editor.onDidChangeModel(() => {
            if (tryAttach()) {
              modelListener?.dispose()
              modelListener = null
            }
          })
        }
      }, 200)
    }

    return () => {
      cancelled = true
      modelListener?.dispose()
      modelListener = null
      const d = decoratorRef.current
      if (d) {
        const model = editor?.getModel()
        if (model) {
          const orig = pendingChangeRef.current.originalContent
          if (model.getValue() !== orig) {
            // Suppress the onChange this `setValue` would otherwise fire. Without
            // the guard Monaco's event loop reports the programmatic revert to
            // `EditorArea.handleEditorChange`, which flips the currently-focused
            // tab to `isModified: true` and shows a spurious dirty dot even
            // though the underlying buffer content lines up with disk (the
            // approval flow has already persisted the accepted content or left
            // the file untouched on reject). This cleanup runs on every
            // InlineDiffController unmount — including right after Accept —
            // so missing suppression here is what was putting the dirty dot
            // back onto the previously-active tab after the earlier autosave /
            // updateTabContent fix landed.
            runWithSuppressedOnChange(() => model.setValue(orig))
          }
        }
        d.dispose()
        decoratorRef.current = null
      }
    }
    // Intentional dep scope:
    //   - `pendingChange.id` / `.filePath` re-attach only on a NEW pending change (not
    //     on every prop refresh that mutates `originalContent` / `modifiedContent`,
    //     which a separate effect below handles via `decorator.updateContents`).
    //   - `pendingChange` body fields and `resolvePermission` are accessed via
    //     `pendingChangeRef.current` and a closure capture so the running decorator
    //     always sees the latest values without remounting. Including them in deps
    //     would tear down + re-create the decorator on every render that touches the
    //     surrounding store, losing user selection state mid-review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    editor,
    pendingChange.id,
    pendingChange.filePath,
    diffViewMode,
    rootPath,
  ])

  useEffect(() => {
    if (diffViewMode !== 'inline') return
    const decorator = decoratorRef.current
    if (!decorator) return

    decorator.updateContents(
      pendingChange.originalContent,
      pendingChange.modifiedContent,
    )
    setStats(decorator.getStats())
    setUnresolvedCount(decorator.getUnresolvedCount())
    const focus = decorator.getFocusMeta()
    setFocusedHunk({ index: focus.index, total: focus.total })
  }, [
    diffViewMode,
    pendingChange.originalContent,
    pendingChange.modifiedContent,
  ])

  const handleAcceptAll = useCallback(async () => {
    try {
      setAutoApproveRemainingDiffs(true)
      await acceptAllChanges(respondToPermissionRequest)
    } catch (error) {
      reportUserActionError('全部接受 Diff', error)
    }
  }, [acceptAllChanges, respondToPermissionRequest, setAutoApproveRemainingDiffs])

  const handleRejectAll = useCallback(async () => {
    try {
      await rejectAllChanges(respondToPermissionRequest)
    } catch (error) {
      reportUserActionError('全部拒绝 Diff', error)
    }
  }, [rejectAllChanges, respondToPermissionRequest])

  const handleAcceptFile = useCallback(async () => {
    try {
      await resolvePermission('allow', pendingChange.modifiedContent)
    } catch (error) {
      reportUserActionError('接受当前文件 Diff', error)
    }
  }, [pendingChange.modifiedContent, resolvePermission])

  const handleRejectFile = useCallback(async () => {
    try {
      await resolvePermission('deny')
    } catch (error) {
      reportUserActionError('拒绝当前文件 Diff', error)
    }
  }, [resolvePermission])

  const handlePrevHunk = useCallback(() => {
    decoratorRef.current?.focusNextUnresolved(-1)
  }, [])

  const handleNextHunk = useCallback(() => {
    decoratorRef.current?.focusNextUnresolved(1)
  }, [])

  useEffect(() => {
    if (diffViewMode !== 'inline') return

    const handler = (e: KeyboardEvent) => {
      if (!editor?.hasTextFocus?.()) return

      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        void handleAcceptAll()
        return
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'Backspace' || e.key === 'Delete')) {
        e.preventDefault()
        void handleRejectAll()
        return
      }

      if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault()
        decoratorRef.current?.focusNextUnresolved(1)
        return
      }

      if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault()
        decoratorRef.current?.focusNextUnresolved(-1)
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        decoratorRef.current?.acceptFocusedHunk()
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        decoratorRef.current?.rejectFocusedHunk()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [diffViewMode, editor, handleAcceptAll, handleRejectAll])

  const displayPath = useMemo(() => {
    return toRelativePath(pendingChange.filePath, rootPath)
  }, [pendingChange.filePath, rootPath])

  const fileName = useMemo(() => displayPath.split('/').pop() || displayPath, [displayPath])

  const riskBanner =
    pendingChange.riskWarnings && pendingChange.riskWarnings.length > 0 ? (
      <div className="inline-diff-risk-banner" role="alert">
        {pendingChange.riskWarnings.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
    ) : null

  // ── P2/P3/P4 DT-mode failure surface ──────────────────────
  //
  // Watches the renderer's DT mirror store for any DiffTransaction on this file that is
  // in Failed / Stale state. The auth-sync hook (`useDiffTxAuthoritativeSync`) writes a
  // structured annotation when that happens; we pick it up here and render a banner
  // with the right affordance — Retry for generic failures, Rebase for external-mod
  // (Stale) failures. Feature-gated on dt mode because legacy writes don't go through
  // the DT pipeline at all.
  const diffPrecisionMode = useSettingsStore((s) => s.diffPrecisionMode)
  const dtRevision = useDiffTransactionStore((s) => s.revision)
  const failureAnnotation = useMemo(
    () => (diffPrecisionMode === 'dt' ? getDtFailureAnnotation(pendingChange.filePath) : undefined),
    // dtRevision bumps on every DT broadcast — forces recompute of the annotation lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingChange.filePath, diffPrecisionMode, dtRevision],
  )

  const handleDismissFailure = useCallback(() => {
    clearDtFailureAnnotation(pendingChange.filePath)
    // Close the diff UI — the failure has been acknowledged. The DT itself stays in
    // Failed for audit purposes; the toast/banner just goes away.
    const fileState = useFileStore.getState()
    const next = new Map(fileState.pendingChanges)
    next.delete(pendingChange.filePath)
    fileState.setPendingChanges(next)
  }, [pendingChange.filePath])

  const handleRetry = useCallback(async () => {
    const api = window.electronAPI?.diffTx
    if (!api?.intentRetry) return
    // Locate the Failed DT anchored to this file; there should be at most one in a
    // well-behaved session. If the DT has since been GC'd we fall through silently.
    const all = useDiffTransactionStore.getState().transactionsById
    let failedId: string | null = null
    for (const tx of all.values()) {
      if (tx.state === 'Failed' && tx.filePath === pendingChange.filePath) {
        failedId = tx.id
        break
      }
    }
    if (!failedId) return
    const r = await api.intentRetry(failedId)
    if (r.ok) {
      clearDtFailureAnnotation(pendingChange.filePath)
    } else {
      console.warn('[InlineDiff] intentRetry refused:', r.reason)
    }
  }, [pendingChange.filePath])

  const handleRebase = useCallback(async () => {
    const api = window.electronAPI?.diffTx
    if (!api?.intentRebase) return
    const all = useDiffTransactionStore.getState().transactionsById
    let staleId: string | null = null
    for (const tx of all.values()) {
      if (tx.state === 'Stale' && tx.filePath === pendingChange.filePath) {
        staleId = tx.id
        break
      }
    }
    if (!staleId) return
    const r = await api.intentRebase(staleId)
    if (r.ok) {
      clearDtFailureAnnotation(pendingChange.filePath)
    } else {
      console.warn('[InlineDiff] intentRebase refused:', r.reason)
    }
  }, [pendingChange.filePath])

  const dtFailureBanner = failureAnnotation ? (
    <div
      className="inline-diff-dt-failure-banner"
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        marginBottom: 4,
        background: 'var(--color-error-bg, rgba(248, 81, 73, 0.12))',
        border: '1px solid var(--color-error-border, rgba(248, 81, 73, 0.4))',
        borderRadius: 4,
        fontSize: 12,
        color: 'var(--color-error-fg, #f85149)',
      }}
    >
      <AlertTriangle size={14} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, lineHeight: 1.4 }}>
        <strong style={{ marginRight: 6 }}>[{failureAnnotation.errorCode}]</strong>
        {failureAnnotation.errorMessage}
      </span>
      {failureAnnotation.errorCode === 'EXTERNAL_MODIFICATION' ? (
        <button
          type="button"
          className="inline-diff-btn"
          onClick={handleRebase}
          title="将此 diff 重新锚定到当前磁盘内容"
          style={{ flexShrink: 0 }}
        >
          <GitBranch size={12} />
          <span>Rebase</span>
        </button>
      ) : (
        <button
          type="button"
          className="inline-diff-btn"
          onClick={handleRetry}
          title="重试此更改"
          style={{ flexShrink: 0 }}
        >
          <RotateCw size={12} />
          <span>Retry</span>
        </button>
      )}
      <button
        type="button"
        className="inline-diff-btn reject"
        onClick={handleDismissFailure}
        title="关闭差异视图"
        style={{ flexShrink: 0 }}
      >
        <X size={12} />
        <span>Dismiss</span>
      </button>
    </div>
  ) : null

  // ── Render: top info bar ──────────────────────────────────

  const topBar = (
    <div className="inline-diff-toolbar-top">
      {/* File tabs when multiple files */}
      {pendingFiles.length > 1 ? (
        <div className="inline-diff-file-tabs">
          {pendingFiles.map((f, i) => {
            const fName = toRelativePath(f.filePath, rootPath).split('/').pop() || f.filePath
            return (
              <button
                key={f.id}
                className={`inline-diff-file-tab ${i === currentIndex ? 'active' : ''}`}
                onClick={() => navigateToFile(f)}
                title={toRelativePath(f.filePath, rootPath)}
              >
                <FileCode size={12} />
                <span>{fName}</span>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="inline-diff-toolbar-left">
          <FileCode size={14} />
          <span className="inline-diff-file">{fileName}</span>
        </div>
      )}

      <div className="inline-diff-toolbar-center-top">
        <span className="inline-diff-badge">
          {pendingChange.toolName === 'edit_file' ? '编辑' : '写入'}
        </span>
        {skippedLargeDiff && (
          <span className="inline-diff-large-file-hint" title="内联差异已跳过">
            文件过大，已跳过内联差异计算（行数超过上限）
          </span>
        )}
        {stats && !skippedLargeDiff && (
          <span className="inline-diff-stats">
            <span className="diff-stat-added">+{stats.added}</span>
            <span className="diff-stat-removed">-{stats.removed}</span>
          </span>
        )}
        {unresolvedCount > 0 && (
          <span className="inline-diff-progress">
            {unresolvedCount} 个待处理
          </span>
        )}
      </div>

      <div className="inline-diff-toolbar-right-top">
        <div className="inline-diff-mode-switch" role="group" aria-label="Diff view mode">
          <button
            className={`inline-diff-nav-btn ${diffViewMode === 'inline' ? 'active' : ''}`}
            onClick={() => onDiffViewModeChange('inline')}
            title="内联差异"
            disabled={!inlineModeEnabled}
          >
            <AlignJustify size={14} />
          </button>
          <button
            className={`inline-diff-nav-btn ${diffViewMode === 'side-by-side' ? 'active' : ''}`}
            onClick={() => onDiffViewModeChange('side-by-side')}
            title="并排差异"
          >
            <Columns2 size={14} />
          </button>
        </div>
      </div>
    </div>
  )

  // ── Render: bottom action bar (ReviewActionBar) ───────────

  const bottomBar = (
    <div className="inline-diff-toolbar-bottom">
      <div className="inline-diff-toolbar-bottom-left">
        <button className="inline-diff-btn accept" onClick={handleAcceptFile} title="仅接受此文件的更改">
          <Check size={14} />
          <span>接受此文件</span>
        </button>
        <button className="inline-diff-btn reject" onClick={handleRejectFile} title="仅拒绝此文件的更改">
          <XCircle size={14} />
          <span>拒绝此文件</span>
        </button>
        <div className="inline-diff-separator" />
        <button className="inline-diff-btn accept" onClick={handleAcceptAll} title={`接受所有更改（共 ${totalPendingFiles} 个文件）(Ctrl/Cmd+Enter)`}>
          <CheckCheck size={14} />
          <span>全部接受</span>
        </button>
        <button className="inline-diff-btn reject" onClick={handleRejectAll} title={`拒绝所有更改（共 ${totalPendingFiles} 个文件）(Ctrl/Cmd+Backspace)`}>
          <XCircle size={14} />
          <span>全部拒绝</span>
        </button>
      </div>

      <div className="inline-diff-toolbar-bottom-right">
        {diffViewMode === 'inline' && focusedHunk.total > 0 && (
          <div className="inline-diff-nav">
            <button className="inline-diff-nav-btn" onClick={handlePrevHunk} title="上一个更改块 (Alt+↑)">
              <ChevronUp size={14} />
            </button>
            <span className="inline-diff-nav-label">
              更改块 {focusedHunk.index}/{focusedHunk.total}
            </span>
            <button className="inline-diff-nav-btn" onClick={handleNextHunk} title="下一个更改块 (Alt+↓)">
              <ChevronDown size={14} />
            </button>
          </div>
        )}

        {pendingFiles.length > 1 && (
          <div className="inline-diff-nav">
            <button
              className="inline-diff-nav-btn"
              disabled={currentIndex <= 0}
              onClick={() => navigateToFile(pendingFiles[currentIndex - 1])}
              title="上一个文件"
            >
              <ChevronUp size={14} />
            </button>
            <span className="inline-diff-nav-label">
              文件 {currentIndex + 1}/{pendingFiles.length}
            </span>
            <button
              className="inline-diff-nav-btn"
              disabled={currentIndex >= pendingFiles.length - 1}
              onClick={() => navigateToFile(pendingFiles[currentIndex + 1])}
              title="下一个文件"
            >
              <ChevronDown size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  )

  // ── Loading state ─────────────────────────────────────────

  if (!stats) return (
    <>
      {riskBanner}
      {dtFailureBanner}
      <div className="inline-diff-toolbar-top">
        <div className="inline-diff-toolbar-left">
          <FileCode size={14} />
          <span className="inline-diff-file">{fileName}</span>
          <span className="inline-diff-badge">
            {pendingChange.toolName === 'edit_file' ? '编辑' : '写入'}
          </span>
          <span className="inline-diff-large-file-hint">正在计算差异…</span>
        </div>
      </div>
      {bottomBar}
    </>
  )

  return (
    <>
      {riskBanner}
      {dtFailureBanner}
      {topBar}
      {bottomBar}
    </>
  )
}
