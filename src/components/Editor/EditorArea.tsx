import React, { useCallback, useRef, useEffect, useState, useMemo } from 'react'
import type * as monaco from 'monaco-editor'
import Editor from '@monaco-editor/react'
import { monacoReadyPromise, useMonacoReady } from '../../configureMonaco'
import { TabBar } from './TabBar'
import { Breadcrumb } from './Breadcrumb'
import { DiffEditorView } from './DiffEditorView'
import { InlineDiffController } from './InlineDiffController'
import { FilePreview, shouldPreviewInsteadOfEdit } from './FilePreview'
import { OfficeLivePreview } from './OfficeLivePreview'
import { PdfLivePreview } from './PdfLivePreview'
import { ImageLivePreview } from './ImageLivePreview'
import { isImageViewExt } from '../../services/openBehavior'
import { HtmlPreview } from './HtmlPreview'
import { InlineEditController } from './InlineEdit/InlineEditController'
import { findTabForWorkspacePath, useFileStore } from '../../stores/useFileStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { readFile, writeFile, saveFileDialog } from '../../services/fileSystem'
import { decideAutoSave } from './autoSaveConflict'
import { reportUserActionError } from '../../utils/reportUserActionError'
import { toWorkspaceAbsoluteFilePath, normalizePath, toRelativePath } from '../../services/pathUtils'
import { resolveLanguageForPath } from '../../stores/chat/diffPreviewBridge'
import { useConfirmDialog } from '../common/ConfirmDialog'
import { GitBranch, PenLine, Eye, Columns } from 'lucide-react'
import { MarkdownPreview } from '../Layout/MarkdownPreview'
import { PlanTabApprovalBanner } from './PlanTabApprovalBanner'
import { isPlanTabName, stripFrontmatter } from '../../services/planTab'
import { setVisibleStartLine } from '../../stores/editorScrollSync'
import { registerTabCompletionProvider, unregisterTabCompletionProvider } from '../../services/tabAutocompleteProvider'
import { initMonacoDiagnostics } from '../../services/monacoDiagnostics'
import { applyWorkspaceTsConfigToMonaco } from '../../services/monacoWorkspaceTsConfig'
import { notifyLspDocumentSave } from '../../services/lspDocumentSync'
import { focusEditorIfIdle } from '../../services/editorFocusGuard'
import { isInlineDiffDecoratorEditInFlight } from './InlineDiffDecorator'
import { useResolvedEditorTheme } from '../../hooks/useResolvedEditorTheme'
import './EditorArea.css'
// Welcome-screen styles live in their own file (single source of truth).
// EditorArea has its own inline welcome JSX fallback path, so it must
// also bring in `EditorWelcome.css` to render that fallback correctly.
import './EditorWelcome.css'
import { RECENT_PROJECTS_CHANGED_EVENT, RECENT_PROJECTS_STORAGE_KEY } from '../../constants/recentProjects'
import { readRecentProjectsFromStorage } from '../../services/recentProjectsPersistence'

/** docx / xlsx 走 OfficeLivePreview(原格式渲染);pdf 走 PdfLivePreview
 *  (Chromium 内置 PDFium 查看器);其它需要预览的扩展名
 *  (pptx/legacy doc-xls/ipynb/rtf)继续走 FilePreview。 */
function isOfficeLiveExt(fileName: string): boolean {
  const i = fileName.lastIndexOf('.')
  if (i < 0) return false
  const ext = fileName.slice(i + 1).toLowerCase()
  return ext === 'docx' || ext === 'xlsx'
}

function isPdfExt(fileName: string): boolean {
  const i = fileName.lastIndexOf('.')
  return i >= 0 && fileName.slice(i + 1).toLowerCase() === 'pdf'
}

function getExt(fileName: string): string {
  const i = fileName.lastIndexOf('.')
  return i < 0 ? '' : fileName.slice(i + 1).toLowerCase()
}

/** SVG 不依赖 monaco language(可能是 xml / plaintext),严格按扩展名识别。 */
function isSvgFileName(fileName: string): boolean {
  return getExt(fileName) === 'svg'
}

function isHtmlOrSvgTab(fileName: string, language: string): boolean {
  return language === 'html' || isSvgFileName(fileName)
}

function resolvePreviewKind(language: string, fileName: string): 'markdown' | 'html' | 'svg' | null {
  if (language === 'markdown') return 'markdown'
  if (isSvgFileName(fileName)) return 'svg'
  if (language === 'html') return 'html'
  return null
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

export const EditorArea: React.FC = () => {
  const { tabs, activeTabId, setActiveTab, updateTabContent, setCursorPosition, pendingChanges, pendingJump, clearPendingJump } = useFileStore()
  const { rootPath, setWorkspace } = useWorkspaceStore()
  /** Bumps when `recentProjects` changes (other windows/tabs or same-tab sync). */
  const [recentProjectsRev, setRecentProjectsRev] = useState(0)
  const editorTheme = useResolvedEditorTheme()
  const tabAutocompleteEnabled = useSettingsStore((state) => state.tabAutocompleteEnabled)
  const inlineDiffsEnabled = useSettingsStore((state) => state.inlineDiffsEnabled)
  const defaultDiffViewMode = useSettingsStore((state) => state.defaultDiffViewMode)
  const {
    sidebarVisible,
    sidebarWidth,
    aiChatVisible,
    aiChatWidth,
    terminalVisible,
    terminalHeight,
    composerVisible,
  } = useLayoutStore()
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [editorInstance, setEditorInstance] = useState<monaco.editor.IStandaloneCodeEditor | null>(null)
  // Gate `<Editor>` mount: @monaco-editor/react calls `loader.init()` on mount.
  // If our `loader.config({ monaco })` hasn't completed yet (async chunk load),
  // init falls back to CDN (jsdelivr), which CSP `script-src 'self'` blocks.
  const monacoReady = useMonacoReady()
  const [diffViewOverride, setDiffViewOverride] = useState<'inline' | 'side-by-side' | null>(null)
  const diffViewMode: 'inline' | 'side-by-side' =
    diffViewOverride
    ?? (defaultDiffViewMode === 'side-by-side' || !inlineDiffsEnabled ? 'side-by-side' : 'inline')
  const [inlineEditActive, setInlineEditActive] = useState(false)
  // Sprint 9.2+: Markdown 查看模式。仅当 active tab 是 .md/.markdown/.mdx
  // 时显示切换 toolbar;其它文件该 state 存在但无 UI 体现。
  // 注意:切 tab 时保持上一个 tab 的模式(用户切回来体验一致);如果用户
  // 从非 md 切到 md,仍用默认 'edit'(第一次看到此文件时)—— 简化:
  // 我们保持一个全局 mode,跨 tab 共享。写作场景下用户倾向固定一个
  // 偏好(例如一直用 split),跨 tab 共享更符合直觉。
  const [mdViewMode, setMdViewMode] = useState<'edit' | 'preview' | 'split'>('edit')
  // HTML / SVG 查看模式与 Markdown 同构,但状态独立 —— 用户通常对
  // markdown 和 markup 类文件有不同偏好(.md 习惯写作时分屏,.html /
  // .svg 习惯仅预览看效果)。HTML 与 SVG 走同一条 iframe 管线,共享
  // 一个 state 即可,无需再细分。
  const [htmlViewMode, setHtmlViewMode] = useState<'edit' | 'preview' | 'split'>('edit')
  // Plan markdown tabs (`*.plan.md`) default to rendered preview so the user
  // sees the formatted plan + live progress, not the raw source with HTML
  // comment markers. Kept separate from `mdViewMode` so it doesn't leak the
  // "preview" preference onto ordinary markdown files.
  const [planViewMode, setPlanViewMode] = useState<'edit' | 'preview' | 'split'>('preview')

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeTabIsPlan = activeTab ? isPlanTabName(activeTab.name) : false

  // Resolve the full file path for the active tab
  const activeTabFullPath = activeTab && rootPath
    ? toWorkspaceAbsoluteFilePath(activeTab.path, rootPath)
    : null

  /** Only show inline diff when the active tab is the same file as a pending change (avoids Map key / path-shape mismatches). */
  const activePendingChange = React.useMemo(() => {
    if (!activeTab || pendingChanges.size === 0) return undefined
    for (const change of pendingChanges.values()) {
      if (findTabForWorkspacePath([activeTab], change.filePath, rootPath)) {
        return change
      }
    }
    return undefined
  }, [activeTab, pendingChanges, rootPath])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === RECENT_PROJECTS_STORAGE_KEY || e.key === null) {
        setRecentProjectsRev((n) => n + 1)
      }
    }
    const onLocal = () => setRecentProjectsRev((n) => n + 1)
    window.addEventListener('storage', onStorage)
    window.addEventListener(RECENT_PROJECTS_CHANGED_EVENT, onLocal)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(RECENT_PROJECTS_CHANGED_EVENT, onLocal)
    }
  }, [])

  // `readRecentProjectsFromStorage()` is the actual data source (localStorage); the deps
  // here are **invalidation triggers** rather than function inputs:
  //   - `rootPath` changes → the list may need re-read because the user just switched
  //     workspaces (which is what bumps the most-recent slot).
  //   - `recentProjectsRev` is a counter bumped by the storage / custom-event listeners
  //     above when the localStorage entry changes (e.g. another window's update).
  /* eslint-disable react-hooks/exhaustive-deps -- intentional invalidation deps */
  const recentProjectsList = useMemo(
    () => readRecentProjectsFromStorage(),
    [rootPath, recentProjectsRev],
  )
  /* eslint-enable react-hooks/exhaustive-deps */

  // Cleanup tab completion provider on unmount
  useEffect(() => {
    return () => {
      unregisterTabCompletionProvider()
    }
  }, [])

  // Dispose Monaco models for closed tabs to prevent memory leaks.
  useEffect(() => {
    if (!editorInstance) return
    monacoReadyPromise.then((monacoApi) => {
      const m = monacoApi as typeof import('monaco-editor')
      const openPaths = new Set(
        tabs.map((t) => {
          if (rootPath) return toWorkspaceAbsoluteFilePath(t.path, rootPath)
          return t.path
        })
      )
      for (const model of m.editor.getModels()) {
        const modelPath = model.uri.path.replace(/\\/g, '/')
        if (model.uri.scheme === 'file' && !openPaths.has(modelPath)) {
          model.dispose()
        }
      }
    }).catch(() => {})
    // Intentional: `tabs.length` is used as a proxy for "the set of open tabs changed".
    // Including the full `tabs` array would re-fire this cleanup on every tab CONTENT
    // edit (since Zustand returns a new array reference on every store change), which
    // would dispose Monaco models for files the user is actively editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.length, editorInstance, rootPath])

  // Auto-save: debounce write to disk when buffer is dirty (1.5 s after last edit).
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!activeTab?.isModified || !rootPath) return
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null
      const {
        tabs: latestTabs,
        activeTabId: latestId,
        markTabSaved,
        pendingChanges: latestPending,
      } = useFileStore.getState()
      const currentRoot = useWorkspaceStore.getState().rootPath
      const tab = latestTabs.find((t) => t.id === latestId)
      if (!tab || !tab.isModified || !currentRoot || tab.path.startsWith('untitled')) return
      // Hard stop for the "autosave flushed unapproved diff content to disk"
      // class of bug: if the active tab is a target of an in-flight diff
      // approval, its buffer may have been transiently driven by
      // InlineDiffDecorator (or arrive dirty for any other reason); writing
      // it now would bypass the approval UI and — worse — may overwrite a
      // completely unrelated file when the user just happened to be viewing
      // a different tab when the diff attached. Rely on the explicit
      // accept/reject handlers to persist content.
      const tabHasPendingDiff = Array.from(latestPending.values()).some((pc) =>
        findTabForWorkspacePath([tab], pc.filePath, currentRoot) !== undefined,
      )
      if (tabHasPendingDiff) return
      // Resolve the save target using the path-aware helper so a tab whose
      // `path` is ALREADY absolute (e.g. opened via the OS file picker from
      // outside the workspace) doesn't get silently double-joined with the
      // workspace root — a naive `${root}/${tab.path}` produced garbled
      // paths like `C:\ws\C:\Users\...\session-memory` and exploded in
      // mkdir on Windows because `:` mid-path is illegal.
      const fullPath = toWorkspaceAbsoluteFilePath(tab.path, currentRoot)
      // Skip autosave for files outside the workspace root. The IPC
      // `fs:write-file` handler enforces a workspace sandbox and returns
      // "Path is outside the opened workspace" for paths under e.g.
      // `~/.claude/session-memory/*.md` (会话笔记智能体) or any file the
      // user opened via OS file picker outside the project. Letting
      // autosave fire every 1.5 s for those tabs spams DevTools with the
      // same error; the keep-dirty dot already signals "not on disk", and
      // explicit Ctrl+S still surfaces the real failure to the user.
      const fullPathNorm = normalizePath(fullPath)
      const rootNorm = normalizePath(currentRoot)
      const rootPrefix = rootNorm.endsWith('/') ? rootNorm : `${rootNorm}/`
      if (fullPathNorm !== rootNorm && !fullPathNorm.startsWith(rootPrefix)) {
        return
      }
      // Conflict guard: before clobbering the file, read what is CURRENTLY on
      // disk and compare against the buffer + this tab's last-known baseline.
      // If an external writer (most often an AI `edit_file`) changed the file
      // since our baseline, autosaving the stale buffer would silently destroy
      // that write — and the backend's read-before-edit gate would then reject
      // the AI's next edit with "...mtime changed. Call read_file again before
      // editing or writing." We skip the write in that case and keep the tab
      // dirty (the user can still resolve via explicit Ctrl+S).
      void (async () => {
        let diskContent: string | null = null
        try {
          diskContent = await readFile(fullPath)
        } catch {
          // File missing / unreadable (e.g. brand-new untitled-derived path):
          // no on-disk version to conflict with — fall through to a plain write.
          diskContent = null
        }
        if (diskContent !== null) {
          const decision = decideAutoSave({
            bufferContent: tab.content,
            diskContent,
            baselineContent: tab.diskContent,
          })
          if (decision === 'conflict') {
            // Preserve the external (AI) write. Leave the tab dirty as the
            // visual cue; do not clobber.
            return
          }
          if (decision === 'in-sync') {
            // Disk already matches the buffer — just clear the dirty flag and
            // refresh the baseline; no write needed.
            markTabSaved(tab.id, diskContent)
            return
          }
        }
        try {
          await writeFile(fullPath, tab.content)
          markTabSaved(tab.id, tab.content)
          notifyLspDocumentSave(fullPath)
        } catch (error) {
          // Autosave happens on a timer; an alert here would spam the user, so
          // we log silently. The tab keeps its "modified" dot because
          // `markTabSaved` never ran — that alone is the visual cue that
          // autosave failed. DevTools now carries the real reason.
          reportUserActionError('自动保存文件', error, { silent: true })
        }
      })()
    }, 1500)
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
    }
  }, [activeTab?.isModified, activeTab?.content, rootPath])

  const handleOpenRecentProject = (project: string) => {
    setWorkspace(project)
  }

  // Closing a dirty tab silently discards the buffer (untitled tabs are never
  // autosaved; workspace tabs can be dirty inside the 1.5 s autosave window
  // or after an autosave conflict). Gate the close behind a confirm dialog.
  const { dialog: closeTabConfirmDialog, askConfirm: askCloseTabConfirm } = useConfirmDialog()
  const handleCloseTab = useCallback(async (tabId: string) => {
    const tab = useFileStore.getState().tabs.find((t) => t.id === tabId)
    if (tab?.isModified) {
      const ok = await askCloseTabConfirm({
        title: '关闭标签页',
        message: `“${tab.name}” 有未保存的更改,关闭后这些更改将丢失。`,
        confirmText: '不保存并关闭',
        cancelText: '取消',
        variant: 'danger',
      })
      if (!ok) return
    }
    useFileStore.getState().closeTab(tabId)
  }, [askCloseTabConfirm])

  const saveActiveTabToDisk = useCallback(async () => {
    const { tabs, activeTabId, markTabSaved, retargetTabAfterSaveAs } = useFileStore.getState()
    const currentRoot = useWorkspaceStore.getState().rootPath
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return

    // Untitled tabs have no disk identity yet — writing `untitled-N` verbatim
    // would either fail the sandbox or drop an extension-less junk file in
    // the workspace root. Route through the native "Save As" dialog instead.
    if (tab.path.startsWith('untitled')) {
      try {
        const target = await saveFileDialog({
          title: '另存为',
          defaultPath: currentRoot ? `${currentRoot}/${tab.name}` : tab.name,
        })
        if (!target) return
        const targetUnix = target.replace(/\\/g, '/')
        await writeFile(targetUnix, tab.content)
        const name = targetUnix.split('/').pop() || tab.name
        retargetTabAfterSaveAs(tab.id, {
          path: currentRoot ? toRelativePath(targetUnix, currentRoot) : targetUnix,
          name,
          language: resolveLanguageForPath(name),
        })
        notifyLspDocumentSave(targetUnix)
      } catch (error) {
        reportUserActionError('另存为文件', error)
      }
      return
    }

    if (!currentRoot) return
    const fullPath = toWorkspaceAbsoluteFilePath(tab.path, currentRoot)
    try {
      await writeFile(fullPath, tab.content)
      markTabSaved(tab.id)
      notifyLspDocumentSave(fullPath)
    } catch (error) {
      // Interactive save (Ctrl+S / menu) — alert so the user knows their
      // data didn't land on disk instead of continuing to think it did.
      reportUserActionError('保存文件', error)
    }
  }, [])

  const handleBeforeMount = useCallback((monacoInstance: typeof import('monaco-editor')) => {
    initMonacoDiagnostics(monacoInstance as typeof monaco)
  }, [])

  useEffect(() => {
    void monacoReadyPromise.then((m) => {
      void applyWorkspaceTsConfigToMonaco(m as typeof monaco, rootPath ?? null)
    })
  }, [rootPath])

  const handleEditorMount = useCallback((editor: monaco.editor.IStandaloneCodeEditor) => {
    editorRef.current = editor
    setEditorInstance(editor)
    editor.onDidChangeCursorPosition((e: monaco.editor.ICursorPositionChangedEvent) => {
      setCursorPosition(e.position.lineNumber, e.position.column)
    })
    // Sprint 9.2+: 广播 Monaco 视口起始行。OutlineSidebar / MarkdownPreview
    // 据此同步高亮与滚动。`getVisibleRanges()[0].startLineNumber` 是即时的;
    // rAF throttle 在 store 里统一做,这里直接调即可。
    editor.onDidScrollChange(() => {
      const ranges = editor.getVisibleRanges()
      if (ranges.length === 0) return
      const first = ranges[0]
      if (!first) return
      const tabId = useFileStore.getState().activeTabId
      setVisibleStartLine(tabId, first.startLineNumber)
    })
    // onMount runs once per Monaco instance; `run` must read store — not a hook closure — or Ctrl+S saves the wrong tab after switching tabs.
    editor.addAction({
      id: 'save-file',
      label: '保存文件',
      keybindings: [2048 | 49], // Ctrl+S
      run: () => {
        void saveActiveTabToDisk()
      },
    })
  }, [saveActiveTabToDisk, setCursorPosition])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    if (tabAutocompleteEnabled) {
      monacoReadyPromise.then((monacoInstance) => {
        registerTabCompletionProvider(editor, monacoInstance as typeof monaco, { enabled: true })
      }).catch(() => {
        console.warn('[EditorArea] Failed to init Monaco for tab completion')
      })
    } else {
      unregisterTabCompletionProvider()
    }
  }, [tabAutocompleteEnabled, editorInstance])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    const relayoutEditor = () => {
      window.requestAnimationFrame(() => {
        editor.layout()
      })
    }

    relayoutEditor()

    const handleWindowResize = () => relayoutEditor()
    const handleWindowFocus = () => relayoutEditor()
    const handleZoomChanged = () => relayoutEditor()
    const handleVisibilityChange = () => {
      if (!document.hidden) relayoutEditor()
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
    editorInstance,
    activeTabId,
    editorTheme,
    rootPath,
    diffViewMode,
    sidebarVisible,
    sidebarWidth,
    aiChatVisible,
    aiChatWidth,
    terminalVisible,
    terminalHeight,
    composerVisible,
  ])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !activeTabId) return
    if (activePendingChange && diffViewMode === 'side-by-side') return

    let frameId = 0
    frameId = window.requestAnimationFrame(() => {
      // This effect fires both on user-initiated tab switches AND on AI-driven
      // `activePendingChange` transitions (diff attach / accept / reject). In
      // the latter case the user is often still typing into a different input
      // — Settings → Rules panel, chat composer, command palette, … — and
      // yanking focus to the editor routes their next keystrokes into the
      // wrong file. The guard is a no-op when nothing else owns focus.
      focusEditorIfIdle(editor)
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [activeTabId, activePendingChange, diffViewMode])

  // Drive Monaco cursor jump from pendingJump (e.g. Problems panel click)
  useEffect(() => {
    if (!pendingJump || !editorRef.current) return
    const { line, column } = pendingJump
    const editor = editorRef.current
    // Save the handle so unmount / next-effect cleanup can cancel a
    // still-pending jump. Without this the timer fires against a stale
    // editor reference if the user navigates away within the 60ms window.
    const handle = setTimeout(() => {
      editor.setPosition({ lineNumber: line, column })
      editor.revealLineInCenter(line)
      // Same rationale as the tab-switch effect above: the jump request is
      // queued via state and delivered after a 60ms relayout window, during
      // which the user may have clicked into a different text input. Move
      // the caret + scroll unconditionally (so the target line is ready),
      // but only steal focus when nothing interactive owns it.
      focusEditorIfIdle(editor)
    }, 60)
    clearPendingJump()
    return () => clearTimeout(handle)
  }, [pendingJump, activeTabId, clearPendingJump])

  useEffect(() => {
    const handler = (e: Event) => {
      const { actionId } = (e as CustomEvent).detail
      const editor = editorRef.current
      if (!editor) return

      editor.focus()

      // Monaco 0.53 把 `undo` / `redo` 注册成 MultiCommand：经由
      // `editor.trigger(_, 'undo', null)` 路由到 commandService 后，
      // 它会按优先级匹配实现。priority-1000 的 `generic-dom-input-textarea`
      // 会在 activeElement 是任意可编辑元素时调用 `document.execCommand('undo')`
      // —— 而 execCommand 对 Monaco 这种"隐藏 textarea + 自己维护内容"的
      // 编辑器是个无声的 no-op，导致菜单点击没反应。直接走模型 API
      // 跳过这套优先级竞争。
      if (actionId === 'undo') {
        editor.getModel()?.undo()
        return
      }
      if (actionId === 'redo') {
        editor.getModel()?.redo()
        return
      }

      // Paste 需要特殊处理：浏览器不允许程序化读取剪贴板
      if (actionId === 'editor.action.clipboardPasteAction') {
        navigator.clipboard.readText().then((text) => {
          if (text) {
            editor.executeEdits('clipboard', [{
              range: editor.getSelection()!,
              text,
              forceMoveMarkers: true,
            }])
          }
        }).catch(() => {
          editor.trigger('keyboard', 'editor.action.clipboardPasteAction', null)
        })
        return
      }

      editor.trigger('menu', actionId, null)
    }
    document.addEventListener('editor:action', handler)
    return () => document.removeEventListener('editor:action', handler)
  }, [])

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (!activeTabId || value === undefined) return
    // Hard guard: when `InlineDiffDecorator` is in the middle of a
    // programmatic `setValue` / `applyEdits` (initial preview, accept/reject
    // hunk, rejectAll, dispose revert, …), Monaco still fires
    // `onDidChangeContent` → our `onChange` prop. Without this bail-out the
    // decorator's content swap was mis-attributed to the user:
    // `updateTabContent` flipped the *current* tab to `isModified: true`
    // with the unapproved diff payload in its buffer, and 1.5s later the
    // autosave timer wrote that payload to disk under the tab's own path —
    // overwriting an unrelated file the user just happened to have active
    // when the diff preview attached.
    if (isInlineDiffDecoratorEditInFlight()) return
    // Guard against ghost onChange events where value already matches the
    // store buffer (e.g. programmatic setValue done elsewhere, or the
    // legacy accept/deny sync in InlineDiffController before this hard
    // guard existed). Real user edits always produce a genuine diff.
    const currentTab = useFileStore.getState().tabs.find((t) => t.id === activeTabId)
    if (currentTab && currentTab.content === value) return
    updateTabContent(activeTabId, value)
  }, [activeTabId, updateTabContent])

  // When the store buffer changes without going through Monaco (e.g. disk sync, accept/reject),
  // push the new text into the active model so the editor never shows stale content.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !activeTab) return
    if (activePendingChange && diffViewMode === 'inline') return

    const model = editor.getModel()
    if (!model) return
    if (model.getValue() === activeTab.content) return

    editor.executeEdits('sync-tab-from-store', [
      { range: model.getFullModelRange(), text: activeTab.content, forceMoveMarkers: true },
    ])
    const position = editor.getPosition()
    if (position) {
      setCursorPosition(position.lineNumber, position.column)
    }
    // Intentionally narrow deps to `?.content` and `?.id` instead of the whole `activeTab`
    // object — the latter would re-fire this sync on every Zustand transition that touches
    // unrelated tab metadata (modified flag, language, etc.), causing redundant
    // `executeEdits` calls and cursor flicker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.content, activeTab?.id, activePendingChange, diffViewMode, setCursorPosition])

  return (
    <div className="editor-area" onKeyDown={(e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void saveActiveTabToDisk()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k' && !activePendingChange) {
        e.preventDefault()
        if (editorInstance) setInlineEditActive(true)
      }
    }}>
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTab}
        onCloseTab={handleCloseTab}
      />
      {closeTabConfirmDialog}
      {activeTab ? (
        <>
          <Breadcrumb path={activeTab.path} fileName={activeTab.name} />
          {activeTabIsPlan && <PlanTabApprovalBanner />}
          {activePendingChange && (
            <InlineDiffController
              pendingChange={activePendingChange}
              editor={editorInstance}
              diffViewMode={diffViewMode}
              onDiffViewModeChange={(mode) =>
                setDiffViewOverride(!inlineDiffsEnabled && mode === 'inline' ? 'side-by-side' : mode)
              }
              inlineModeEnabled={inlineDiffsEnabled}
            />
          )}

          {isImageViewExt(activeTab.name) && !activePendingChange ? (
            // 图片 → 专用查看器(readFileBinary → blob URL),不进 Monaco。
            // 2026-07 审计修复:此前图片被 UTF-8 读成乱码塞进编辑器。
            <ImageLivePreview
              key={activeTab.id}
              filePath={activeTabFullPath || activeTab.path}
              fileName={activeTab.name}
            />
          ) : shouldPreviewInsteadOfEdit(activeTab.name) && !activePendingChange ? (
            isOfficeLiveExt(activeTab.name) ? (
              // .docx / .xlsx → 保真预览(docx-preview / exceljs),保留字体、
              // 段落、颜色、表格、合并单元格、边框、背景色 —— 尽量贴近在
              // Office 里打开的视觉效果。
              <OfficeLivePreview
                key={activeTab.id}
                filePath={activeTabFullPath || activeTab.path}
                fileName={activeTab.name}
              />
            ) : isPdfExt(activeTab.name) ? (
              // .pdf → Chromium 内置 PDFium 查看器(blob: iframe),原生
              // 翻页/缩放/搜索体验;扫描件与文本版一致,不走解析管道。
              <PdfLivePreview
                key={activeTab.id}
                filePath={activeTabFullPath || activeTab.path}
                fileName={activeTab.name}
              />
            ) : (
              // pptx / legacy doc-xls-ppt / ipynb / rtf → 继续走
              // attachment ingest 管道(mammoth/SheetJS/LibreOffice)。
              <FilePreview
                key={activeTab.id}
                filePath={activeTabFullPath || activeTab.path}
                fileName={activeTab.name}
              />
            )
          ) : activePendingChange && diffViewMode === 'side-by-side' ? (
            <DiffEditorView
              change={activePendingChange}
              language={activeTab.language}
            />
          ) : (
            <PreviewableEditorContainer
              previewKind={resolvePreviewKind(activeTab.language, activeTab.name)}
              viewMode={
                isHtmlOrSvgTab(activeTab.name, activeTab.language)
                  ? htmlViewMode
                  : activeTabIsPlan
                    ? planViewMode
                    : mdViewMode
              }
              onChangeViewMode={
                isHtmlOrSvgTab(activeTab.name, activeTab.language)
                  ? setHtmlViewMode
                  : activeTabIsPlan
                    ? setPlanViewMode
                    : setMdViewMode
              }
              previewContent={
                activeTabIsPlan
                  ? stripFrontmatter(activeTab.content ?? '')
                  : (activeTab.content ?? '')
              }
            >
              {inlineEditActive && editorInstance && (
                <InlineEditController
                  editor={editorInstance}
                  onClose={() => setInlineEditActive(false)}
                />
              )}
              {/* 勿用 activeTab.id 作为 key：切 tab 会卸载 Monaco，@monaco-editor/react 会反复显示默认 Loading… */}
              {!monacoReady ? (
                <div className="editor-loading" style={{ padding: 16, opacity: 0.6, fontSize: 13 }}>
                  Loading editor…
                </div>
              ) : (
              <Editor
                key="workspace-monaco-editor"
                language={langMap[activeTab.language] || 'plaintext'}
                value={activeTab.content}
                path={activeTabFullPath || activeTab.path}
                theme={editorTheme}
                beforeMount={handleBeforeMount}
                onMount={handleEditorMount}
                onChange={handleEditorChange}
                options={{
                  fontSize: 13,
                  fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
                  fontLigatures: true,
                  lineHeight: 20,
                  minimap: { enabled: true, scale: 1, showSlider: 'mouseover' },
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  cursorBlinking: 'smooth',
                  cursorSmoothCaretAnimation: 'on',
                  renderLineHighlight: 'all',
                  renderWhitespace: 'selection',
                  bracketPairColorization: { enabled: true },
                  guides: { bracketPairs: true },
                  padding: { top: 8 },
                  wordWrap: 'off',
                  glyphMargin: true,
                  automaticLayout: true,
                  readOnly: false,
                  scrollbar: {
                    verticalScrollbarSize: 8,
                    horizontalScrollbarSize: 8,
                  },
                }}
              />
              )}
            </PreviewableEditorContainer>
          )}
        </>
      ) : (
        <div className="editor-welcome">
          <div className="welcome-content">
            <h2 className="welcome-title">星构Astra</h2>
            <p className="welcome-subtitle">星构Astra工作台</p>
            <div className="welcome-shortcuts">
              <div className="shortcut-item">
                <kbd>Ctrl</kbd>+<kbd>L</kbd>
                <span>打开 AI 对话</span>
              </div>
              <div className="shortcut-item">
                <kbd>Ctrl</kbd>+<kbd>B</kbd>
                <span>切换侧边栏</span>
              </div>
              <div className="shortcut-item">
                <kbd>Ctrl</kbd>+<kbd>J</kbd>
                <span>切换终端</span>
              </div>
              <div className="shortcut-item">
                <kbd>Ctrl</kbd>+<kbd>K</kbd>
                <span>命令面板</span>
              </div>
            </div>
            <div className="welcome-recent">
              <div className="welcome-recent-header">
                <GitBranch size={14} />
                <span>最近的项目</span>
              </div>
              {recentProjectsList.length > 0 ? (
                recentProjectsList.map((project) => (
                  <div
                    key={project}
                    className="welcome-recent-item"
                    onClick={() => handleOpenRecentProject(project)}
                    title={project}
                  >
                    {project.split(/[/\\]/).pop() || project}
                  </div>
                ))
              ) : (
                <div className="welcome-recent-item" style={{ opacity: 0.5 }}>
                  暂无最近的项目
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Markdown / HTML 感知的编辑器容器 ─────────────────────────────
//
// 当 previewKind 为 'markdown' 或 'html' 时显示查看模式 toolbar,并按
// 当前模式决定是否渲染 Monaco / Preview / 分屏。对其它语言,退化为
// 原有 `<div className="editor-container">` —— 行为完全不变,零风险。
//
// split 模式:Monaco 占左半,Preview 占右半;共享同一个 activeTab.content。
// preview 模式:Monaco 完全不渲染(节约内存、避免双份光标),只剩预览。

type PreviewKind = 'markdown' | 'html' | 'svg' | null

interface PreviewableEditorContainerProps {
  previewKind: PreviewKind
  viewMode: 'edit' | 'preview' | 'split'
  onChangeViewMode: (mode: 'edit' | 'preview' | 'split') => void
  previewContent: string
  children: React.ReactNode
}

// split 模式下的分隔比例;localStorage 持久化。Markdown 与 HTML 共用
// 同一个 key —— 用户对"编辑/预览左右比例"的偏好通常是布局习惯,
// 不依赖文件类型。
const MD_SPLIT_RATIO_KEY = 'astra:md-split-ratio'
const MD_SPLIT_MIN = 0.15
const MD_SPLIT_MAX = 0.85

function readInitialSplitRatio(): number {
  try {
    const raw = localStorage.getItem(MD_SPLIT_RATIO_KEY)
    if (!raw) return 0.5
    const n = Number(raw)
    if (!Number.isFinite(n)) return 0.5
    return Math.min(MD_SPLIT_MAX, Math.max(MD_SPLIT_MIN, n))
  } catch {
    return 0.5
  }
}

const PreviewableEditorContainer: React.FC<PreviewableEditorContainerProps> = ({
  previewKind,
  viewMode,
  onChangeViewMode,
  previewContent,
  children,
}) => {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [splitRatio, setSplitRatio] = useState<number>(readInitialSplitRatio)
  const draggingRef = useRef<boolean>(false)

  // mousemove / mouseup 在 document 上监听 —— 用户鼠标滑出 handle
  // 也能跟上;mouseup 一定能收到。
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return
      const body = bodyRef.current
      if (!body) return
      const rect = body.getBoundingClientRect()
      if (rect.width <= 0) return
      const raw = (e.clientX - rect.left) / rect.width
      const clamped = Math.min(MD_SPLIT_MAX, Math.max(MD_SPLIT_MIN, raw))
      setSplitRatio(clamped)
    }
    const onUp = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try {
        localStorage.setItem(MD_SPLIT_RATIO_KEY, String(splitRatio))
      } catch {
        /* 私有模式 / 配额满等 —— 静默退化,不影响当前会话 */
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [splitRatio])

  if (!previewKind) {
    // 非 markdown / 非 html:保持原来的 `.editor-container` 结构,零行为变更
    return (
      <div className="editor-container" style={{ position: 'relative' }}>
        {children}
      </div>
    )
  }

  const showEditor = viewMode !== 'preview'
  const showPreview = viewMode === 'preview' || viewMode === 'split'
  const isSplit = viewMode === 'split'

  // split:按 ratio 分配;preview/edit:占满
  const editorFlex = isSplit ? `0 0 ${splitRatio * 100}%` : '1 1 auto'

  const onHandleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    // 全局 cursor/userSelect:拖动时鼠标跨元素仍是 col-resize;阻止文本选中
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const onHandleDoubleClick = () => {
    // 快捷:双击重置回 50/50
    setSplitRatio(0.5)
    try {
      localStorage.setItem(MD_SPLIT_RATIO_KEY, '0.5')
    } catch {
      /* ignore */
    }
  }

  const containerKindClass =
    previewKind === 'markdown'
      ? 'editor-container-md'
      : previewKind === 'svg'
        ? 'editor-container-svg'
        : 'editor-container-html'
  const toolbarLabel =
    previewKind === 'markdown'
      ? 'Markdown 查看模式'
      : previewKind === 'svg'
        ? 'SVG 查看模式'
        : 'HTML 查看模式'

  return (
    <div
      className={`editor-container ${containerKindClass} md-view-${viewMode}`}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}
    >
      <MdViewToolbar mode={viewMode} onChange={onChangeViewMode} kindLabel={toolbarLabel} />
      <div
        ref={bodyRef}
        className="editor-container-body"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'row',
          minHeight: 0,
          position: 'relative',
        }}
      >
        {showEditor ? (
          <div
            className="editor-container-monaco"
            style={{ flex: editorFlex, position: 'relative', minWidth: 0 }}
          >
            {children}
          </div>
        ) : null}
        {isSplit ? (
          <div
            className="md-split-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="编辑与预览分隔条(拖动调整宽度,双击重置)"
            tabIndex={-1}
            onMouseDown={onHandleMouseDown}
            onDoubleClick={onHandleDoubleClick}
          />
        ) : null}
        {showPreview ? (
          previewKind === 'markdown' ? (
            <MarkdownPreview
              content={previewContent}
              className={isSplit ? 'markdown-preview-split' : ''}
              syncWithEditor={isSplit}
            />
          ) : (
            <HtmlPreview
              content={previewContent}
              className={isSplit ? 'html-preview-split' : ''}
              asSvg={previewKind === 'svg'}
            />
          )
        ) : null}
      </div>
    </div>
  )
}

const MdViewToolbar: React.FC<{
  mode: 'edit' | 'preview' | 'split'
  onChange: (mode: 'edit' | 'preview' | 'split') => void
  kindLabel: string
}> = ({ mode, onChange, kindLabel }) => {
  return (
    <div className="md-view-toolbar" role="toolbar" aria-label={kindLabel}>
      <button
        type="button"
        className={`md-view-btn${mode === 'edit' ? ' is-active' : ''}`}
        onClick={() => onChange('edit')}
        title="仅编辑"
      >
        <PenLine size={12} /> 编辑
      </button>
      <button
        type="button"
        className={`md-view-btn${mode === 'split' ? ' is-active' : ''}`}
        onClick={() => onChange('split')}
        title="编辑 + 预览 分屏"
      >
        <Columns size={12} /> 分屏
      </button>
      <button
        type="button"
        className={`md-view-btn${mode === 'preview' ? ' is-active' : ''}`}
        onClick={() => onChange('preview')}
        title="仅预览"
      >
        <Eye size={12} /> 预览
      </button>
    </div>
  )
}
