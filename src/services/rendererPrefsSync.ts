/**
 * Mirrors selected localStorage keys to userData (see electron/rendererPrefs/store.ts).
 */

import { RECENT_PROJECTS_CHANGED_EVENT } from '../constants/recentProjects'

const MIRROR_KEYS = [
  'custom-agents',
  'claude-rules',
  'claude-rules-enabled-presets',
  'recentProjects',
  'buddy-pos',
] as const

let prefsFlushTimer: ReturnType<typeof setTimeout> | null = null

export async function hydrateRendererPrefsFromMain(): Promise<void> {
  if (typeof window === 'undefined') return
  const api = window.electronAPI
  if (!api?.rendererPrefs?.get) return
  try {
    const data = await api.rendererPrefs.get()
    if (data == null) return
    // 记录 hydrate 之后哪些 key 相对之前变化了，用来决定需要派哪些事件。
    // `localStorage.setItem` 在同一 window 不触发 `storage` 事件，所以
    // 欢迎页等同 window 订阅者必须靠我们派发的 CustomEvent 才能感知到
    // 首屏 render 之后、workspace 还没选之前就已到位的"最近项目"列表。
    const before: Record<string, string | null> = {}
    for (const k of MIRROR_KEYS) before[k] = localStorage.getItem(k)

    for (const k of MIRROR_KEYS) {
      const v = data[k]
      if (typeof v === 'string' && v.length > 0) {
        localStorage.setItem(k, v)
      } else {
        localStorage.removeItem(k)
      }
    }

    if (before.recentProjects !== (localStorage.getItem('recentProjects') ?? null)) {
      if (typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent(RECENT_PROJECTS_CHANGED_EVENT))
      }
    }
  } catch {
    /* ignore */
  }
}

export function queueMirrorRendererPrefsToDisk(): void {
  if (typeof window === 'undefined') return
  const api = window.electronAPI
  if (!api?.rendererPrefs?.patch) return
  if (prefsFlushTimer) clearTimeout(prefsFlushTimer)
  prefsFlushTimer = setTimeout(() => {
    prefsFlushTimer = null
    const patch: Record<string, string> = {}
    for (const k of MIRROR_KEYS) {
      patch[k] = localStorage.getItem(k) ?? ''
    }
    void api.rendererPrefs!.patch(patch).catch(() => {})
  }, 400)
}

export async function flushRendererPrefsNow(): Promise<void> {
  if (typeof window === 'undefined') return
  const api = window.electronAPI
  if (!api?.rendererPrefs?.patch) return
  if (prefsFlushTimer) {
    clearTimeout(prefsFlushTimer)
    prefsFlushTimer = null
  }
  const patch: Record<string, string> = {}
  for (const k of MIRROR_KEYS) {
    patch[k] = localStorage.getItem(k) ?? ''
  }
  await api.rendererPrefs.patch(patch)
}
