import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { FixedSizeList } from 'react-window'
import type { FileNode } from '../../types'
import { useChatStore } from '../../stores/useChatStore'
import { useFileStore } from '../../stores/useFileStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import {
  useFileTreeUIStore,
} from '../../stores/useFileTreeUIStore'
import {
  copyFileBinary,
  createDir,
  deleteFile,
  renameInWorkspace,
  writeFile,
} from '../../services/fileSystem'
import {
  joinWorkspaceRelative,
  normalizePath,
  toWorkspaceAbsoluteFilePath,
} from '../../services/pathUtils'
import { clampFixedContextMenuPosition } from '../../utils/contextMenuClamp'
import { useT } from '../../i18n'
import {
  flattenTree,
  indexTree,
  isDescendantOrEqual,
  parentDirRel,
  splitPath,
  topLevelSelection,
  validateName,
  type FlatRow,
} from './fileTreeUtils'
import {
  ROW_HEIGHT,
  type ConfirmState,
  type ContextMenuState,
  type FileTreeProps,
  type RowItemData,
} from './FileTreeTypes'
import Row from './FileTreeRow'
import ContextMenu from './FileTreeContextMenu'
import './FileTree.css'

/**
 * Resolve a tree-relative path to a workspace-absolute path for fs IPC calls.
 *
 * Delegates to {@link toWorkspaceAbsoluteFilePath} so an absolute value
 * (e.g. a node produced by a custom provider) is returned verbatim instead
 * of being double-joined into `C:\ws\C:\...` garbage on Windows.
 */
function toWorkspaceAbsolute(rootPath: string, relativePath: string): string {
  return toWorkspaceAbsoluteFilePath(relativePath, rootPath)
}

/**
 * Generate "name (copy)", "name (copy 2)" etc. when pasting into a folder that
 * already contains the source. We only walk the *immediate* children of the
 * target folder rather than the whole subtree — same-name collisions across
 * deep paths are fine.
 */
function uniquifyName(
  desired: string,
  parentRel: string,
  existing: Map<string, FileNode>,
): string {
  const inParent = (name: string) =>
    existing.has(parentRel ? `${parentRel}/${name}` : name)
  if (!inParent(desired)) return desired
  const dot = desired.lastIndexOf('.')
  const base = dot > 0 ? desired.slice(0, dot) : desired
  const ext = dot > 0 ? desired.slice(dot) : ''
  let n = 2
  let candidate = `${base} (copy)${ext}`
  while (inParent(candidate)) {
    n += 1
    candidate = `${base} (copy ${n})${ext}`
  }
  return candidate
}

export const FileTree: React.FC<FileTreeProps> = ({
  files,
  onFileClick,
  activePath,
  rootPath,
}) => {
  const t = useT()
  const expanded = useFileTreeUIStore((s) => s.expanded)
  const selected = useFileTreeUIStore((s) => s.selected)
  const focusedPath = useFileTreeUIStore((s) => s.focusedPath)
  const anchorPath = useFileTreeUIStore((s) => s.anchorPath)
  const inlineEdit = useFileTreeUIStore((s) => s.inlineEdit)
  const clipboard = useFileTreeUIStore((s) => s.clipboard)
  const refreshFileTree = useWorkspaceStore((s) => s.refreshFileTree)
  const loadingFolders = useWorkspaceStore((s) => s.loadingFolders)

  const flatRows = useMemo(
    () => flattenTree(files, expanded, inlineEdit),
    [files, expanded, inlineEdit],
  )
  const visiblePaths = useMemo(() => flatRows.map((r) => r.node.path), [flatRows])
  const fileIndex = useMemo(() => indexTree(files), [files])

  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [ctx, setCtx] = useState<ContextMenuState | null>(null)
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<FixedSizeList<RowItemData>>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Auto-reveal active tab: expand ancestors + scroll into view when the
  // active file changes. Guarded on rootPath so we don't run before workspace
  // bootstraps. This replaces the old "always collapsed after refresh" feel.
  useEffect(() => {
    if (!activePath) return
    useFileTreeUIStore.getState().expandAncestors(activePath)
  }, [activePath])

  // Tracks folders we already re-verified during their CURRENT expansion,
  // so the self-heal branch below fetches a genuinely-empty folder exactly
  // once per expand instead of looping on every fileIndex change. Entries
  // are dropped when the folder collapses, so re-expanding retries once.
  const verifiedEmptyRef = useRef(new Set<string>())

  // Lazy-load: whenever the set of expanded folders changes (or the underlying
  // tree data changes), walk the expanded set and fire a subtree fetch for
  // any folder that was returned with `needsLoad: true`. `loadFolderChildren`
  // is idempotent — it guards on `loadingFolders` + clears `needsLoad` after
  // success, so this loop naturally stops once everything is populated.
  //
  // Self-heal (2026-07): a folder can reach `needsLoad: false` + empty
  // children WITHOUT ever being fetched — e.g. an out-of-order watcher
  // refresh snapshotted it while it was still empty, or a previous lazy
  // fetch failed silently. Such a node used to render as permanently empty
  // no matter how often the user expanded it. Now an expanded folder with
  // no children gets one verification fetch per expansion regardless of
  // its `needsLoad` flag.
  useEffect(() => {
    const verified = verifiedEmptyRef.current
    for (const p of verified) {
      if (!expanded.has(p)) verified.delete(p)
    }
    for (const p of expanded) {
      const node = fileIndex.get(p)
      if (!node || node.type !== 'folder') continue
      if (node.needsLoad) {
        void useWorkspaceStore.getState().loadFolderChildren(p)
        continue
      }
      const looksEmpty = !node.children || node.children.length === 0
      if (looksEmpty && !verified.has(p)) {
        verified.add(p)
        void useWorkspaceStore.getState().loadFolderChildren(p)
      }
    }
  }, [expanded, fileIndex])

  // After the expand → re-flatten cycle settles, scroll the active row into
  // view. We intentionally don't move keyboard focus on activePath changes
  // (that would steal focus from the editor).
  useEffect(() => {
    if (!activePath || !listRef.current) return
    const idx = visiblePaths.indexOf(activePath)
    if (idx >= 0) {
      listRef.current.scrollToItem(idx, 'smart')
    }
  }, [activePath, visiblePaths])

  // Keep focus visible when it moves via keyboard.
  useEffect(() => {
    if (!focusedPath || !listRef.current) return
    const idx = visiblePaths.indexOf(focusedPath)
    if (idx >= 0) {
      listRef.current.scrollToItem(idx, 'smart')
    }
  }, [focusedPath, visiblePaths])

  // Click-outside dismissal for the shared context menu.
  useEffect(() => {
    if (!ctx) return
    const dismiss = (e: MouseEvent) => {
      const target = e.target as Node | null
      const menu = document.querySelector('.tree-context-menu')
      if (menu && target && menu.contains(target)) return
      setCtx(null)
    }
    const onScroll = () => setCtx(null)
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [ctx])

  const showConfirm = useCallback((c: ConfirmState) => setConfirm(c), [])
  const closeConfirm = useCallback(() => setConfirm(null), [])

  // ---------------------------------------------------------------- helpers

  const runDelete = useCallback(
    async (paths: string[]) => {
      if (!rootPath || paths.length === 0) return
      const tops = topLevelSelection(paths)
      for (const p of tops) {
        const n = fileIndex.get(p)
        if (!n) continue
        try {
          await deleteFile(toWorkspaceAbsolute(rootPath, p))
          useFileStore.getState().syncTabsAfterTreeDelete(p, n.type === 'folder')
          useChatStore.getState().syncReferencedAfterDelete(p, n.type === 'folder')
          useFileTreeUIStore.getState().forgetPath(p, n.type === 'folder')
        } catch (e) {
          showConfirm({
            title: t.fileTree.deleteFailed,
            message: e instanceof Error ? e.message : String(e),
            confirmLabel: t.fileTree.gotIt,
            onConfirm: closeConfirm,
          })
          break
        }
      }
      await refreshFileTree()
    },
    [rootPath, fileIndex, refreshFileTree, showConfirm, closeConfirm, t],
  )

  const confirmDelete = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return
      const tops = topLevelSelection(paths)
      const first = fileIndex.get(tops[0])
      const name =
        tops.length === 1
          ? first?.name || tops[0]
          : t.fileTree.itemsCount(tops.length)
      showConfirm({
        title: t.fileTree.deleteTitle,
        message: t.fileTree.deleteConfirm(name),
        danger: true,
        confirmLabel: t.fileTree.delete,
        onConfirm: async () => {
          closeConfirm()
          await runDelete(paths)
        },
      })
    },
    [fileIndex, runDelete, showConfirm, closeConfirm, t],
  )

  const commitRename = useCallback(
    async (oldPath: string, newName: string) => {
      if (!rootPath) return
      const err = validateName(newName)
      if (err) {
        showConfirm({
          title: t.fileTree.invalidName,
          message: err,
          confirmLabel: t.fileTree.gotIt,
          onConfirm: closeConfirm,
        })
        return
      }
      const { parent } = splitPath(oldPath)
      const newRel = parent ? `${parent}/${newName.trim()}` : newName.trim()
      if (normalizePath(newRel) === normalizePath(oldPath)) {
        useFileTreeUIStore.getState().cancelInlineEdit()
        return
      }
      const node = fileIndex.get(oldPath)
      const isFolder = node?.type === 'folder'
      try {
        await renameInWorkspace(rootPath, oldPath, newRel)
        useFileStore.getState().syncTabsAfterTreeRename(
          oldPath,
          newRel,
          newName.trim(),
          isFolder,
        )
        useChatStore.getState().syncReferencedAfterRename(oldPath, newRel, isFolder)
        useFileTreeUIStore.getState().remapPath(oldPath, newRel, isFolder)
        useFileTreeUIStore.getState().cancelInlineEdit()
        await refreshFileTree()
      } catch (e) {
        showConfirm({
          title: t.fileTree.renameFailed,
          message: e instanceof Error ? e.message : String(e),
          confirmLabel: t.fileTree.gotIt,
          onConfirm: closeConfirm,
        })
      }
    },
    [rootPath, fileIndex, refreshFileTree, showConfirm, closeConfirm, t],
  )

  const commitCreate = useCallback(
    async (parentRel: string, name: string, isFolder: boolean) => {
      if (!rootPath) return
      const err = validateName(name)
      if (err) {
        showConfirm({
          title: t.fileTree.invalidName,
          message: err,
          confirmLabel: t.fileTree.gotIt,
          onConfirm: closeConfirm,
        })
        return
      }
      const rel = parentRel ? `${parentRel}/${name.trim()}` : name.trim()
      try {
        if (isFolder) {
          await createDir(joinWorkspaceRelative(rootPath, rel))
        } else {
          await writeFile(joinWorkspaceRelative(rootPath, rel), '')
        }
        if (parentRel) useFileTreeUIStore.getState().setExpanded(parentRel, true)
        useFileTreeUIStore.getState().cancelInlineEdit()
        useFileTreeUIStore.getState().setFocus(rel)
        useFileTreeUIStore.getState().select(rel)
        await refreshFileTree()
      } catch (e) {
        showConfirm({
          title: t.fileTree.createFailed,
          message: e instanceof Error ? e.message : String(e),
          confirmLabel: t.fileTree.gotIt,
          onConfirm: closeConfirm,
        })
      }
    },
    [rootPath, refreshFileTree, showConfirm, closeConfirm, t],
  )

  const cancelInlineEdit = useCallback(() => {
    useFileTreeUIStore.getState().cancelInlineEdit()
  }, [])

  // ------------------------------------------------------------ drag-drop

  /**
   * Move selected (or single) paths under `targetFolderRel` (empty string = root).
   * Uses `renameInWorkspace` which is just `fs.rename` under the hood — that's
   * atomic on same-volume moves, which is what we get for workspace-local DnD.
   */
  const performMove = useCallback(
    async (sourcePaths: string[], targetFolderRel: string) => {
      if (!rootPath) return
      const tops = topLevelSelection(sourcePaths)
      for (const src of tops) {
        const node = fileIndex.get(src)
        if (!node) continue
        if (isDescendantOrEqual(src, targetFolderRel)) continue
        const srcParent = parentDirRel(src)
        if (normalizePath(srcParent) === normalizePath(targetFolderRel)) continue
        const finalName = uniquifyName(node.name, targetFolderRel, fileIndex)
        const finalRel = targetFolderRel
          ? `${targetFolderRel}/${finalName}`
          : finalName
        try {
          await renameInWorkspace(rootPath, src, finalRel)
          useFileStore.getState().syncTabsAfterTreeRename(
            src,
            finalRel,
            finalName,
            node.type === 'folder',
          )
          useChatStore
            .getState()
            .syncReferencedAfterRename(src, finalRel, node.type === 'folder')
          useFileTreeUIStore
            .getState()
            .remapPath(src, finalRel, node.type === 'folder')
        } catch (e) {
          showConfirm({
            title: t.fileTree.moveFailed,
            message: `${src}: ${e instanceof Error ? e.message : String(e)}`,
            confirmLabel: t.fileTree.gotIt,
            onConfirm: closeConfirm,
          })
          break
        }
      }
      if (targetFolderRel) {
        useFileTreeUIStore.getState().setExpanded(targetFolderRel, true)
      }
      await refreshFileTree()
    },
    [rootPath, fileIndex, refreshFileTree, showConfirm, closeConfirm, t],
  )

  // ----------------------------------------------------------- clipboard

  const doCopyPaste = useCallback(
    async (sources: string[], targetFolderRel: string) => {
      if (!rootPath) return
      for (const src of sources) {
        const node = fileIndex.get(src)
        if (!node) continue
        if (node.type === 'folder') {
          showConfirm({
            title: t.fileTree.notSupported,
            message: t.fileTree.folderCopyUnsupported,
            confirmLabel: t.fileTree.gotIt,
            onConfirm: closeConfirm,
          })
          continue
        }
        const finalName = uniquifyName(node.name, targetFolderRel, fileIndex)
        const destRel = targetFolderRel
          ? `${targetFolderRel}/${finalName}`
          : finalName
        try {
          // 2026-07 审计修复:字节级复制。此前 readFile(UTF-8)+writeFile
          // 的文本往返会损坏任何二进制文件(图片/压缩包/Office)的副本。
          await copyFileBinary(
            toWorkspaceAbsolute(rootPath, src),
            joinWorkspaceRelative(rootPath, destRel),
          )
        } catch (e) {
          showConfirm({
            title: t.fileTree.copyFailed,
            message: `${src}: ${e instanceof Error ? e.message : String(e)}`,
            confirmLabel: t.fileTree.gotIt,
            onConfirm: closeConfirm,
          })
          break
        }
      }
      if (targetFolderRel) {
        useFileTreeUIStore.getState().setExpanded(targetFolderRel, true)
      }
      await refreshFileTree()
    },
    [rootPath, fileIndex, refreshFileTree, showConfirm, closeConfirm, t],
  )

  const doPaste = useCallback(
    async (targetFolderRel: string) => {
      if (!clipboard || clipboard.paths.length === 0) return
      if (clipboard.mode === 'cut') {
        await performMove(clipboard.paths, targetFolderRel)
        useFileTreeUIStore.getState().setClipboard(null)
      } else {
        await doCopyPaste(clipboard.paths, targetFolderRel)
      }
    },
    [clipboard, performMove, doCopyPaste],
  )

  // ------------------------------------------------------- keyboard nav

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (inlineEdit) return // inline input handles its own keys
      if (confirm) return
      const focusIdx = focusedPath ? visiblePaths.indexOf(focusedPath) : -1
      const moveTo = (idx: number, withShift: boolean) => {
        if (idx < 0 || idx >= visiblePaths.length) return
        const target = visiblePaths[idx]
        if (withShift) {
          useFileTreeUIStore.getState().select(target, {
            range: true,
            visiblePaths,
            anchor: anchorPath || focusedPath || target,
          })
        } else {
          useFileTreeUIStore.getState().select(target)
        }
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          moveTo(focusIdx < 0 ? 0 : focusIdx + 1, e.shiftKey)
          return
        case 'ArrowUp':
          e.preventDefault()
          moveTo(focusIdx < 0 ? 0 : focusIdx - 1, e.shiftKey)
          return
        case 'Home':
          e.preventDefault()
          moveTo(0, e.shiftKey)
          return
        case 'End':
          e.preventDefault()
          moveTo(visiblePaths.length - 1, e.shiftKey)
          return
        case 'PageDown':
          e.preventDefault()
          moveTo(Math.min(visiblePaths.length - 1, (focusIdx < 0 ? 0 : focusIdx) + 10), e.shiftKey)
          return
        case 'PageUp':
          e.preventDefault()
          moveTo(Math.max(0, (focusIdx < 0 ? 0 : focusIdx) - 10), e.shiftKey)
          return
      }

      if (!focusedPath) return
      const focusNode = fileIndex.get(focusedPath)

      switch (e.key) {
        case 'ArrowRight': {
          e.preventDefault()
          if (!focusNode) return
          if (focusNode.type === 'folder') {
            if (!expanded.has(focusedPath)) {
              useFileTreeUIStore.getState().setExpanded(focusedPath, true)
            } else {
              const next = visiblePaths[focusIdx + 1]
              if (next && next.startsWith(focusedPath + '/')) {
                useFileTreeUIStore.getState().select(next)
              }
            }
          }
          return
        }
        case 'ArrowLeft': {
          e.preventDefault()
          if (!focusNode) return
          if (focusNode.type === 'folder' && expanded.has(focusedPath)) {
            useFileTreeUIStore.getState().setExpanded(focusedPath, false)
          } else {
            const parent = parentDirRel(focusedPath)
            if (parent) {
              useFileTreeUIStore.getState().select(parent)
            }
          }
          return
        }
        case 'Enter': {
          e.preventDefault()
          if (!focusNode) return
          if (focusNode.type === 'folder') {
            useFileTreeUIStore.getState().toggleExpand(focusedPath)
          } else {
            onFileClick(focusNode)
          }
          return
        }
        case ' ': {
          e.preventDefault()
          if (!focusNode) return
          if (focusNode.type === 'folder') {
            useFileTreeUIStore.getState().toggleExpand(focusedPath)
          } else {
            onFileClick(focusNode)
          }
          return
        }
        case 'F2': {
          e.preventDefault()
          if (!focusNode) return
          useFileTreeUIStore.getState().startRename(focusedPath, focusNode.name)
          return
        }
        case 'Delete': {
          e.preventDefault()
          const paths = selected.size > 0 ? [...selected] : [focusedPath]
          confirmDelete(paths)
          return
        }
        case 'Escape': {
          e.preventDefault()
          useFileTreeUIStore.getState().clearSelection()
          return
        }
        default:
          break
      }

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        switch (e.key.toLowerCase()) {
          case 'c': {
            e.preventDefault()
            const paths = selected.size > 0 ? [...selected] : [focusedPath]
            useFileTreeUIStore.getState().setClipboard({ mode: 'copy', paths })
            return
          }
          case 'x': {
            e.preventDefault()
            const paths = selected.size > 0 ? [...selected] : [focusedPath]
            useFileTreeUIStore.getState().setClipboard({ mode: 'cut', paths })
            return
          }
          case 'v': {
            e.preventDefault()
            if (!focusNode) return
            const target = focusNode.type === 'folder' ? focusedPath : parentDirRel(focusedPath)
            void doPaste(target)
            return
          }
        }
      }
    },
    [
      inlineEdit,
      confirm,
      focusedPath,
      anchorPath,
      visiblePaths,
      fileIndex,
      expanded,
      selected,
      onFileClick,
      confirmDelete,
      doPaste,
    ],
  )

  // --------------------------------------------------------- row handlers

  const onRowClick = useCallback(
    (row: FlatRow, e: React.MouseEvent) => {
      if (row.kind !== 'node') return
      const p = row.node.path
      if (e.shiftKey) {
        useFileTreeUIStore.getState().select(p, {
          range: true,
          visiblePaths,
          anchor: anchorPath || focusedPath || p,
        })
        return
      }
      if (e.ctrlKey || e.metaKey) {
        useFileTreeUIStore.getState().select(p, { multi: true })
        return
      }
      useFileTreeUIStore.getState().select(p)
      if (row.node.type === 'folder') {
        useFileTreeUIStore.getState().toggleExpand(p)
      } else {
        onFileClick(row.node)
      }
    },
    [anchorPath, focusedPath, visiblePaths, onFileClick],
  )

  const onRowContextMenu = useCallback(
    (row: FlatRow, e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const { x, y } = clampFixedContextMenuPosition(e.clientX, e.clientY, 220, 320)
      if (row.kind !== 'node') {
        setCtx({ x, y, targetPath: null, targetIsFolder: true, isRoot: true })
        return
      }
      const p = row.node.path
      if (!selected.has(p)) {
        useFileTreeUIStore.getState().select(p)
      }
      setCtx({
        x,
        y,
        targetPath: p,
        targetIsFolder: row.node.type === 'folder',
        isRoot: false,
      })
    },
    [selected],
  )

  const onContainerContextMenu = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    const { x, y } = clampFixedContextMenuPosition(e.clientX, e.clientY, 220, 320)
    setCtx({ x, y, targetPath: null, targetIsFolder: true, isRoot: true })
  }, [])

  // ---------------------------------------------------- drag & drop wiring

  const onRowDragStart = useCallback(
    (row: FlatRow, e: React.DragEvent) => {
      if (row.kind !== 'node') return
      const p = row.node.path
      const sources = selected.has(p) ? [...selected] : [p]
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('application/x-filetree-paths', JSON.stringify(sources))
      e.dataTransfer.setData('text/plain', sources.join('\n'))
    },
    [selected],
  )

  const onRowDragOver = useCallback((row: FlatRow, e: React.DragEvent) => {
    if (row.kind !== 'node') return
    if (!e.dataTransfer.types.includes('application/x-filetree-paths')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const dropTargetFolder =
      row.node.type === 'folder' ? row.node.path : parentDirRel(row.node.path)
    setDragOverPath(dropTargetFolder)
  }, [])

  const onRowDrop = useCallback(
    (row: FlatRow, e: React.DragEvent) => {
      if (row.kind !== 'node') return
      if (!e.dataTransfer.types.includes('application/x-filetree-paths')) return
      e.preventDefault()
      e.stopPropagation()
      const raw = e.dataTransfer.getData('application/x-filetree-paths')
      setDragOverPath(null)
      let sources: string[] = []
      try {
        sources = JSON.parse(raw) as string[]
      } catch {
        return
      }
      if (!Array.isArray(sources) || sources.length === 0) return
      const target =
        row.node.type === 'folder' ? row.node.path : parentDirRel(row.node.path)
      void performMove(sources, target)
    },
    [performMove],
  )

  const onContainerDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/x-filetree-paths')) return
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverPath('')
  }, [])

  const onContainerDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('application/x-filetree-paths')) return
      if (e.target !== e.currentTarget) return
      e.preventDefault()
      const raw = e.dataTransfer.getData('application/x-filetree-paths')
      setDragOverPath(null)
      let sources: string[] = []
      try {
        sources = JSON.parse(raw) as string[]
      } catch {
        return
      }
      if (!Array.isArray(sources) || sources.length === 0) return
      void performMove(sources, '')
    },
    [performMove],
  )

  // -------------------------------------------------------- item renderer

  const itemData = useMemo(
    () => ({
      rows: flatRows,
      activePath,
      rootPath,
      expanded,
      selected,
      focusedPath,
      inlineEdit,
      dragOverPath,
      loadingFolders,
      onRowClick,
      onRowContextMenu,
      onRowDragStart,
      onRowDragOver,
      onRowDrop,
      commitRename,
      commitCreate,
      cancelInlineEdit,
    }),
    [
      flatRows,
      activePath,
      rootPath,
      expanded,
      selected,
      focusedPath,
      inlineEdit,
      dragOverPath,
      loadingFolders,
      onRowClick,
      onRowContextMenu,
      onRowDragStart,
      onRowDragOver,
      onRowDrop,
      commitRename,
      commitCreate,
      cancelInlineEdit,
    ],
  )

  // ---------------------------------------------- context menu actions map

  const ctxTargetNode =
    ctx && ctx.targetPath ? fileIndex.get(ctx.targetPath) : null
  const ctxParentForNew =
    ctx?.isRoot || !ctx?.targetPath
      ? ''
      : ctx.targetIsFolder
        ? ctx.targetPath
        : parentDirRel(ctx.targetPath)

  return (
    <div className="file-tree-wrap">
      <div
        ref={containerRef}
        className={`file-tree ${dragOverPath === '' ? 'drag-root' : ''}`}
        tabIndex={0}
        role="tree"
        onKeyDown={handleContainerKeyDown}
        onContextMenu={onContainerContextMenu}
        onDragOver={onContainerDragOver}
        onDrop={onContainerDrop}
      >
        {flatRows.length > 0 && size.h > 0 ? (
          <FixedSizeList
            ref={listRef}
            height={size.h}
            width={size.w}
            itemCount={flatRows.length}
            itemSize={ROW_HEIGHT}
            itemData={itemData}
            itemKey={(index) => flatRows[index].key}
            overscanCount={8}
          >
            {Row}
          </FixedSizeList>
        ) : null}
      </div>

      {ctx && (
        <ContextMenu
          state={ctx}
          targetNode={ctxTargetNode || null}
          parentForNew={ctxParentForNew}
          rootPath={rootPath}
          clipboard={clipboard}
          close={() => setCtx(null)}
          onDelete={(path) => confirmDelete([path])}
          onDeleteMany={(paths) => confirmDelete(paths)}
          selectedPaths={[...selected]}
          doPaste={(target) => void doPaste(target)}
        />
      )}

      {confirm && (
        <div
          className="tree-dialog-overlay"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeConfirm()
          }}
        >
          <div
            className="tree-dialog"
            role="dialog"
            aria-modal
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="tree-dialog-title">{confirm.title}</div>
            <div className="tree-dialog-message">{confirm.message}</div>
            <div className="tree-dialog-actions">
              <button
                type="button"
                className={`tree-dialog-btn ${confirm.danger ? 'danger' : 'primary'}`}
                onClick={() => void confirm.onConfirm()}
              >
                {confirm.confirmLabel || t.fileTree.ok}
              </button>
              {confirm.confirmLabel !== t.fileTree.gotIt && (
                <button type="button" className="tree-dialog-btn" onClick={closeConfirm}>
                  {t.fileTree.cancel}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export type { FileTreeProps, ConfirmState, ContextMenuState, RowItemData }
export { ROW_HEIGHT }
export { default as Row } from './FileTreeRow'
export { default as InlineInput } from './FileTreeInlineInput'
export { default as ContextMenu } from './FileTreeContextMenu'
