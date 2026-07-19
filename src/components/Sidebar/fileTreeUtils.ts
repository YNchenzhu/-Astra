import type { FileNode } from '../../types'
import type { InlineEditState } from '../../stores/useFileTreeUIStore'

export type FlatRowKind = 'node' | 'new-file-ghost' | 'new-folder-ghost'

export interface FlatRow {
  /** Stable key (real path, or synthetic `__ghost__` id). */
  key: string
  /** The underlying node; for ghost rows this is a synthesized placeholder. */
  node: FileNode
  depth: number
  kind: FlatRowKind
  /** For ghost rows: the parent-relative path the new item will be created under. */
  parentRel?: string
}

const GHOST_PATH_SUFFIX = '__ghost__'

function ghostRow(parentRel: string, isFolder: boolean, depth: number): FlatRow {
  const syntheticPath = parentRel
    ? `${parentRel}/${GHOST_PATH_SUFFIX}`
    : GHOST_PATH_SUFFIX
  return {
    key: syntheticPath,
    node: {
      name: '',
      path: syntheticPath,
      type: isFolder ? 'folder' : 'file',
    },
    depth,
    kind: isFolder ? 'new-folder-ghost' : 'new-file-ghost',
    parentRel,
  }
}

/**
 * Flatten the `FileNode` forest into a single array of visible rows, honoring
 * `expanded` (Set of relative paths of currently-open folders) and any
 * in-progress `newFile`/`newFolder` inline edit, which renders as a "ghost" row
 * injected at the top of its target parent's children.
 *
 * Rows are intentionally computed top-down with stable insertion order so the
 * ghost row's array index is deterministic — we rely on that when keyboard
 * navigation needs to move focus onto it after Enter finalizes creation.
 */
export function flattenTree(
  nodes: FileNode[],
  expanded: Set<string>,
  inlineEdit: InlineEditState,
): FlatRow[] {
  const out: FlatRow[] = []

  const creatingAtRoot =
    inlineEdit &&
    (inlineEdit.kind === 'newFile' || inlineEdit.kind === 'newFolder') &&
    inlineEdit.parentRel === ''
  if (creatingAtRoot) {
    out.push(ghostRow('', inlineEdit.kind === 'newFolder', 0))
  }

  function walk(list: FileNode[], depth: number) {
    for (const n of list) {
      out.push({ key: n.path, node: n, depth, kind: 'node' })
      if (n.type !== 'folder') continue
      if (!expanded.has(n.path)) continue

      if (
        inlineEdit &&
        (inlineEdit.kind === 'newFile' || inlineEdit.kind === 'newFolder') &&
        inlineEdit.parentRel === n.path
      ) {
        out.push(ghostRow(n.path, inlineEdit.kind === 'newFolder', depth + 1))
      }

      if (n.children && n.children.length) {
        walk(n.children, depth + 1)
      }
    }
  }

  walk(nodes, 0)
  return out
}

export function parentDirRel(relPath: string): string {
  const p = relPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const i = p.lastIndexOf('/')
  if (i <= 0) return ''
  return p.slice(0, i)
}

export function getAncestorPaths(relPath: string): string[] {
  const parts = relPath.split('/').filter(Boolean)
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) {
    out.push(parts.slice(0, i).join('/'))
  }
  return out
}

/** Build lookup from path → FileNode in a forest, without mutating the input. */
export function indexTree(nodes: FileNode[]): Map<string, FileNode> {
  const map = new Map<string, FileNode>()
  const stack: FileNode[] = [...nodes]
  while (stack.length) {
    const n = stack.pop()!
    map.set(n.path, n)
    if (n.type === 'folder' && n.children) {
      for (const c of n.children) stack.push(c)
    }
  }
  return map
}

export function isDescendantOrEqual(parent: string, child: string): boolean {
  if (!parent) return true
  if (parent === child) return true
  return child.startsWith(parent + '/')
}

/**
 * Filter a set of selected paths down to "top-level" entries — i.e. drop any
 * path that's already contained under another selected folder. Used so
 * cut/copy/delete operations don't process the same subtree twice.
 */
export function topLevelSelection(paths: string[]): string[] {
  const sorted = [...paths].sort()
  const out: string[] = []
  for (const p of sorted) {
    const prev = out[out.length - 1]
    if (prev && (p === prev || p.startsWith(prev + '/'))) continue
    out.push(p)
  }
  return out
}

/** Split a relative path into parent + base. Does not touch the name. */
export function splitPath(relPath: string): { parent: string; base: string } {
  const i = relPath.lastIndexOf('/')
  if (i < 0) return { parent: '', base: relPath }
  return { parent: relPath.slice(0, i), base: relPath.slice(i + 1) }
}

/** Validate a file/folder name entered by the user. Returns error message or null. */
export function validateName(name: string): string | null {
  const t = name.trim()
  if (!t) return '名称不能为空'
  if (t === '.' || t === '..') return '名称不能为 . 或 ..'
  if (/[\\/]/.test(t)) return '名称不能包含 / 或 \\'
  // Windows reserved characters (exclude control chars 0x00–0x1F too).
  if (/[<>:"|?*]/.test(t)) return '名称包含非法字符'
  for (let i = 0; i < t.length; i++) {
    if (t.charCodeAt(i) < 0x20) return '名称包含非法字符'
  }
  return null
}
