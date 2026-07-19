import { create } from 'zustand'

/**
 * Global workspace-index store.
 *
 * Why global instead of local to `EmbeddingPanel`?
 *
 * The Settings → 向量模型 panel used to own the "building / progress /
 * status" state. But the *actual* index build runs in the Electron main
 * process — completely independent of which renderer component is mounted.
 * The moment the user navigated away from that panel the progress listener
 * was torn down and the UI had no way to observe the ongoing build, so it
 * *looked* as if clicking away cancelled it. The backend happily kept
 * crunching tokens; the renderer simply couldn't see it anymore.
 *
 * Moving this state into a Zustand store lets us:
 *   1) mount the `workspace-index:progress` listener once, at the App
 *      root, so progress keeps streaming regardless of which panel is
 *      visible;
 *   2) share the same `building / progress / status / error` values
 *      across the Settings panel, the StatusBar indicator, and any future
 *      surface (command palette, notification toasts, …) without
 *      duplicating IPC wiring;
 *   3) re-hydrate the UI correctly when the user navigates back to the
 *      Settings panel mid-build — previously they'd see the initial "未
 *      构建" state even though the build was 40% done.
 *
 * The store is intentionally small: it only holds transient UI state and
 * delegates all real work (IPC calls, persistence) to the preload-exposed
 * `window.electronAPI.workspaceIndex.*` methods.
 */

export interface WorkspaceIndexProgress {
  phase: 'walk' | 'chunk' | 'embed' | 'upsert' | 'done'
  filesScanned: number
  filesIndexed: number
  chunksEmbedded: number
  chunksTotal: number
}

export interface WorkspaceIndexStatus {
  indexed: boolean
  namespace: string
  filesScanned: number
  filesIndexed: number
  chunkCount: number
  bytesSource: number
  model: string
  dim: number
  builtAt: number
  durationMs: number
  errors: Array<{ file: string; error: string }>
}

interface State {
  /** Which workspace root the current progress/status belongs to. */
  rootPath: string | null
  /** True from the moment `startBuild` is invoked until `build` resolves. */
  building: boolean
  /** Most recent progress tick streamed from the main process, or null. */
  progress: WorkspaceIndexProgress | null
  /** Last known persisted status (indexed? how many chunks? etc.). */
  status: WorkspaceIndexStatus | null
  /** Error message from the most recent build attempt, or null. */
  error: string | null
  /** Epoch ms when the current build began — used for "构建中 00:42" timer. */
  startedAt: number | null

  /** Hook the `workspace-index:progress` IPC once. Call on App mount. */
  subscribeProgress: () => () => void

  /** Kick off (or re-kick with `force=true`) a build for the given root. */
  startBuild: (root: string, force?: boolean) => Promise<void>

  /** Refresh `status` from disk (cheap, safe to call on panel mount). */
  refreshStatus: (root: string) => Promise<void>

  /** Drop the index for `root` and clear in-memory state if it matches. */
  clearIndex: (root: string) => Promise<void>

  /** Reset error after the user dismisses it. Does NOT cancel the build. */
  dismissError: () => void
}

// Only allow one concurrent build at a time — main process is single-model,
// two concurrent builds would interleave embed calls and corrupt the namespace.
let buildInflight: Promise<void> | null = null

export const useWorkspaceIndexStore = create<State>((set, get) => ({
  rootPath: null,
  building: false,
  progress: null,
  status: null,
  error: null,
  startedAt: null,

  subscribeProgress: () => {
    const api = window.electronAPI?.workspaceIndex
    if (!api?.onProgress) return () => {}
    return api.onProgress((payload) => {
      // Accept any root that matches the *current* tracked root. If the
      // user switched workspaces mid-build, stale ticks from the old root
      // are ignored here (the main process also tears down that build).
      const current = get().rootPath
      if (current && payload.root !== current) return
      set({
        progress: {
          phase: payload.phase,
          filesScanned: payload.filesScanned,
          filesIndexed: payload.filesIndexed,
          chunksEmbedded: payload.chunksEmbedded,
          chunksTotal: payload.chunksTotal,
        },
      })
      // `done` is the main process's final tick. We still wait for the
      // `build` promise to resolve (which carries the actual status) —
      // this is just a UX heads-up.
      if (payload.phase === 'done') {
        set({ building: false })
      }
    })
  },

  startBuild: async (root, force = false) => {
    if (!root) return
    const api = window.electronAPI?.workspaceIndex
    if (!api?.build) {
      set({ error: '当前环境不支持工作区索引构建' })
      return
    }
    if (buildInflight) {
      // Another build is running. Let the user know instead of queueing.
      set({ error: '已有索引构建在进行中；请等待其完成' })
      return
    }
    set({
      rootPath: root,
      building: true,
      error: null,
      startedAt: Date.now(),
      progress: {
        phase: 'walk',
        filesScanned: 0,
        filesIndexed: 0,
        chunksEmbedded: 0,
        chunksTotal: 0,
      },
    })
    buildInflight = (async () => {
      try {
        const r = await api.build({ root, force })
        if (!r.ok) {
          set({ error: r.error || '构建失败' })
        } else if (r.status) {
          set({ status: r.status })
        }
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      } finally {
        set({ building: false, startedAt: null })
        // Refresh status from disk so the indicator reflects the final
        // persisted state, not the in-memory partial progress.
        await get().refreshStatus(root)
        buildInflight = null
      }
    })()
    return buildInflight
  },

  refreshStatus: async (root) => {
    const api = window.electronAPI?.workspaceIndex
    if (!api?.status) return
    try {
      const s = await api.status({ root })
      set({ rootPath: root, status: s })
    } catch (err) {
      // Status fetch is best-effort; log but don't surface errors —
      // the user already sees build errors via `error`.
      console.warn('[useWorkspaceIndexStore] status fetch failed:', err)
    }
  },

  clearIndex: async (root) => {
    const api = window.electronAPI?.workspaceIndex
    if (!api?.clear) return
    try {
      await api.clear({ root })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return
    }
    set({ status: null, progress: null, error: null })
  },

  dismissError: () => set({ error: null }),
}))
