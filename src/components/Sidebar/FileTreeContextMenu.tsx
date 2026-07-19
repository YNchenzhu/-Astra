import React from 'react'
import {
  Copy,
  FilePlus,
  FolderPlus,
  FolderSymlink,
  MessageSquarePlus,
  Pencil,
  Scissors,
  Trash2,
  ClipboardPaste,
} from 'lucide-react'
import type { FileNode } from '../../types'
import type { ContextMenuState } from './FileTreeTypes'
import { useChatStore } from '../../stores/useChatStore'
import { useFileTreeUIStore } from '../../stores/useFileTreeUIStore'
import { isElectron, openPathInOS, showItemInFolder } from '../../services/electronAPI'
import { toWorkspaceAbsoluteFilePath } from '../../services/pathUtils'
import { useT } from '../../i18n'

const ContextMenu: React.FC<{
  state: ContextMenuState
  targetNode: FileNode | null
  parentForNew: string
  rootPath: string | null
  clipboard: ReturnType<typeof useFileTreeUIStore.getState>['clipboard']
  selectedPaths: string[]
  close: () => void
  onDelete: (path: string) => void
  onDeleteMany: (paths: string[]) => void
  doPaste: (target: string) => void
}> = ({
  state,
  targetNode,
  parentForNew,
  rootPath,
  clipboard,
  selectedPaths,
  close,
  onDelete,
  onDeleteMany,
  doPaste,
}) => {
  const t = useT()
  const hasTarget = !!targetNode
  const isFolder = targetNode?.type === 'folder'
  const multi = selectedPaths.length > 1
  const rootPathClone = rootPath

  const handleRefToChat = () => {
    if (targetNode) useChatStore.getState().toggleReferencedFile(targetNode.path)
    close()
  }

  const copyAndClose = (text: string) => {
    void navigator.clipboard.writeText(text).catch(() => {})
    close()
  }

  const handleCopyFullPath = () => {
    if (!targetNode) {
      close()
      return
    }
    if (!rootPathClone) {
      copyAndClose(targetNode.path)
      return
    }
    copyAndClose(toWorkspaceAbsoluteFilePath(targetNode.path, rootPathClone))
  }

  const handleCopyRelativePath = () => {
    if (!targetNode) {
      close()
      return
    }
    copyAndClose(targetNode.path.replace(/\\/g, '/'))
  }

  const handleReveal = () => {
    if (!rootPathClone || !isElectron() || !targetNode) {
      close()
      return
    }
    const full = toWorkspaceAbsoluteFilePath(targetNode.path, rootPathClone)
    const p = targetNode.type === 'folder' ? openPathInOS(full) : showItemInFolder(full)
    void p.finally(close)
  }

  const hasClipboard = !!(clipboard && clipboard.paths.length > 0)

  return (
    <div
      className="tree-context-menu"
      style={{ left: state.x, top: state.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {hasTarget && !isFolder && (
        <>
          <button type="button" className="tree-context-item" onClick={handleRefToChat}>
            <MessageSquarePlus size={13} />
            <span>{t.fileTree.refToChat}</span>
          </button>
          <div className="tree-context-sep" role="separator" />
        </>
      )}
      <button
        type="button"
        className="tree-context-item"
        onClick={() => {
          useFileTreeUIStore.getState().startNewFile(parentForNew)
          close()
        }}
        disabled={!rootPathClone}
      >
        <FilePlus size={13} />
        <span>{t.fileTree.newFile}</span>
      </button>
      <button
        type="button"
        className="tree-context-item"
        onClick={() => {
          useFileTreeUIStore.getState().startNewFolder(parentForNew)
          close()
        }}
        disabled={!rootPathClone}
      >
        <FolderPlus size={13} />
        <span>{t.fileTree.newFolder}</span>
      </button>
      {hasTarget && (
        <>
          <div className="tree-context-sep" role="separator" />
          <button
            type="button"
            className="tree-context-item"
            onClick={() => {
              const paths = multi ? selectedPaths : targetNode ? [targetNode.path] : []
              useFileTreeUIStore.getState().setClipboard({ mode: 'cut', paths })
              close()
            }}
          >
            <Scissors size={13} />
            <span>{t.fileTree.cut}</span>
          </button>
          <button
            type="button"
            className="tree-context-item"
            onClick={() => {
              const paths = multi ? selectedPaths : targetNode ? [targetNode.path] : []
              useFileTreeUIStore.getState().setClipboard({ mode: 'copy', paths })
              close()
            }}
          >
            <Copy size={13} />
            <span>{t.fileTree.copy}</span>
          </button>
        </>
      )}
      {(hasClipboard || !hasTarget) && (
        <button
          type="button"
          className="tree-context-item"
          onClick={() => {
            doPaste(parentForNew)
            close()
          }}
          disabled={!hasClipboard || !rootPathClone}
        >
          <ClipboardPaste size={13} />
          <span>{t.fileTree.paste}</span>
        </button>
      )}
      {hasTarget && (
        <>
          <div className="tree-context-sep" role="separator" />
          <button type="button" className="tree-context-item" onClick={handleCopyFullPath}>
            <Copy size={13} />
            <span>{rootPathClone ? t.fileTree.copyFullPath : t.fileTree.copyPath}</span>
          </button>
          <button type="button" className="tree-context-item" onClick={handleCopyRelativePath}>
            <Copy size={13} />
            <span>{t.fileTree.copyRelativePath}</span>
          </button>
          {rootPathClone && isElectron() && (
            <button type="button" className="tree-context-item" onClick={handleReveal}>
              <FolderSymlink size={13} />
              <span>{isFolder ? t.fileTree.openFolder : t.fileTree.revealInExplorer}</span>
            </button>
          )}
          <div className="tree-context-sep" role="separator" />
          <button
            type="button"
            className="tree-context-item"
            onClick={() => {
              if (!targetNode) return
              useFileTreeUIStore.getState().startRename(targetNode.path, targetNode.name)
              close()
            }}
            disabled={!rootPathClone}
          >
            <Pencil size={13} />
            <span>{t.fileTree.rename}</span>
          </button>
          <button
            type="button"
            className="tree-context-item danger"
            onClick={() => {
              close()
              if (multi) onDeleteMany(selectedPaths)
              else if (targetNode) onDelete(targetNode.path)
            }}
            disabled={!rootPathClone}
          >
            <Trash2 size={13} />
            <span>{multi ? t.fileTree.deleteN(selectedPaths.length) : t.fileTree.delete}</span>
          </button>
        </>
      )}
    </div>
  )
}

export default ContextMenu
