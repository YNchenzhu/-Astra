import type { FileNode } from '../../types'
import type { InlineEditState } from '../../stores/useFileTreeUIStore'
import type { FlatRow } from './fileTreeUtils'

export const ROW_HEIGHT = 24
export const DEPTH_INDENT = 12

export interface FileTreeProps {
  files: FileNode[]
  onFileClick: (node: FileNode) => void
  activePath: string | null
  rootPath: string | null
}

export interface ConfirmState {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
}

export interface ContextMenuState {
  x: number
  y: number
  targetPath: string | null
  targetIsFolder: boolean
  /** True when menu opened on the empty area (root context). */
  isRoot: boolean
}

/** Row item data passed to each Row in the virtualized list. */
export interface RowItemData {
  rows: FlatRow[]
  activePath: string | null
  rootPath: string | null
  expanded: Set<string>
  selected: Set<string>
  focusedPath: string | null
  inlineEdit: InlineEditState
  dragOverPath: string | null
  loadingFolders: Set<string>
  onRowClick: (row: FlatRow, e: React.MouseEvent) => void
  onRowContextMenu: (row: FlatRow, e: React.MouseEvent) => void
  onRowDragStart: (row: FlatRow, e: React.DragEvent) => void
  onRowDragOver: (row: FlatRow, e: React.DragEvent) => void
  onRowDrop: (row: FlatRow, e: React.DragEvent) => void
  commitRename: (oldPath: string, newName: string) => void | Promise<void>
  commitCreate: (parentRel: string, name: string, isFolder: boolean) => void | Promise<void>
  cancelInlineEdit: () => void
}
