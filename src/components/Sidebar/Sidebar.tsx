import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  FilePlus,
  FolderPlus,
  RefreshCw,
  FolderOpen as FolderOpenIcon,
  ListCollapse,
  Crosshair,
} from 'lucide-react'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useFileStore, findTabForWorkspacePath } from '../../stores/useFileStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useFileTreeUIStore } from '../../stores/useFileTreeUIStore'
import { FileTree } from './FileTree'
import { SearchPanel } from './SearchPanel'
import { GitPanel } from './GitPanel'
import { onWorkspaceFileChanged } from '../../services/fileSystem'
import { readTabContent } from '../../services/openBehavior'
import { normalizePath } from '../../services/pathUtils'
import { toWorkspaceAbsoluteFilePath } from '../../services/pathUtils'
import { useT } from '../../i18n'
import type { SidebarView } from '../../types'
import type { FileNode } from '../../types'
import './Sidebar.css'

export const Sidebar: React.FC = () => {
  const t = useT()
  const sidebarTitles: Record<SidebarView, string> = {
    explorer: t.activityBar.explorer,
    search: t.activityBar.search,
    git: t.activityBar.git,
    extensions: t.activityBar.extensions,
  }
  const { sidebarView, sidebarWidth, setSidebarWidth } = useLayoutStore()
  const { openFile, tabs, activeTabId, newFile } = useFileStore()
  const {
    rootPath,
    rootName,
    fileTree,
    isLoading,
    openWorkspace,
    refreshFileTree,
    refreshFileTreeSilent,
    workspaceTrusted,
    trustWorkspaceInFlight,
    trustCurrentWorkspace,
  } = useWorkspaceStore()
  const isResizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)
  const [resizing, setResizing] = useState(false)
  // Holds the active drag's teardown closure so an unmount mid-drag (e.g.
  // Ctrl+B toggles `sidebarVisible` → CodeWorkspaceLayout drops <Sidebar/>
  // from the tree) can still release pointer capture and detach listeners.
  const cleanupResizeListenersRef = useRef<(() => void) | null>(null)

  const activePath = tabs.find((t) => t.id === activeTabId)?.path || null

  const handleFileClick = useCallback(
    async (node: FileNode) => {
      if (node.type !== 'file' || !rootPath) return
      // Defensive: a FileNode's `path` is normally workspace-relative, but if
      // it's ever absolute (e.g. a virtual node pointing outside the tree)
      // this helper leaves it intact instead of producing `C:\ws\C:\...`.
      const fullPath = toWorkspaceAbsoluteFilePath(node.path, rootPath)

      const existing = findTabForWorkspacePath(tabs, node.path, rootPath)
      if (existing) {
        openFile(existing)
        return
      }

      try {
        // 统一打开行为表(openBehavior.ts):文本才读盘,图片/文档预览类
        // 标签页内容置空,由 EditorArea 路由到对应查看器懒加载二进制。
        const content = await readTabContent(fullPath, node.name)
        openFile({
          id: node.path,
          name: node.name,
          path: node.path,
          language: node.language || 'plaintext',
          content,
          isModified: false,
        })
      } catch (error) {
        console.error('Failed to read file:', error)
      }
    },
    [rootPath, tabs, openFile]
  )

  // Pointer Capture-based drag (parity with ChatPanel.tsx) — the previous
  // implementation attached `mousemove` / `mouseup` directly on `document`
  // with no `useEffect` cleanup. If the user pressed Ctrl+B mid-drag the
  // Sidebar would unmount but those handlers stayed bound until the next
  // mouseup anywhere on the page; in degenerate paths (mouse leaving the
  // window with the button still held, or a second drag starting before
  // the first cleanup fired) it left zombie listeners running closures
  // over an unmounted tree. Pointer Capture binds events to the handle
  // element instead, and the browser auto-fires `lostpointercapture` /
  // `pointercancel` on unmount — which we hook for guaranteed cleanup.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const el = e.currentTarget
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* not all pointer types are capturable; safe to fall through */
      }
      isResizing.current = true
      startX.current = e.clientX
      startWidth.current = sidebarWidth
      setResizing(true)

      const onMove = (ev: PointerEvent) => {
        if (!isResizing.current) return
        const delta = ev.clientX - startX.current
        setSidebarWidth(startWidth.current + delta)
      }
      const teardown = () => {
        isResizing.current = false
        setResizing(false)
        try {
          el.releasePointerCapture(e.pointerId)
        } catch {
          /* already released */
        }
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', onEnd)
        el.removeEventListener('pointercancel', onEnd)
        el.removeEventListener('lostpointercapture', onLostCapture)
        cleanupResizeListenersRef.current = null
      }
      const onEnd = (_ev: PointerEvent) => teardown()
      const onLostCapture = () => teardown()

      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', onEnd)
      el.addEventListener('pointercancel', onEnd)
      el.addEventListener('lostpointercapture', onLostCapture)
      // Stash the teardown so an unmount mid-drag (Ctrl+B) can still run it.
      cleanupResizeListenersRef.current = teardown
    },
    [sidebarWidth, setSidebarWidth],
  )

  // Belt-and-suspenders: if the component unmounts while a drag is in
  // flight (Ctrl+B toggles `sidebarVisible` → CodeWorkspaceLayout drops
  // the <Sidebar/> from the tree), force the teardown so the orphaned
  // listeners and pointer capture cannot outlive the component.
  useEffect(() => {
    return () => {
      cleanupResizeListenersRef.current?.()
    }
  }, [])

  // Auto-refresh the file tree when external mutations land on disk.
  //
  // Why this exists: chokidar's worker fires `workspace:file-changed` for
  // every add/unlink under the workspace root, but the only existing
  // subscriber (useFileStore) drops everything except `change` because its
  // job is to refresh open editor tabs — not the tree.  Without this hook
  // the explorer stays out of sync with the disk for any external mutation:
  // terminal commands, AI tool writes (workspaceFileNotify pushes through
  // the same channel), git checkouts, IDE-external file managers, etc.
  //
  // Design notes:
  //   - We only react to `add` and `unlink`.  `change` does not alter tree
  //     structure (still the same names, same hierarchy) and reloading it
  //     would force a needless full re-fetch on every keystroke save.
  //   - We coalesce a 500 ms debounce window because bursty events are the
  //     common case (npm install, git checkout, build output) — without
  //     this, a 5k-file install would trigger thousands of full tree walks.
  //   - We call `refreshFileTreeSilent` (added alongside this hook) which
  //     intentionally does not set `isLoading: true`, so the user does not
  //     see the tree blink to "加载中..." every time anything outside the
  //     IDE writes a file.
  //   - Path filter: only react when the event's `workspacePath` matches
  //     the current `rootPath`, so leftover events from a previously open
  //     workspace cannot trigger refreshes against the new one.
  useEffect(() => {
    if (!rootPath) return
    const normRoot = normalizePath(rootPath)
    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false

    const unsub = onWorkspaceFileChanged((payload) => {
      if (disposed) return
      if (payload.changeType !== 'add' && payload.changeType !== 'unlink') return
      if (normalizePath(payload.workspacePath) !== normRoot) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void refreshFileTreeSilent()
      }, 500)
    })

    return () => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      unsub()
    }
  }, [rootPath, refreshFileTreeSilent])

  const renderContent = () => {
    switch (sidebarView) {
      case 'explorer':
        return (
          <div className="explorer-section">
            <div className="explorer-header">
              <span className="explorer-project-name">{rootName || t.sidebar.noFolderOpen}</span>
              <div className="explorer-actions">
                <button
                  className="sidebar-action-btn"
                  onClick={() => useFileTreeUIStore.getState().startNewFile('')}
                  title={t.sidebar.newFile}
                  disabled={!rootPath}
                >
                  <FilePlus size={15} />
                </button>
                <button
                  className="sidebar-action-btn"
                  onClick={() => useFileTreeUIStore.getState().startNewFolder('')}
                  title={t.sidebar.newFolder}
                  disabled={!rootPath}
                >
                  <FolderPlus size={15} />
                </button>
                <button
                  className="sidebar-action-btn"
                  onClick={() => {
                    if (!activePath) return
                    useFileTreeUIStore.getState().expandAncestors(activePath)
                    useFileTreeUIStore.getState().select(activePath)
                  }}
                  title={t.sidebar.revealActiveFile}
                  disabled={!activePath}
                >
                  <Crosshair size={15} />
                </button>
                <button
                  className="sidebar-action-btn"
                  onClick={() => useFileTreeUIStore.getState().collapseAll()}
                  title={t.sidebar.collapseAll}
                  disabled={!rootPath}
                >
                  <ListCollapse size={15} />
                </button>
                <button
                  className="sidebar-action-btn"
                  onClick={refreshFileTree}
                  title={t.sidebar.refresh}
                  disabled={!rootPath}
                >
                  <RefreshCw size={15} />
                </button>
                <button
                  className="sidebar-action-btn"
                  onClick={openWorkspace}
                  title={t.sidebar.openFolder}
                >
                  <FolderOpenIcon size={15} />
                </button>
              </div>
            </div>
            {rootPath && workspaceTrusted === false ? (
              <div className="workspace-trust-banner" role="status">
                <p className="workspace-trust-banner-text">
                  {t.sidebar.trustBannerText}
                </p>
                <button
                  type="button"
                  className="workspace-trust-banner-btn"
                  disabled={trustWorkspaceInFlight}
                  onClick={() => { void trustCurrentWorkspace() }}
                >
                  {trustWorkspaceInFlight ? t.sidebar.trustProcessing : t.sidebar.trustButton}
                </button>
              </div>
            ) : null}
            {isLoading ? (
              <div className="explorer-loading">{t.sidebar.loading}</div>
            ) : fileTree.length > 0 ? (
              <FileTree
                files={fileTree}
                onFileClick={handleFileClick}
                activePath={activePath}
                rootPath={rootPath}
              />
            ) : rootPath ? (
              <div className="explorer-empty">{t.sidebar.noFilesFound}</div>
            ) : (
              <div className="explorer-empty">
                <p>{t.sidebar.noFolderTitle}</p>
                <button className="explorer-open-btn" onClick={openWorkspace}>
                  {t.sidebar.openFolder}
                </button>
              </div>
            )}
          </div>
        )
      case 'search':
        return <SearchPanel />
      case 'git':
        return <GitPanel />
      case 'extensions':
        return <ExtensionsPlaceholder />
      default:
        return null
    }
  }

  return (
    <div className="sidebar" style={{ width: sidebarWidth }}>
      <div className="sidebar-header">
        <span className="sidebar-title">{sidebarTitles[sidebarView]}</span>
        <button className="sidebar-action-btn" onClick={newFile} title={t.sidebar.newFile}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 1z" />
          </svg>
        </button>
      </div>
      <div className="sidebar-content">{renderContent()}</div>
      <div
        className={`sidebar-resize-handle ${resizing ? 'active' : ''}`}
        onPointerDown={handlePointerDown}
      />
    </div>
  )
}

const ExtensionsPlaceholder: React.FC = () => {
  const t = useT()
  const setShowSettings = useSettingsStore((s) => s.setShowSettings)
  return (
    <div className="extensions-placeholder">
      <div className="extensions-placeholder-text">{t.sidebar.extPlaceholderTitle}</div>
      <div className="extensions-placeholder-sub">
        {t.sidebar.extPlaceholderSub}
      </div>
      <button
        type="button"
        className="explorer-open-btn"
        style={{ marginTop: 12 }}
        onClick={() => setShowSettings(true, 'mcp')}
      >
        {t.sidebar.openMcp}
      </button>
    </div>
  )
}
