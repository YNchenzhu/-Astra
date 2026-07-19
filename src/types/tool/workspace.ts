// ============================================================================
// UI Types (used by sidebar, file store, settings, etc.)
// ============================================================================

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'folder'
  language?: string
  content?: string
  children?: FileNode[]
  /**
   * True when this folder was returned by the backend at the depth boundary
   * of `getFileTree` without being descended into. The file-tree component
   * lazily fetches its children the first time the user expands it.
   */
  needsLoad?: boolean
}

export interface TabInfo {
  id: string
  name: string
  path: string
  language: string
  content: string
  isModified: boolean
  /**
   * Last known on-disk content baseline for this tab (the bytes the buffer was
   * synced from / last persisted to). Used by the autosave conflict guard to
   * tell apart "only the user changed the buffer" (safe to write) from "an
   * external writer — e.g. an AI edit_file — changed the file underneath us"
   * (do NOT clobber). Undefined for untitled tabs or before the first sync.
   */
  diskContent?: string
}

export type SidebarView = 'explorer' | 'search' | 'git' | 'extensions'

export interface SearchResult {
  file: string
  path: string
  matches: { line: number; text: string }[]
}

export interface GitChange {
  file: string
  path: string
  status: 'modified' | 'added' | 'deleted' | 'untracked'
}
