import { create } from 'zustand'

/**
 * UI-only state for the file tree sidebar: expansion, selection, keyboard focus,
 * inline editing and a tiny cut/copy clipboard. Lives outside the data store
 * (`useWorkspaceStore.fileTree`) so that `refreshFileTree()` — which reloads
 * data from disk after any FS mutation — does NOT wipe the user's expanded
 * folders. Previously every node kept its own `useState(expanded)`, so any
 * refresh collapsed the whole tree back to depth 0. That was the single
 * biggest friction point of the old tree.
 */

export type InlineEditState =
  | { kind: 'rename'; path: string; initialName: string }
  | { kind: 'newFile'; parentRel: string }
  | { kind: 'newFolder'; parentRel: string }
  | null

export type ClipboardState =
  | { mode: 'copy' | 'cut'; paths: string[] }
  | null

interface SelectOptions {
  multi?: boolean
  range?: boolean
  visiblePaths?: string[]
  anchor?: string | null
}

interface FileTreeUIState {
  expanded: Set<string>
  selected: Set<string>
  anchorPath: string | null
  focusedPath: string | null
  inlineEdit: InlineEditState
  clipboard: ClipboardState

  toggleExpand: (path: string) => void
  setExpanded: (path: string, expanded: boolean) => void
  expandAncestors: (path: string) => void
  collapseAll: () => void

  setFocus: (path: string | null) => void
  select: (path: string, opts?: SelectOptions) => void
  clearSelection: () => void

  startRename: (path: string, name: string) => void
  startNewFile: (parentRel: string) => void
  startNewFolder: (parentRel: string) => void
  cancelInlineEdit: () => void

  setClipboard: (c: ClipboardState) => void

  /** Called on rename/move: rewrite any path references inside UI state. */
  remapPath: (oldPath: string, newPath: string, isFolder: boolean) => void
  /** Called on delete: drop the path and any descendants from UI state. */
  forgetPath: (path: string, isFolder: boolean) => void

  resetForWorkspace: () => void
}

function isDescOrEq(parent: string, child: string): boolean {
  if (!parent) return true
  if (parent === child) return true
  return child.startsWith(parent + '/')
}

function remapInSet(
  set: Set<string>,
  oldPath: string,
  newPath: string,
  isFolder: boolean,
): Set<string> {
  const next = new Set<string>()
  let changed = false
  for (const p of set) {
    if (p === oldPath) {
      next.add(newPath)
      changed = true
      continue
    }
    if (isFolder && p.startsWith(oldPath + '/')) {
      next.add(newPath + p.slice(oldPath.length))
      changed = true
      continue
    }
    next.add(p)
  }
  return changed ? next : set
}

function forgetInSet(set: Set<string>, path: string, isFolder: boolean): Set<string> {
  const next = new Set<string>()
  let changed = false
  for (const p of set) {
    if (p === path || (isFolder && p.startsWith(path + '/'))) {
      changed = true
      continue
    }
    next.add(p)
  }
  return changed ? next : set
}

export const useFileTreeUIStore = create<FileTreeUIState>((set) => ({
  expanded: new Set<string>(),
  selected: new Set<string>(),
  anchorPath: null,
  focusedPath: null,
  inlineEdit: null,
  clipboard: null,

  toggleExpand: (path) =>
    set((s) => {
      const next = new Set(s.expanded)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return { expanded: next }
    }),

  setExpanded: (path, expanded) =>
    set((s) => {
      if (expanded === s.expanded.has(path)) return s
      const next = new Set(s.expanded)
      if (expanded) next.add(path)
      else next.delete(path)
      return { expanded: next }
    }),

  expandAncestors: (path) =>
    set((s) => {
      if (!path) return s
      const parts = path.split('/').filter(Boolean)
      if (parts.length <= 1) return s
      const next = new Set(s.expanded)
      let changed = false
      for (let i = 1; i < parts.length; i++) {
        const anc = parts.slice(0, i).join('/')
        if (!next.has(anc)) {
          next.add(anc)
          changed = true
        }
      }
      return changed ? { expanded: next } : s
    }),

  collapseAll: () => set({ expanded: new Set<string>() }),

  setFocus: (path) => set({ focusedPath: path }),

  select: (path, opts = {}) =>
    set((s) => {
      if (opts.multi) {
        const next = new Set(s.selected)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return { selected: next, focusedPath: path, anchorPath: path }
      }
      if (opts.range && opts.visiblePaths && opts.anchor) {
        const vs = opts.visiblePaths
        const i0 = vs.indexOf(opts.anchor)
        const i1 = vs.indexOf(path)
        if (i0 < 0 || i1 < 0) {
          return { selected: new Set([path]), focusedPath: path, anchorPath: path }
        }
        const [lo, hi] = i0 < i1 ? [i0, i1] : [i1, i0]
        return { selected: new Set(vs.slice(lo, hi + 1)), focusedPath: path }
      }
      return { selected: new Set([path]), focusedPath: path, anchorPath: path }
    }),

  clearSelection: () => set({ selected: new Set<string>(), anchorPath: null }),

  startRename: (path, name) =>
    set({ inlineEdit: { kind: 'rename', path, initialName: name } }),
  startNewFile: (parentRel) =>
    set((s) => ({
      inlineEdit: { kind: 'newFile', parentRel },
      expanded: parentRel && !s.expanded.has(parentRel)
        ? new Set([...s.expanded, parentRel])
        : s.expanded,
    })),
  startNewFolder: (parentRel) =>
    set((s) => ({
      inlineEdit: { kind: 'newFolder', parentRel },
      expanded: parentRel && !s.expanded.has(parentRel)
        ? new Set([...s.expanded, parentRel])
        : s.expanded,
    })),
  cancelInlineEdit: () => set({ inlineEdit: null }),

  setClipboard: (c) => set({ clipboard: c }),

  remapPath: (oldPath, newPath, isFolder) =>
    set((s) => {
      const expanded = isFolder
        ? remapInSet(s.expanded, oldPath, newPath, true)
        : s.expanded
      const selected = remapInSet(s.selected, oldPath, newPath, isFolder)
      const focusedPath = s.focusedPath
        ? (s.focusedPath === oldPath
            ? newPath
            : isFolder && isDescOrEq(oldPath, s.focusedPath)
              ? newPath + s.focusedPath.slice(oldPath.length)
              : s.focusedPath)
        : s.focusedPath
      const anchorPath = s.anchorPath
        ? (s.anchorPath === oldPath
            ? newPath
            : isFolder && isDescOrEq(oldPath, s.anchorPath)
              ? newPath + s.anchorPath.slice(oldPath.length)
              : s.anchorPath)
        : s.anchorPath
      return { expanded, selected, focusedPath, anchorPath }
    }),

  forgetPath: (path, isFolder) =>
    set((s) => {
      const expanded = forgetInSet(s.expanded, path, isFolder)
      const selected = forgetInSet(s.selected, path, isFolder)
      const focusedPath =
        s.focusedPath &&
        (s.focusedPath === path ||
          (isFolder && s.focusedPath.startsWith(path + '/')))
          ? null
          : s.focusedPath
      const anchorPath =
        s.anchorPath &&
        (s.anchorPath === path ||
          (isFolder && s.anchorPath.startsWith(path + '/')))
          ? null
          : s.anchorPath
      return { expanded, selected, focusedPath, anchorPath }
    }),

  resetForWorkspace: () =>
    set({
      expanded: new Set<string>(),
      selected: new Set<string>(),
      anchorPath: null,
      focusedPath: null,
      inlineEdit: null,
      clipboard: null,
    }),
}))
