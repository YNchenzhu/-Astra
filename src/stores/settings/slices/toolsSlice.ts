/**
 * Tools slice — per-tool visibility + external search API keys.
 *
 *   - `disabledTools`       names of tools the user has switched off in
 *                           Settings → 工具 panel. The renderer tool
 *                           registry (`useToolRegistry.enabledTools`)
 *                           reconciles from here on launch.
 *   - `embeddedSearchTools` opt into upstream embedded-search mode
 *                           (hides Glob/Grep from the model tool list).
 *   - `webSearch{Brave,Baidu}ApiKey` — persisted server keys for the
 *                           built-in `web_search` tool.
 */
import type { StateCreator } from 'zustand'
import { persistFromState } from '../persistSnapshot'
import type { SettingsState } from '../types'

export type ToolsSlice = Pick<SettingsState,
  | 'webSearchBraveApiKey' | 'webSearchBaiduApiKey'
  | 'embeddedSearchTools' | 'disabledTools'
  | 'setWebSearchBraveApiKey' | 'setWebSearchBaiduApiKey'
  | 'setEmbeddedSearchTools' | 'setDisabledTools' | 'toggleDisabledTool'
>

export const createToolsSlice: StateCreator<
  SettingsState, [], [], ToolsSlice
> = (set, get) => ({
  webSearchBraveApiKey: '',
  webSearchBaiduApiKey: '',
  embeddedSearchTools: false,
  disabledTools: [],

  setWebSearchBraveApiKey: (webSearchBraveApiKey) => {
    const update = { webSearchBraveApiKey }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setWebSearchBaiduApiKey: (webSearchBaiduApiKey) => {
    const update = { webSearchBaiduApiKey }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setEmbeddedSearchTools: (embeddedSearchTools) => {
    const update = { embeddedSearchTools }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setDisabledTools: (names) => {
    const dedup = Array.from(new Set(names.filter((n) => typeof n === 'string' && n.trim() !== '')))
    const update = { disabledTools: dedup }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  toggleDisabledTool: (name) => {
    const current = new Set(get().disabledTools)
    if (current.has(name)) current.delete(name)
    else current.add(name)
    const update = { disabledTools: Array.from(current) }
    set(update)
    persistFromState({ ...get(), ...update })
  },
})
