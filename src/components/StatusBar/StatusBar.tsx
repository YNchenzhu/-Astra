import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  GitBranch,
  AlertCircle,
  AlertTriangle,
  Check,
  Layout,
  Code2,
  Database,
  Loader2,
  Package,
} from 'lucide-react'
import { useFileStore } from '../../stores/useFileStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useDiagnosticStore } from '../../stores/useDiagnosticStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useWorkspaceIndexStore } from '../../stores/useWorkspaceIndexStore'
import { useActiveBundle } from '../../stores/bundleStore'
import { useT } from '../../i18n'
import { TaskPill } from './TaskPill'
import './StatusBar.css'

const StatusBarInner: React.FC = () => {
  const t = useT()
  const { activeTabId, tabs, cursorLine, cursorColumn } = useFileStore()
  const { rootPath } = useWorkspaceStore()
  const { setShowSettings } = useSettingsStore()
  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId),
    [tabs, activeTabId],
  )
  // Memoised so the `useEffect` below (statusLineHook) does not re-fire on every render
  // due to fresh object identity. Was a real source of redundant `fireStatusLine` IPC
  // calls on hot stores.
  const activeFileInfo = useMemo(
    () =>
      activeTab
        ? { path: activeTab.path, language: activeTab.language, name: activeTab.name }
        : null,
    [activeTab],
  )
  const [gitBranch, setGitBranch] = useState('main')
  const errorCount = useDiagnosticStore((s) => s.errorCount)
  const warningCount = useDiagnosticStore((s) => s.warningCount)
  const setActiveTerminalTab = useLayoutStore((s) => s.setActiveTerminalTab)
  const terminalVisible = useLayoutStore((s) => s.terminalVisible)
  const toggleTerminal = useLayoutStore((s) => s.toggleTerminal)
  const statusLineHookTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // --- Workspace-index indicator ------------------------------------------
  // Backed by the global `useWorkspaceIndexStore` so the badge keeps
  // updating even when the Settings panel isn't mounted. Click behaviour
  // depends on state: idle/failed → kick off a build; building → open the
  // Settings panel to show detailed progress.
  const wsIndexBuilding = useWorkspaceIndexStore((s) => s.building)
  const wsIndexProgress = useWorkspaceIndexStore((s) => s.progress)
  const wsIndexStatus = useWorkspaceIndexStore((s) => s.status)
  const wsIndexError = useWorkspaceIndexStore((s) => s.error)
  const startWsIndexBuild = useWorkspaceIndexStore((s) => s.startBuild)

  const wsIndexLabel = useMemo(() => {
    if (wsIndexBuilding) {
      const p = wsIndexProgress
      if (!p) return t.statusBar.indexing
      if (p.chunksTotal > 0) {
        const pct = Math.min(100, Math.floor((p.chunksEmbedded / p.chunksTotal) * 100))
        return t.statusBar.indexingProgress(p.chunksEmbedded, p.chunksTotal, pct)
      }
      if (p.phase === 'walk') return t.statusBar.indexingWalk(p.filesScanned)
      if (p.phase === 'chunk') return t.statusBar.indexingChunk(p.filesIndexed, p.filesScanned)
      if (p.phase === 'upsert') return t.statusBar.indexingUpsert
      return t.statusBar.indexing
    }
    if (wsIndexError) return t.statusBar.indexFailed
    if (wsIndexStatus?.indexed && wsIndexStatus.chunkCount > 0) {
      return t.statusBar.indexedChunks(wsIndexStatus.chunkCount)
    }
    return t.statusBar.buildIndex
  }, [wsIndexBuilding, wsIndexProgress, wsIndexStatus, wsIndexError, t])

  const wsIndexTitle = useMemo(() => {
    if (wsIndexBuilding) {
      return t.statusBar.indexBuildingTitle
    }
    if (wsIndexError) {
      return t.statusBar.indexFailedTitle(wsIndexError)
    }
    if (wsIndexStatus?.indexed && wsIndexStatus.chunkCount > 0) {
      const when = wsIndexStatus.builtAt
        ? new Date(wsIndexStatus.builtAt).toLocaleString()
        : ''
      return t.statusBar.indexDoneTitle(
        wsIndexStatus.model || t.statusBar.unknownModel,
        wsIndexStatus.chunkCount,
        wsIndexStatus.filesIndexed,
        when,
      )
    }
    return rootPath
      ? t.statusBar.indexIdleTitle
      : t.statusBar.indexNoWorkspaceTitle
  }, [wsIndexBuilding, wsIndexError, wsIndexStatus, rootPath, t])

  const onClickWsIndex = React.useCallback(() => {
    if (!rootPath) return
    if (wsIndexBuilding) {
      setShowSettings(true, 'embedding')
      return
    }
    // Idle, failed, or completed: trigger a (re-)build.
    void startWsIndexBuild(rootPath, true)
  }, [rootPath, wsIndexBuilding, setShowSettings, startWsIndexBuild])

  useEffect(() => {
    if (!rootPath || !window.electronAPI?.terminal) return
    window.electronAPI.terminal.exec('git branch --show-current', rootPath).then((result) => {
      if (result.success && result.stdout.trim()) {
        setGitBranch(result.stdout.trim())
      }
    }).catch(() => {})
  }, [rootPath])

  useEffect(() => {
    const api = window.electronAPI?.hooks
    if (!api?.fireStatusLine) return

    if (statusLineHookTimer.current) clearTimeout(statusLineHookTimer.current)
    statusLineHookTimer.current = setTimeout(() => {
      statusLineHookTimer.current = null
      void api.fireStatusLine({
        workspacePath: rootPath ?? '',
        branch: gitBranch,
        diagnostics: { errors: errorCount, warnings: warningCount },
        cursor: { line: cursorLine, column: cursorColumn },
        activeFile: activeFileInfo,
      })
    }, 400)

    return () => {
      if (statusLineHookTimer.current) {
        clearTimeout(statusLineHookTimer.current)
        statusLineHookTimer.current = null
      }
    }
  }, [
    rootPath,
    gitBranch,
    errorCount,
    warningCount,
    cursorLine,
    cursorColumn,
    activeFileInfo,
  ])

  const langLabel = (language: string) => {
    const labels: Record<string, string> = {
      typescript: 'TypeScript React',
      javascript: 'JavaScript',
      json: 'JSON',
      markdown: 'Markdown',
      plaintext: t.statusBar.langPlainText,
      python: 'Python',
      rust: 'Rust',
      go: 'Go',
      css: 'CSS',
      html: 'HTML',
    }
    return labels[language] || language
  }

  // Extract once so the dep array matches React Compiler's inferred property accesses
  // exactly (was: `[activeTab?.content]` triggering `preserve-manual-memoization` because
  // the compiler inferred `activeTab` as the source dependency).
  const activeTabContent = activeTab?.content
  const lineEnding = useMemo(() => {
    if (activeTabContent === undefined) return 'LF'
    return activeTabContent.includes('\r\n') ? 'CRLF' : 'LF'
  }, [activeTabContent])

  // Active bundle label — read-only in Phase 1; the Bundle switcher UI
  // (D1 TitleBar) will provide interactive switching. We render nothing
  // when the store hasn't hydrated yet so the bar doesn't "flicker in"
  // an empty item on cold start.
  const activeBundle = useActiveBundle()

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {activeBundle && (
          <div
            className="statusbar-item statusbar-bundle"
            title={t.statusBar.bundleTitle(activeBundle.meta.name, activeBundle.meta.id)}
          >
            <Package size={13} />
            <span>{activeBundle.meta.name}</span>
          </div>
        )}
        <div className="statusbar-item statusbar-branch">
          <GitBranch size={13} />
          <span>{gitBranch}</span>
        </div>
        <div className="statusbar-item statusbar-diagnostics" onClick={() => { if (!terminalVisible) toggleTerminal(); setActiveTerminalTab('problems') }}>
          {errorCount > 0 && (
            <>
              <AlertCircle size={13} />
              <span>{errorCount}</span>
            </>
          )}
          {warningCount > 0 && (
            <>
              <AlertTriangle size={13} />
              <span>{warningCount}</span>
            </>
          )}
          {errorCount === 0 && warningCount === 0 && (
            <>
              <AlertCircle size={13} />
              <span>0</span>
              <AlertTriangle size={13} />
              <span>0</span>
            </>
          )}
        </div>
        {rootPath && (
          <button
            type="button"
            className={
              'statusbar-item statusbar-clickable statusbar-wsindex'
              + (wsIndexBuilding ? ' statusbar-wsindex-active' : '')
              + (wsIndexError && !wsIndexBuilding ? ' statusbar-wsindex-error' : '')
            }
            onClick={onClickWsIndex}
            title={wsIndexTitle}
            disabled={!rootPath}
          >
            {wsIndexBuilding
              ? <Loader2 size={13} className="statusbar-wsindex-spin" />
              : <Database size={13} />}
            <span>{wsIndexLabel}</span>
          </button>
        )}
        <TaskPill />
      </div>
      <div className="statusbar-right">
        {activeTab && (
          <>
            <div className="statusbar-item">
              <span>{t.statusBar.lineCol(cursorLine, cursorColumn)}</span>
            </div>
            <div className="statusbar-item">
              <span>{t.statusBar.spaces(2)}</span>
            </div>
            <div className="statusbar-item">
              <span>UTF-8</span>
            </div>
            <div className="statusbar-item">
              <span>{lineEnding}</span>
            </div>
            <div className="statusbar-item">
              <span>{langLabel(activeTab.language)}</span>
            </div>
          </>
        )}
        <button
          className="statusbar-item statusbar-clickable"
          onClick={() => setShowSettings(true, 'model')}
          title={t.statusBar.modelAndDiffTitle}
        >
          <Check size={13} />
          <span>{t.statusBar.modelAndDiff}</span>
        </button>
        <button
          className="statusbar-item statusbar-clickable statusbar-lsp"
          onClick={() => setShowSettings(true, 'lsp')}
          title={t.statusBar.lspTitle}
        >
          <Code2 size={13} />
          <span>LSP</span>
        </button>
        <button
          className="statusbar-item statusbar-clickable"
          onClick={() => setShowSettings(true, 'appearance')}
          title={t.statusBar.themeTitle}
        >
          <Layout size={13} />
        </button>
      </div>
    </div>
  )
}

export const StatusBar = React.memo(StatusBarInner)
