import React from 'react'
import type { ListChildComponentProps } from 'react-window'
import {
  ChevronRight,
  ChevronDown,
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
} from 'lucide-react'
import type { RowItemData } from './FileTreeTypes'
import { DEPTH_INDENT } from './FileTreeTypes'
import InlineInput from './FileTreeInlineInput'

function getFileIcon(name: string): React.ReactElement {
  if (name.endsWith('.tsx') || name.endsWith('.ts'))
    return <FileCode size={16} className="file-icon icon-typescript" />
  if (name.endsWith('.json'))
    return <FileJson size={16} className="file-icon icon-json" />
  if (name.endsWith('.md'))
    return <FileText size={16} className="file-icon icon-markdown" />
  return <File size={16} className="file-icon icon-default" />
}

const Row: React.FC<ListChildComponentProps<RowItemData>> = ({ index, style, data }) => {
  const row = data.rows[index]
  const depth = row.depth
  const node = row.node
  const isActive = node.path === data.activePath
  const isFocused = node.path === data.focusedPath
  const isSelected = data.selected.has(node.path)
  const isFolder = node.type === 'folder'
  const isGhost = row.kind !== 'node'
  const isDragOver =
    data.dragOverPath != null &&
    (data.dragOverPath === node.path ||
      (isFolder && data.dragOverPath !== '' && node.path === data.dragOverPath))

  const isRenaming =
    data.inlineEdit?.kind === 'rename' &&
    data.inlineEdit.path === node.path

  const showEditor = isGhost || isRenaming

  const expanded = isFolder && data.expanded.has(node.path)
  const isLoading = isFolder && data.loadingFolders.has(node.path)

  const classes = [
    'tree-node',
    isSelected ? 'selected' : '',
    isActive ? 'active' : '',
    isFocused ? 'focused' : '',
    isDragOver ? 'drag-over' : '',
    isGhost ? 'ghost' : '',
    isLoading ? 'loading' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={classes}
      style={{ ...style, paddingLeft: depth * DEPTH_INDENT + 8 }}
      onClick={showEditor ? undefined : (e) => data.onRowClick(row, e)}
      onDoubleClick={
        !isGhost && !isFolder ? (e) => data.onRowClick(row, e) : undefined
      }
      onContextMenu={(e) => data.onRowContextMenu(row, e)}
      draggable={!isGhost}
      onDragStart={(e) => data.onRowDragStart(row, e)}
      onDragOver={(e) => data.onRowDragOver(row, e)}
      onDrop={(e) => data.onRowDrop(row, e)}
    >
      {isFolder ? (
        expanded ? (
          <ChevronDown size={14} className="tree-chevron" />
        ) : (
          <ChevronRight size={14} className="tree-chevron" />
        )
      ) : (
        <span className="tree-chevron-placeholder" />
      )}
      {isFolder ? (
        expanded ? (
          <FolderOpen size={16} className="folder-icon" />
        ) : (
          <Folder size={16} className="folder-icon" />
        )
      ) : (
        getFileIcon(node.name)
      )}
      {showEditor ? (
        <InlineInput
          initialName={isRenaming ? data.inlineEdit?.kind === 'rename' ? data.inlineEdit.initialName : '' : ''}
          onCommit={(name) => {
            if (isRenaming) {
              void data.commitRename(node.path, name)
            } else if (row.parentRel !== undefined) {
              void data.commitCreate(row.parentRel, name, row.kind === 'new-folder-ghost')
            }
          }}
          onCancel={data.cancelInlineEdit}
        />
      ) : (
        <span className="tree-label">{node.name}</span>
      )}
    </div>
  )
}

export default Row
