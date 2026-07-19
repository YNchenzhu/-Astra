import { create } from 'zustand'
import {
  getFileTree,
  openFolderDialog,
  startWorkspaceWatcher,
  stopWorkspaceWatcher,
} from '../services/fileSystem'
import { syncRecentProjectsWithWorkspaceRoot } from '../services/recentProjectsPersistence'
import { joinWorkspaceRelative, normalizePath } from '../services/pathUtils'
import { reportUserActionError } from '../utils/reportUserActionError'
import {
  isUntrustedWorkspacePathError,
  promptTrustWorkspace,
} from '../utils/workspaceTrustPrompt'
import { useDiagnosticStore } from './useDiagnosticStore'
import { useFileStore } from './useFileStore'
import { useChatStore } from './useChatStore'
import { useMemoryStore } from './useMemoryStore'
import { useFileTreeUIStore } from './useFileTreeUIStore'
// FIXME(arch): 与 `services/monacoDiagnostics.ts` 形成静态循环依赖
// （后者 import 本 store 订阅 rootPath 变化）。Vite 能 build 但属于已知
// 分层负债。修法应当把 workspace-root 订阅上移到 App 组件层，让
// services 只暴露纯函数；此处保持现状以避免连锁改动。
import { disposeMonacoDiagnostics } from '../services/monacoDiagnostics'
import type { FileNode } from '../types'

interface WorkspaceState {
  rootPath: string | null
  rootName: string
  fileTree: FileNode[]
  isLoading: boolean
  /** null = no folder or not checked; false = untrusted (workspace LSP merge disabled); true = trusted */
  workspaceTrusted: boolean | null
  trustWorkspaceInFlight: boolean
  /** Relative paths of folders whose lazy subtree fetch is currently in flight. */
  loadingFolders: Set<string>

  openWorkspace: () => Promise<void>
  setWorkspace: (path: string) => Promise<void>
  /** Clear folder, stop watcher, reset editor/chat; keeps recent list in localStorage. */
  closeWorkspace: () => Promise<void>
  refreshFileTree: () => Promise<void>
  /**
   * Same as {@link refreshFileTree} but does NOT toggle `isLoading`. Used by
   * background subscribers (e.g. workspace file watcher) where flipping
   * `isLoading=true` would replace the tree with the "加载中..." placeholder
   * on every external add/delete and produce a perceptible flash.
   */
  refreshFileTreeSilent: () => Promise<void>
  /**
   * Lazy-load children for a folder that was returned with `needsLoad: true`
   * (or forcibly re-fetched). Splices the new subtree into `fileTree` at
   * the folder's existing position.
   */
  loadFolderChildren: (relPath: string) => Promise<void>
  /** Re-read trust from main (e.g. after external trust file change). */
  refreshWorkspaceTrust: () => Promise<void>
  trustCurrentWorkspace: () => Promise<void>
}

// 首屏只拉一层(VS Code 式):大工作区 depth=4 的一次性递归扫描是打开
// 文件夹后左侧白屏数秒的主因。更深内容全部走 needsLoad → loadFolderChildren
// 的懒加载链路,展开哪层拉哪层。
const INITIAL_TREE_DEPTH = 1
const LAZY_LOAD_DEPTH = 1

/**
 * 树刷新的单调序号,用于丢弃乱序完成的过期快照。
 *
 * watcher 风暴(智能体批量写文件)会让多个 refreshFileTreeSilent 并发在飞,
 * getFileTree 的完成顺序不保证。若"文件夹还是空的"那次旧快照最后返回,
 * 它会用 `needsLoad: false` 覆盖掉新快照的 `needsLoad: true` —— 该文件夹
 * 从此被钉死为"空",展开永远不再触发懒加载。序号规则:每次发起刷新自增,
 * 完成时若已有更新的请求发起过,则丢弃本次结果。
 */
let treeRefreshSeq = 0

/** Prefix every node's `path` with `prefix` so a subtree fetched relative to a
 *  subfolder is compatible with the workspace-root-relative paths used in the
 *  rest of the app. */
function prefixTreePaths(nodes: FileNode[], prefix: string): FileNode[] {
  if (!prefix) return nodes
  const base = prefix.replace(/\/+$/, '')
  return nodes.map((n) => ({
    ...n,
    path: `${base}/${n.path.replace(/^\/+/, '')}`,
    children: n.children ? prefixTreePaths(n.children, prefix) : n.children,
  }))
}

/**
 * Merge a freshly-fetched shallow tree with the previous tree so subtrees the
 * user already lazy-loaded stay on screen instead of collapsing back to a
 * `needsLoad` stub. For folders the new fetch stopped at (`needsLoad: true`)
 * we keep the old children visible AND keep `needsLoad: true` — the file
 * tree's lazy-load effect then re-fetches expanded folders in the background
 * and splices in fresh data without any visible blink. Collapsed folders keep
 * the (possibly stale) grafted children until the next expand re-fetches.
 */
function graftLoadedChildren(fresh: FileNode[], old: FileNode[] | undefined): FileNode[] {
  if (!old || old.length === 0) return fresh
  const oldByPath = new Map(old.map((n) => [normalizePath(n.path), n]))
  return fresh.map((n) => {
    if (n.type !== 'folder') return n
    const prev = oldByPath.get(normalizePath(n.path))
    if (!prev || prev.type !== 'folder') return n
    if (n.needsLoad && prev.children && prev.children.length > 0) {
      return { ...n, children: prev.children }
    }
    if (n.children && n.children.length > 0 && prev.children && prev.children.length > 0) {
      const merged = graftLoadedChildren(n.children, prev.children)
      return merged === n.children ? n : { ...n, children: merged }
    }
    return n
  })
}

/** Find the node at `relPath` in a forest (paths are workspace-relative). */
function findNodeAt(nodes: FileNode[], relPath: string): FileNode | null {
  const normRel = normalizePath(relPath)
  for (const n of nodes) {
    if (normalizePath(n.path) === normRel) return n
    if (
      n.type === 'folder' &&
      n.children &&
      normRel.startsWith(normalizePath(n.path) + '/')
    ) {
      const found = findNodeAt(n.children, relPath)
      if (found) return found
    }
  }
  return null
}

/** Return a new forest where the folder at `relPath` has its `children` and
 *  `needsLoad` replaced. Produces a structurally-sharing copy — untouched
 *  subtrees keep their original identity so React can skip re-rendering. */
function replaceFolderChildren(
  nodes: FileNode[],
  relPath: string,
  newChildren: FileNode[],
): FileNode[] {
  const normRel = normalizePath(relPath)
  let changed = false
  const out = nodes.map((n) => {
    if (n.type !== 'folder') return n
    if (normalizePath(n.path) === normRel) {
      changed = true
      return { ...n, children: newChildren, needsLoad: false }
    }
    if (n.children && relPath.startsWith(n.path.replace(/\/+$/, '') + '/')) {
      const updatedChildren = replaceFolderChildren(n.children, relPath, newChildren)
      if (updatedChildren !== n.children) {
        changed = true
        return { ...n, children: updatedChildren }
      }
    }
    return n
  })
  return changed ? out : nodes
}

async function resolveWorkspaceTrust(path: string): Promise<boolean> {
  const api = window.electronAPI?.workspaceTrust
  if (!api) return true
  try {
    const r = await api.check({ path })
    return r.trusted
  } catch {
    return true
  }
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  rootPath: null,
  rootName: '',
  fileTree: [],
  isLoading: false,
  workspaceTrusted: null,
  trustWorkspaceInFlight: false,
  loadingFolders: new Set<string>(),

  openWorkspace: async () => {
    // Historically this was a 4-liner with zero error handling. When anything
    // inside `openFolderDialog` or `setWorkspace` threw, the promise returned
    // to the button's `onClick` was simply discarded — the user saw a dead
    // button with no feedback. The sidebar "打开文件夹" blue button in
    // particular surfaced this repeatedly. Keep logging + an explicit user-
    // visible fallback here so silent failures are impossible going forward.
    try {
      const path = await openFolderDialog({ title: 'Open Folder' })
      if (!path) {
        // User cancelled the native dialog — expected, no-op.
        return
      }
      await get().setWorkspace(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[WorkspaceStore] openWorkspace failed:', error)
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(`打开文件夹失败：${message}`)
      }
    }
  },

  setWorkspace: async (path: string) => {
    const { rootPath: previousRootPath } = get()
    const workspaceChanged = previousRootPath !== path

    if (previousRootPath && workspaceChanged) {
      try {
        await useChatStore.getState().saveCurrentConversation()
      } catch (error) {
        console.error('[WorkspaceStore] Failed to auto-save previous workspace conversation:', error)
      }

      try {
        useDiagnosticStore.getState().clearAllDiagnostics()
      } catch (error) {
        console.error('[WorkspaceStore] Failed to clear renderer diagnostics on workspace switch:', error)
      }

      try {
        await window.electronAPI?.lsp?.clearDiagnostics?.()
      } catch (error) {
        console.error('[WorkspaceStore] Failed to clear main-process diagnostics on workspace switch:', error)
      }

    try {
      await stopWorkspaceWatcher()
    } catch (error) {
      console.error('[WorkspaceStore] Failed to stop previous workspace watcher:', error)
    }

    // Dispose Monaco diagnostics bridge so the old polling timer + model references
    // from the previous root don't leak into the new workspace. Without this the
    // `initialized` flag stays true and `initMonacoDiagnostics()` short-circuits,
    // leaving the new Monaco instance with a stale timer or no diagnostics at all.
    try {
      disposeMonacoDiagnostics()
    } catch (error) {
      console.error('[WorkspaceStore] Failed to dispose Monaco diagnostics:', error)
    }
  }

    // Clear tabs + pending diffs BEFORE bumping rootPath. Otherwise React can render the new
    // workspace root while Monaco + InlineDiffDecorator still reflect the old folder (path prop
    // and model drift → revealFocusedHunk / getLineMaxColumn OOB).
    if (workspaceChanged) {
      try {
        useFileStore.getState().resetForWorkspaceChange()
      } catch (error) {
        console.error('[WorkspaceStore] Failed to reset editor before workspace switch:', error)
      }

      // Drop the file-tree UI state (expanded set, selection, clipboard, inline
      // edit) so we don't leak paths from the previous workspace into the new
      // tree. Without this, opening a different folder would still try to
      // "remember" the old folders as expanded.
      try {
        useFileTreeUIStore.getState().resetForWorkspace()
      } catch (error) {
        console.error('[WorkspaceStore] Failed to reset file tree UI state:', error)
      }
    }

    const rootName = path.split(/[\\/]/).pop() || path
    set({ rootPath: path, rootName, isLoading: true, workspaceTrusted: null })
    syncRecentProjectsWithWorkspaceRoot(path)

    void resolveWorkspaceTrust(path).then((trusted) => {
      if (get().rootPath === path) set({ workspaceTrusted: trusted })
    })

    // Audit fix A2-UX (2026-05) — when the main-process boundary check
    // (`workspaceAccept.ts`) rejects an untrusted path in strict mode the
    // IPC promise rejects. Surface that as a "Trust this workspace?"
    // confirm prompt; on user approval add the trust + retry; on cancel
    // log + leave the workspace in its half-set state (rootPath was
    // already optimistically updated above, but no main-process side
    // effects will have fired). The store reads `workspaceTrusted` for
    // the banner, so the same code path that handled trust outside the
    // IPC flow continues to work — we just give the user a chance to
    // resolve the gate inline.
    let workspaceTrustResolved = false
    try {
      await window.electronAPI?.memory?.setWorkspace(path)
      workspaceTrustResolved = true
    } catch (e) {
      if (isUntrustedWorkspacePathError(e)) {
        const trustApi = window.electronAPI?.workspaceTrust
        const agreed = await promptTrustWorkspace(path, trustApi)
        if (agreed) {
          try {
            await window.electronAPI?.memory?.setWorkspace(path)
            workspaceTrustResolved = true
            // Refresh the banner state since the user just trusted.
            if (get().rootPath === path) set({ workspaceTrusted: true })
          } catch (retryErr) {
            reportUserActionError('打开工作区（信任后重试）', retryErr)
          }
        } else {
          // User declined: log + leave a clear breadcrumb. We don't
          // revert `rootPath` here — the existing trust banner /
          // Sidebar UX already prompts the user to either trust or
          // pick a different folder. Reverting here would race with
          // the `resolveWorkspaceTrust` promise above.
          console.warn(
            `[WorkspaceStore] User declined to trust workspace ${path}; tools / skills will remain disabled until trusted.`,
          )
        }
      } else {
        console.error('[WorkspaceStore] Failed to sync workspace root to main process:', e)
      }
    }

    // Keep the in-renderer memory store synced even when the memory panel
    // is not mounted. Previously `useMemoryStore.workspacePath` only ever
    // moved when the user opened Settings → Memory, so any consumer reading
    // it elsewhere saw stale values. Only sync when trust resolved — if
    // the user declined, leaving the renderer pointing at an untrusted
    // path produces unbounded "looks open but nothing works" confusion.
    if (workspaceTrustResolved) {
      try {
        useMemoryStore.getState().setWorkspace(path)
      } catch (e) {
        console.error('[WorkspaceStore] Failed to sync workspace to memory store:', e)
      }
    }

    // 文件树请求先行,一返回立刻上屏 —— 不再排在 watcher 启动后面。
    // (必须在 memory.setWorkspace 之后:主进程的 fs 沙箱 roots 在那一步
    // 才被设置,提前调用会被 workspaceAccess 拒绝。)
    const treeReady = (async () => {
      const seq = ++treeRefreshSeq
      try {
        const tree = await getFileTree(path, INITIAL_TREE_DEPTH)
        if (seq !== treeRefreshSeq || get().rootPath !== path) return
        set({ fileTree: tree, isLoading: false, loadingFolders: new Set<string>() })
      } catch (error) {
        if (seq !== treeRefreshSeq || get().rootPath !== path) return
        // Previously this branch silently rendered an empty tree (UI: "未找到
        // 文件"), indistinguishable from a legit empty folder. Surface the real
        // reason instead — especially "preload bridge missing" which getFileTree
        // now throws rather than silently returning [].
        set({ fileTree: [], isLoading: false, loadingFolders: new Set<string>() })
        reportUserActionError('打开文件夹（加载文件树）', error)
      }
    })()

    try {
      await startWorkspaceWatcher(path)
    } catch (error) {
      console.error('[WorkspaceStore] Failed to start workspace watcher:', error)
    }

    await treeReady

    if (workspaceChanged) {
      try {
        await useChatStore.getState().hydrateAfterWorkspaceChange()
      } catch (error) {
        console.error('[WorkspaceStore] Failed to hydrate chat for new workspace:', error)
      }
    }
  },

  closeWorkspace: async () => {
    const { rootPath: previousRootPath } = get()
    if (!previousRootPath) return

    try {
      await useChatStore.getState().saveCurrentConversation()
    } catch (error) {
      console.error('[WorkspaceStore] Failed to auto-save conversation before close:', error)
    }

    try {
      useDiagnosticStore.getState().clearAllDiagnostics()
    } catch (error) {
      console.error('[WorkspaceStore] Failed to clear renderer diagnostics on workspace close:', error)
    }

    try {
      await window.electronAPI?.lsp?.clearDiagnostics?.()
    } catch (error) {
      console.error('[WorkspaceStore] Failed to clear main-process diagnostics on workspace close:', error)
    }

    try {
      await stopWorkspaceWatcher()
    } catch (error) {
      console.error('[WorkspaceStore] Failed to stop workspace watcher on close:', error)
    }

    try {
      useFileStore.getState().resetForWorkspaceChange()
    } catch (error) {
      console.error('[WorkspaceStore] Failed to reset editor on workspace close:', error)
    }

    try {
      useFileTreeUIStore.getState().resetForWorkspace()
    } catch (error) {
      console.error('[WorkspaceStore] Failed to reset file tree UI state on close:', error)
    }

    set({
      rootPath: null,
      rootName: '',
      fileTree: [],
      isLoading: false,
      workspaceTrusted: null,
      trustWorkspaceInFlight: false,
      loadingFolders: new Set<string>(),
    })
    syncRecentProjectsWithWorkspaceRoot(null)

    try {
      await window.electronAPI?.memory?.setWorkspace(null)
    } catch (e) {
      console.error('[WorkspaceStore] Failed to sync workspace close to main process:', e)
    }

    try {
      useMemoryStore.getState().setWorkspace(null)
    } catch (e) {
      console.error('[WorkspaceStore] Failed to clear memory store on close:', e)
    }

    try {
      await useChatStore.getState().hydrateAfterWorkspaceChange()
    } catch (error) {
      console.error('[WorkspaceStore] Failed to hydrate chat after workspace close:', error)
    }
  },

  refreshFileTree: async () => {
    const { rootPath } = get()
    if (!rootPath) return
    const seq = ++treeRefreshSeq
    set({ isLoading: true })
    try {
      const tree = await getFileTree(rootPath, INITIAL_TREE_DEPTH)
      // 过期快照(期间有更新的刷新发起过 / 工作区已切换):丢弃树数据,但
      // 仍要收掉 isLoading —— 后发的静默刷新不碰 isLoading,不收会卡住
      // "加载中"占位。
      if (seq !== treeRefreshSeq || get().rootPath !== rootPath) {
        set({ isLoading: false })
        return
      }
      // Graft previously lazy-loaded subtrees onto the shallow refetch so an
      // explicit refresh doesn't collapse everything the user expanded; the
      // lazy-load effect re-fetches expanded folders for freshness.
      const merged = graftLoadedChildren(tree, get().fileTree)
      set({ fileTree: merged, isLoading: false, loadingFolders: new Set<string>() })
    } catch (error) {
      // The sidebar "刷新" icon sits inside an already-loaded tree, so we
      // keep the existing `fileTree` rather than wiping it to an empty array.
      // Make the failure user-visible instead of the previous empty catch.
      set({ isLoading: false })
      reportUserActionError('刷新文件树', error)
    }
  },

  refreshFileTreeSilent: async () => {
    const { rootPath } = get()
    if (!rootPath) return
    const seq = ++treeRefreshSeq
    try {
      const tree = await getFileTree(rootPath, INITIAL_TREE_DEPTH)
      // 乱序防护:watcher 风暴下多个静默刷新并发在飞,旧请求的快照若最后
      // 返回会把新快照打回过去 —— 最恶劣的后果是刚写入内容的文件夹被旧
      // 快照的 `needsLoad: false` 钉死为"空",展开永远不再懒加载。只允许
      // 最新一次请求落库。
      if (seq !== treeRefreshSeq || get().rootPath !== rootPath) return
      // Intentionally do NOT touch `isLoading` here — keeping the previous
      // tree on screen while we re-fetch avoids the "加载中..." flash that
      // would otherwise blink every time chokidar reports an external add /
      // delete.  We still reset `loadingFolders` so any in-flight lazy
      // expansions don't appear stuck after the tree is replaced.
      // Graft keeps already-lazy-loaded subtrees visible across the shallow
      // refetch (see graftLoadedChildren) — without it every watcher event
      // would collapse expanded folders back to empty `needsLoad` stubs.
      const merged = graftLoadedChildren(tree, get().fileTree)
      set({ fileTree: merged, loadingFolders: new Set<string>() })
    } catch (error) {
      // Silent path: log but do not surface a toast — these auto-refreshes
      // run on every external file change and would spam the user.
      console.warn('[WorkspaceStore] Silent file-tree refresh failed:', error)
    }
  },

  loadFolderChildren: async (relPath: string) => {
    const { rootPath, loadingFolders } = get()
    if (!rootPath || !relPath) return
    if (loadingFolders.has(relPath)) return

    const nextLoading = new Set(loadingFolders)
    nextLoading.add(relPath)
    set({ loadingFolders: nextLoading })

    // `relPath` always comes from the file-tree's own node.path (a genuine
    // workspace-relative path), so `joinWorkspaceRelative` is a pure
    // normalised join here — we still route through it for parity with the
    // rest of the save / open sites.
    const absPath = joinWorkspaceRelative(rootPath, relPath)
    try {
      const subtree = await getFileTree(absPath, LAZY_LOAD_DEPTH)
      const prefixed = prefixTreePaths(subtree, relPath)
      // Re-fetch of an already-populated folder (refresh cascade): graft the
      // previously loaded grandchildren so nested expanded folders don't
      // blink empty while their own lazy re-fetch is in flight.
      const currentNode = findNodeAt(get().fileTree, relPath)
      const merged = graftLoadedChildren(prefixed, currentNode?.children)
      const updated = replaceFolderChildren(get().fileTree, relPath, merged)
      const after = new Set(get().loadingFolders)
      after.delete(relPath)
      set({ fileTree: updated, loadingFolders: after })
    } catch (error) {
      console.error('[WorkspaceStore] Failed to lazy-load folder:', relPath, error)
      const after = new Set(get().loadingFolders)
      after.delete(relPath)
      set({ loadingFolders: after })
    }
  },

  refreshWorkspaceTrust: async () => {
    const { rootPath } = get()
    if (!rootPath) {
      set({ workspaceTrusted: null })
      return
    }
    const trusted = await resolveWorkspaceTrust(rootPath)
    if (get().rootPath === rootPath) set({ workspaceTrusted: trusted })
  },

  trustCurrentWorkspace: async () => {
    const { rootPath } = get()
    if (!rootPath) return
    const api = window.electronAPI?.workspaceTrust
    if (!api) {
      // Preload's workspaceTrust bridge isn't present. Optimistically flag
      // the folder as trusted so the banner dismisses, but log so we can
      // diagnose why the IPC-backed trust path is unavailable.
      set({ workspaceTrusted: true })
      reportUserActionError(
        '信任此工作区',
        new Error('workspaceTrust IPC unavailable — trust set locally only.'),
        { silent: true },
      )
      return
    }
    set({ trustWorkspaceInFlight: true })
    try {
      const r = await api.add({ path: rootPath })
      if (r.success && get().rootPath === rootPath) set({ workspaceTrusted: true })
    } catch (error) {
      // Old code had try/finally only — any IPC rejection became an
      // unhandled promise rejection and the banner stayed without feedback.
      reportUserActionError('信任此工作区', error)
    } finally {
      if (get().rootPath === rootPath) set({ trustWorkspaceInFlight: false })
    }
  },
}))
