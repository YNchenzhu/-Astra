import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import type * as monaco from 'monaco-editor'
import { DiffEditor } from '@monaco-editor/react'
import { useMonacoReady } from '../../configureMonaco'
import { Check, X, FileCode } from 'lucide-react'
import { useFileStore, type PendingChange } from '../../stores/useFileStore'
import { useChatStore } from '../../stores/useChatStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { computeDiff } from '../../services/diff'
import { normalizePath, toRelativePath } from '../../services/pathUtils'
import { refreshMarkersForModelPath } from '../../services/monacoDiagnostics'
import { useResolvedEditorTheme } from '../../hooks/useResolvedEditorTheme'
import { reportUserActionError } from '../../utils/reportUserActionError'
import './DiffEditorView.css'

interface DiffEditorViewProps {
  change: PendingChange
  language: string
}

const langMap: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  json: 'json',
  markdown: 'markdown',
  plaintext: 'plaintext',
  css: 'css',
  html: 'html',
  python: 'python',
  rust: 'rust',
  go: 'go',
  java: 'java',
  shell: 'shell',
  yaml: 'yaml',
  xml: 'xml',
  sql: 'sql',
}

function computeDiffStats(change: PendingChange): { added: number; removed: number } {
  const { stats } = computeDiff(change.originalContent, change.modifiedContent)
  return { added: stats.added, removed: stats.removed }
}

function buildDiffRenderKey(change: PendingChange): string {
  return [
    change.id,
    change.filePath,
    change.originalContent.length,
    change.modifiedContent.length,
    change.timestamp,
  ].join('::')
}

export const DiffEditorView: React.FC<DiffEditorViewProps> = ({ change, language }) => {
  const respondToPermissionRequest = useChatStore((s) => s.respondToPermissionRequest)
  const editorTheme = useResolvedEditorTheme()
  const monacoReady = useMonacoReady()
  const resolvingRef = useRef(false)
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)

  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const {
    sidebarVisible,
    sidebarWidth,
    aiChatVisible,
    aiChatWidth,
    terminalVisible,
    terminalHeight,
    composerVisible,
  } = useLayoutStore()

  const displayPath = useMemo(() => {
    return toRelativePath(change.filePath, rootPath)
  }, [change.filePath, rootPath])

  const stats = useMemo(() => computeDiffStats(change), [change])
  const diffRenderKey = useMemo(() => buildDiffRenderKey(change), [change])

  const resolvePermission = useCallback(async (behavior: 'allow' | 'deny', content?: string) => {
    if (resolvingRef.current) return
    resolvingRef.current = true
    try {
      if (change.requestId) {
        try {
          const updatedInput = behavior === 'allow' && content
            ? {
                filePath: change.filePath,
                file_path: change.filePath,
                content,
              }
            : undefined

          const ok = await respondToPermissionRequest({
            requestId: change.requestId,
            behavior,
            ...(updatedInput ? { updatedInput } : {}),
          })

          if (!ok && behavior === 'allow') {
            return
          }
        } catch (error) {
          console.error('[DiffEditorView] Failed to resolve permission request:', error)
          if (behavior === 'allow') {
            return
          }
        }
      }

      const fileState = useFileStore.getState()
      const normalizedPath = normalizePath(change.filePath)
      const nextPending = new Map(fileState.pendingChanges)
      nextPending.delete(normalizedPath)

      const relativePath = toRelativePath(change.filePath, rootPath)
      const tab = fileState.tabs.find(
        (t) => normalizePath(t.path) === normalizePath(relativePath) || normalizePath(t.path) === normalizedPath,
      )

      const nextContent = behavior === 'allow'
        ? (content ?? change.modifiedContent)
        : change.originalContent

      const updatedTabs = tab
        ? fileState.tabs.map((t) =>
            t.id === tab.id
              ? { ...t, content: nextContent, isModified: false }
              : t,
          )
        : fileState.tabs

      fileState.setPendingChanges(nextPending)
      if (tab) {
        useFileStore.setState({ tabs: updatedTabs })
      }
      if (behavior === 'allow') {
        refreshMarkersForModelPath(change.filePath)
      }
    } finally {
      resolvingRef.current = false
    }
  }, [change, respondToPermissionRequest, rootPath])

  const handleAccept = useCallback(async () => {
    try {
      await resolvePermission('allow', change.modifiedContent)
    } catch (error) {
      // respondToPermissionRequest now throws when the preload bridge is
      // gone. Previously the diff UI stayed pending forever with no hint —
      // the user would keep clicking 接受 and see nothing.
      reportUserActionError('接受 Diff 更改', error)
    }
  }, [change.modifiedContent, resolvePermission])

  const handleReject = useCallback(async () => {
    try {
      await resolvePermission('deny')
    } catch (error) {
      reportUserActionError('拒绝 Diff 更改', error)
    }
  }, [resolvePermission])

  const handleDiffEditorMount = useCallback((diffEditor: monaco.editor.IStandaloneDiffEditor) => {
    diffEditorRef.current = diffEditor
    const reveal = () => {
      try {
        diffEditor.revealFirstDiff()
        return true
      } catch {
        /* Monaco may throw if model not ready yet */
        return false
      }
    }

    if (!reveal()) {
      setTimeout(() => {
        if (!reveal()) {
          const sub = diffEditor.onDidUpdateDiff(() => {
            reveal()
            sub.dispose()
          })
          setTimeout(() => sub.dispose(), 5000)
        }
      }, 300)
    }
  }, [])

  const relayoutDiffEditor = useCallback(() => {
    const diffEditor = diffEditorRef.current
    if (!diffEditor) return
    window.requestAnimationFrame(() => {
      diffEditor.layout()
    })
  }, [])

  useEffect(() => {
    relayoutDiffEditor()

    const handleWindowResize = () => relayoutDiffEditor()
    const handleWindowFocus = () => relayoutDiffEditor()
    const handleZoomChanged = () => relayoutDiffEditor()
    const handleVisibilityChange = () => {
      if (!document.hidden) relayoutDiffEditor()
    }

    window.addEventListener('resize', handleWindowResize)
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('app:zoom-changed', handleZoomChanged as EventListener)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('resize', handleWindowResize)
      window.removeEventListener('focus', handleWindowFocus)
      window.removeEventListener('app:zoom-changed', handleZoomChanged as EventListener)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [
    relayoutDiffEditor,
    change.filePath,
    editorTheme,
    sidebarVisible,
    sidebarWidth,
    aiChatVisible,
    aiChatWidth,
    terminalVisible,
    terminalHeight,
    composerVisible,
  ])

  useEffect(() => {
    return () => {
      diffEditorRef.current = null
    }
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleAccept()
      return
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'Backspace') {
      e.preventDefault()
      void handleReject()
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      void handleReject()
    }
  }, [handleAccept, handleReject])

  return (
    <div className="diff-editor-view" onKeyDown={handleKeyDown}>
      {change.riskWarnings && change.riskWarnings.length > 0 ? (
        <div className="diff-risk-banner" role="alert">
          {change.riskWarnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      ) : null}
      <div className="diff-toolbar">
        <div className="diff-toolbar-left">
          <FileCode size={14} />
          <span className="diff-file-path">{displayPath}</span>
          <span className="diff-badge">
            {change.toolName === 'edit_file' ? '编辑' : '写入'}
          </span>
          <span className="inline-diff-stats">
            <span className="diff-stat-added">+{stats.added}</span>
            <span className="diff-stat-removed">-{stats.removed}</span>
          </span>
        </div>
        <div className="diff-toolbar-right">
          <button
            className="diff-btn diff-btn-accept"
            onClick={() => void handleAccept()}
            title="保留所有更改 (Ctrl/Cmd+Enter)"
          >
            <Check size={14} />
            <span>全部保留</span>
          </button>
          <button
            className="diff-btn diff-btn-reject"
            onClick={() => void handleReject()}
            title="拒绝所有更改 (Ctrl/Cmd+Backspace)"
          >
            <X size={14} />
            <span>全部拒绝</span>
          </button>
        </div>
      </div>
      <div className="diff-editor-container">
        {!monacoReady ? (
          <div style={{ padding: 16, opacity: 0.6, fontSize: 13 }}>Loading diff…</div>
        ) : (
        <DiffEditor
          key={diffRenderKey}
          original={change.originalContent}
          modified={change.modifiedContent}
          language={langMap[language] || 'plaintext'}
          theme={editorTheme}
          onMount={handleDiffEditorMount}
          options={{
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 13,
            fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
            fontLigatures: true,
            lineHeight: 20,
            automaticLayout: true,
            scrollbar: {
              verticalScrollbarSize: 8,
              horizontalScrollbarSize: 8,
            },
            padding: { top: 8 },
            renderOverviewRuler: true,
            diffCodeLens: false,
            folding: true,
          }}
        />
        )}
      </div>
    </div>
  )
}
