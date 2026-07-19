/**
 * Initialize Tools
 *
 * Registers all available tools in the tool registry.
 *
 * Also mirrors the registered tools into the `useToolRegistry` zustand store
 * so the Settings → Tools panel can actually list them. Previously the two
 * registries were completely disconnected and the UI's tool list was always
 * empty because `registerTool`/`registerTools` were never invoked.
 */

import { toolRegistry } from './toolRegistry'
import { createBashTool } from '../../tools/BashTool'
import { createFileReadTool } from '../../tools/FileReadTool'
import { createFileWriteTool } from '../../tools/FileWriteTool'
import { createWebSearchTool } from '../../tools/WebSearchTool'
import { useToolRegistry } from '../../stores/useToolRegistry'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type { Tool } from '../../types/tool'

export function initializeTools(): void {
  // Register core tools in the runtime singleton.
  // (Used by Settings → Tools UI; the actual agent loop lives in the main
  //  process now — see `electron/agents/teammateRunner.ts`. Renderer tools
  //  registered here remain for the Settings panel and any local-only
  //  utilities; they are never invoked by the in-process teammate.)
  toolRegistry.register(createBashTool())
  toolRegistry.register(createFileReadTool())
  toolRegistry.register(createFileWriteTool())
  toolRegistry.register(createWebSearchTool())

  // Mirror into zustand so Settings → Tools panel can list + toggle them.
  // The class-based tools (`ITool`) are structurally compatible with what
  // `useToolRegistry.registerTools` consumes (it only reads `t.name` +
  // `t.isEnabled?.()`), but their TS types differ — cast to satisfy the
  // store's declared signature. See `types/tool.ts::Tool`.
  try {
    const listForStore = toolRegistry.getAll() as unknown as Tool[]
    useToolRegistry.getState().registerTools(listForStore)
    // Reconcile in-memory `enabledTools` with persisted `disabledTools`
    // from settings — `toolsSlice.ts` docs the latter as the source of
    // truth that this registry should sync from on launch.
    try {
      const persistedDisabled = useSettingsStore.getState().disabledTools
      if (Array.isArray(persistedDisabled)) {
        const disable = useToolRegistry.getState().disableTool
        for (const name of persistedDisabled) {
          if (typeof name === 'string' && name.trim()) disable(name)
        }
      }
    } catch {
      /* settings store may not be hydrated yet (early boot) — best effort */
    }
    useToolRegistry.getState().setLoaded(true)
  } catch {
    /* zustand store may not be initialized in non-React contexts (tests) */
  }
}

export function getToolDefinitions() {
  return toolRegistry.getDefinitions()
}
