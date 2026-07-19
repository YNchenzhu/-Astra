/**
 * Barrel file for advanced tools.
 *
 * All implementations have been split into per-tool modules:
 *   - toolGlob.ts
 *   - toolGrep.ts
 *   - toolWebSearch.ts
 *   - toolWebFetch.ts
 *   - advancedToolUtils.ts (shared utilities)
 *
 * This file re-exports their public APIs for backward compatibility and
 * hosts the IPC handler registration (`registerAdvancedToolHandlers`).
 */

import path from 'node:path'
import { type ToolResult } from './tools'
import {
  getPrimaryWorkspaceRoot,
  hasSecurityWorkspaceRoot,
  resolvePathForWorkspaceAccess,
} from '../security/workspaceAccess'
import { getWorkspacePath } from '../tools/workspaceState'
// `tools/schema` and `tools/registry` are referenced only inside IPC
// handler callbacks below, never at module-init time. They form a
// cycle with `tools/registry.ts` (which statically imports `toolWebSearch`
// from this file), but ESM live-bindings + deferred-call usage make the
// cycle harmless — both modules finish initializing before any handler
// fires.
import { getToolDefinitions } from '../tools/schema'
import { toolRegistry } from '../tools/registry'

// Re-exports for backward compatibility
export {
  toolGlob,
} from './toolGlob'

export {
  toolGrep,
  type GrepOutputMode,
} from './toolGrep'

export {
  toolWebFetch,
} from './toolWebFetch'

export {
  toolWebSearch,
  testBraveApiKey,
  testBaiduApiKey,
  pickWebSearchEngine,
  detectBraveKeyShapeWarnings,
  detectBaiduKeyShapeWarnings,
  BRAVE_API_KEY_PREFIX,
  BRAVE_API_KEY_MIN_LENGTH,
  BRAVE_API_KEY_REGEX,
  BAIDU_API_KEY_PREFIX,
  BAIDU_API_KEY_MIN_LENGTH,
  type BraveKeyShapeWarning,
  type BraveSecondaryProbeResult,
  type BraveKeyTestResult,
  type BaiduKeyShapeWarning,
  type BaiduKeyTestResult,
  type WebSearchEngine,
} from './toolWebSearch'

// Also re-export shared utilities that downstream code may depend on.
export {
  RG_SPAWNSYNC_TIMEOUT_MS,
  IGNORE_DIRS,
  getIgnoreArgsForDir,
  collectIgnorePatternsForDir,
  matchesIgnorePattern,
  splitGlobPatterns,
  formatLimitInfo,
  globToRegex,
  sessionMemorySearchTraversalLooksUnsafe,
  gateSessionMemoryInternalSearchDir,
  resolveSearchPath,
  type SearchPathResolution,
} from './advancedToolUtils'

function resolveRendererGlobGrepCwd(cwd?: string): ToolResult | { cwdResolved: string } {
  if (hasSecurityWorkspaceRoot()) {
    const primary = getPrimaryWorkspaceRoot()!
    const raw = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : primary
    const r = resolvePathForWorkspaceAccess(raw)
    if (!r.ok) {
      return { success: false, error: r.reason }
    }
    return { cwdResolved: r.resolved }
  }
  return { cwdResolved: cwd ? path.resolve(cwd) : getWorkspacePath() || process.cwd() }
}

// Lazy-load per-tool modules inside handlers so we don't pull heavy
// implementations into modules that only need the types.

export function registerAdvancedToolHandlers(ipcMain: Electron.IpcMain): void {
  ipcMain.handle(
    'tool:glob',
    async (_event, pattern: string, cwd?: string, options?: Parameters<typeof import('./toolGlob').toolGlob>[2]) => {
      const base = resolveRendererGlobGrepCwd(cwd)
      if ('success' in base && base.success === false) return base
      const { cwdResolved } = base as { cwdResolved: string }
      const { toolGlob } = await import('./toolGlob')
      return await toolGlob(pattern, cwdResolved, options)
    },
  )

  ipcMain.handle(
    'tool:grep',
    async (_event, pattern: string, cwd?: string, options?: Parameters<typeof import('./toolGrep').toolGrep>[2]) => {
      const base = resolveRendererGlobGrepCwd(cwd)
      if ('success' in base && base.success === false) return base
      const { cwdResolved } = base as { cwdResolved: string }
      const { toolGrep } = await import('./toolGrep')
      return toolGrep(pattern, cwdResolved, options)
    },
  )

  ipcMain.handle(
    'tool:web-fetch',
    async (_event, url: string, options?: Parameters<typeof import('./toolWebFetch').toolWebFetch>[1]) => {
      const { toolWebFetch } = await import('./toolWebFetch')
      return toolWebFetch(url, options)
    },
  )

  ipcMain.handle('tool:web-search', async (_event, query: string, options?: { maxResults?: number }) => {
    const { toolWebSearch } = await import('./toolWebSearch')
    return toolWebSearch(query, options)
  })

  ipcMain.handle(
    'tool:brave-test-key',
    async (_event, candidate?: unknown): Promise<import('./toolWebSearch').BraveKeyTestResult> => {
      const { testBraveApiKey } = await import('./toolWebSearch')
      return testBraveApiKey(
        typeof candidate === 'string' && candidate.trim().length > 0
          ? candidate
          : undefined,
      )
    },
  )

  ipcMain.handle(
    'tool:baidu-test-key',
    async (_event, candidate?: unknown): Promise<import('./toolWebSearch').BaiduKeyTestResult> => {
      const { testBaiduApiKey } = await import('./toolWebSearch')
      return testBaiduApiKey(
        typeof candidate === 'string' && candidate.trim().length > 0
          ? candidate
          : undefined,
      )
    },
  )

  ipcMain.handle(
    'tool:inspect-model-visible',
    async (_event, toolNameOrAlias?: unknown): Promise<{
      count: number
      names: string[]
      match?: {
        asked: string
        resolvedName: string | null
        visible: boolean
        hiddenReason?: string
      }
    }> => {
      const { isSimpleToolsetMode } = await import('../utils/simpleToolset')
      const { hasEmbeddedSearchTools } = await import('../utils/embeddedTools')
      const { isToolRuntimeDisabled } = await import('../tools/toolLoadFlags')
      const { shouldExposeDeferredTool } = await import('../tools/deferredDiscovery')

      const defs = getToolDefinitions()
      const names = defs.map((d) => d.name)

      const ask =
        typeof toolNameOrAlias === 'string' ? toolNameOrAlias.trim() : ''
      if (!ask) return { count: names.length, names }

      const lower = ask.toLowerCase()
      const resolved = toolRegistry.getAll().find((t) => {
        if (t.name.toLowerCase() === lower) return true
        return (t.aliases ?? []).some(
          (a) => typeof a === 'string' && a.toLowerCase() === lower,
        )
      })

      if (!resolved) {
        return {
          count: names.length,
          names,
          match: { asked: ask, resolvedName: null, visible: false, hiddenReason: 'not registered' },
        }
      }

      const visible = names.includes(resolved.name)
      if (visible) {
        return {
          count: names.length,
          names,
          match: { asked: ask, resolvedName: resolved.name, visible: true },
        }
      }

      let hiddenReason = 'unknown filter'
      if (resolved.isEnabled && resolved.isEnabled() === false) {
        hiddenReason = 'tool.isEnabled() returned false'
      } else if (!shouldExposeDeferredTool(resolved)) {
        hiddenReason = `deferred (shouldDefer=true, deferUntil returned false). Call ToolSearch with select:${resolved.name} to load.`
      } else if (isSimpleToolsetMode()) {
        hiddenReason =
          'ASTRA_SIMPLE_TOOLSET / CLAUDE_CODE_SIMPLE env flag is on — only read_file / edit_file / bash are visible.'
      } else if (hasEmbeddedSearchTools() && (resolved.name === 'glob' || resolved.name === 'grep')) {
        hiddenReason = 'embedded search mode hides Glob / Grep (Settings → Tools).'
      } else if (isToolRuntimeDisabled(resolved.name)) {
        hiddenReason = `disabled via ASTRA_DISABLED_TOOLS env (current: ${resolved.name}).`
      }

      return {
        count: names.length,
        names,
        match: {
          asked: ask,
          resolvedName: resolved.name,
          visible: false,
          hiddenReason,
        },
      }
    },
  )
}
