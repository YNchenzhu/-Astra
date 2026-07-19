/**
 * capabilityCatalogStore — 能力目录缓存（Sprint 2b.2）
 *
 * 工作台 Tab 3 需要展示"当前可选的工具 / 技能 / MCP 服务器"供用户
 * 多选。每次打开 Tab 3 都走 IPC 太浪费；但也不能永久缓存，因为
 * 用户可能在不关工作台的情况下去 Settings 新装技能或新连 MCP。
 *
 * 这里采用简单策略：
 *   - 首次访问按需 load
 *   - 工作台再次打开时 refresh 一次（workbenchVisible false → true 的边缘）
 *   - 暴露 refresh() 按钮让用户手动刷新（Tab 3 右上角）
 *
 * 与 bundleStore 不同，这个 store 不订阅任何主进程广播：能力目录
 * 的变化频率很低，按需刷新就够了。
 */

import { create } from 'zustand'

export interface CapabilityCatalog {
  tools: string[]
  skills: string[]
  mcpServers: string[]
}

interface CatalogState {
  catalog: CapabilityCatalog
  /** 是否已至少成功加载过一次。未加载时 UI 展示"加载中"。 */
  loaded: boolean
  /** 有飞行中的请求时 true，阻止并发 refresh 堆积。 */
  loading: boolean
  /** 上次加载出错的文本（null 表示 OK）。 */
  error: string | null

  refresh: () => Promise<void>
  /** 仅在未加载时触发 refresh；已加载则 no-op。UI 的 useEffect 调。 */
  ensureLoaded: () => Promise<void>
}

const EMPTY_CATALOG: CapabilityCatalog = { tools: [], skills: [], mcpServers: [] }

function getBridge() {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { electronAPI?: Window['electronAPI'] }).electronAPI
  return api?.bundle ?? null
}

export const useCapabilityCatalogStore = create<CatalogState>((set, get) => ({
  catalog: EMPTY_CATALOG,
  loaded: false,
  loading: false,
  error: null,

  refresh: async () => {
    const bridge = getBridge()
    if (!bridge?.getCapabilityCatalog) {
      set({ error: '当前环境未提供能力目录接口', loading: false })
      return
    }
    if (get().loading) return // dedupe concurrent callers
    set({ loading: true, error: null })
    try {
      const next = await bridge.getCapabilityCatalog()
      set({
        catalog: {
          tools: Array.isArray(next.tools) ? next.tools : [],
          skills: Array.isArray(next.skills) ? next.skills : [],
          mcpServers: Array.isArray(next.mcpServers) ? next.mcpServers : [],
        },
        loaded: true,
        loading: false,
        error: null,
      })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  ensureLoaded: async () => {
    if (get().loaded) return
    await get().refresh()
  },
}))
