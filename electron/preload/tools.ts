/**
 * Agent-tool, hooks, skills, and plugin-marketplace bridges.
 *
 *   - `tools.*`    unified tool registry + direct invocation (UI-safe
 *                  whitelist only; destructive tools must go through the
 *                  agentic loop in the main process)
 *   - `hooks.*`    fire status-line / file-suggestion hook events
 *   - `skills.*`   the skill registry + invocation path
 *   - `plugin.*`   marketplace index + MCPB bundle install
 */
import { ipcRenderer } from 'electron'

type ToolTestKeyOk = {
  ok: true
  status: 200
  keyPreview: string
  message: string
  shapeWarnings?: Array<'too-short' | 'wrong-prefix' | 'invalid-charset'>
}

type BraveTestKeyFailure = {
  ok: false
  status: number
  reason:
    | 'none'
    | 'subscription_token_invalid'
    | 'validation'
    | 'rate_limit'
    | 'server'
    | 'network'
    | 'other'
  keyPreview: string
  message: string
  detail?: string
  shapeWarnings?: Array<'too-short' | 'wrong-prefix' | 'invalid-charset'>
  secondaryProbe?:
    | { kind: 'skipped' }
    | { kind: 'ok'; endpoint: string }
    | { kind: 'failed'; endpoint: string; status: number }
    | { kind: 'error'; endpoint: string; message: string }
}

type BaiduTestKeyFailure = {
  ok: false
  status: number
  reason: 'none' | 'auth_invalid' | 'rate_limit' | 'server' | 'network' | 'other'
  keyPreview: string
  message: string
  detail?: string
  shapeWarnings?: Array<'too-short' | 'wrong-prefix' | 'invalid-charset'>
}

export interface ToolsApi {
  list: () => Promise<{ tools: string[]; definitions: unknown[] }>
  execute: (toolName: string, input: Record<string, unknown>) => Promise<{ success: boolean; output?: string; error?: string }>
  glob: (pattern: string, cwd?: string, options?: { maxResults?: number; includeDirs?: boolean }) => Promise<{ success: boolean; output?: string; error?: string }>
  grep: (pattern: string, cwd?: string, options?: { include?: string; exclude?: string; maxResults?: number; context?: number; caseInsensitive?: boolean }) => Promise<{ success: boolean; output?: string; error?: string }>
  webFetch: (url: string, options?: { selector?: string; maxLength?: number }) => Promise<{ success: boolean; output?: string; error?: string }>
  webSearch: (query: string, options?: { maxResults?: number; region?: string; engine?: string }) => Promise<{ success: boolean; output?: string; error?: string }>
  /**
   * Verify a Brave API key against the live Brave Search endpoint. Pass a
   * candidate string to test an unsaved draft (recommended from the
   * Settings → Tools form); omit to test whatever Settings currently has
   * saved. Returns a discriminated result — `ok: true` when HTTP 200, else
   * a structured failure with masked key preview and a human message.
   */
  braveTestKey: (candidate?: string) => Promise<ToolTestKeyOk | BraveTestKeyFailure>
  /**
   * Test a Baidu AI Search API key against the live qianfan endpoint.
   * Mirrors {@link ToolsApi.braveTestKey} so the Settings panel can reuse UI.
   */
  baiduTestKey: (candidate?: string) => Promise<ToolTestKeyOk | BaiduTestKeyFailure>
  /**
   * Diagnostic: inspect the exact tool list the AI sees. Optionally pass
   * a specific tool name / alias (e.g. `"web_search"`) to get a "visible
   * yes/no + why hidden" verdict.
   */
  inspectModelVisible: (toolNameOrAlias?: string) => Promise<{
    count: number
    names: string[]
    match?: {
      asked: string
      resolvedName: string | null
      visible: boolean
      hiddenReason?: string
    }
  }>
}

export function buildToolsApi(): ToolsApi {
  return {
    list: () => ipcRenderer.invoke('tool:list'),
    execute: (toolName, input) => ipcRenderer.invoke('tool:execute-ui', toolName, input),
    glob: (pattern, cwd, options) => ipcRenderer.invoke('tool:glob', pattern, cwd, options),
    grep: (pattern, cwd, options) => ipcRenderer.invoke('tool:grep', pattern, cwd, options),
    webFetch: (url, options) => ipcRenderer.invoke('tool:web-fetch', url, options),
    webSearch: (query, options) => ipcRenderer.invoke('tool:web-search', query, options),
    braveTestKey: (candidate) => ipcRenderer.invoke('tool:brave-test-key', candidate),
    baiduTestKey: (candidate) => ipcRenderer.invoke('tool:baidu-test-key', candidate),
    inspectModelVisible: (toolNameOrAlias) =>
      ipcRenderer.invoke('tool:inspect-model-visible', toolNameOrAlias),
  }
}

export interface HooksApi {
  fireStatusLine: (payload: Record<string, unknown>) => Promise<{ ok: true }>
  fireFileSuggestion: (payload: Record<string, unknown>) => Promise<{ ok: true }>
}

export function buildHooksApi(): HooksApi {
  return {
    fireStatusLine: (payload) => ipcRenderer.invoke('hooks:fire-status-line', payload),
    fireFileSuggestion: (payload) => ipcRenderer.invoke('hooks:fire-file-suggestion', payload),
  }
}

export interface SkillsApi {
  list: () => Promise<{ skills: Array<{ name: string; description: string; argumentHint?: string; source: string; disableModelInvocation?: boolean }> }>
  getAll: () => Promise<{
    skills: Array<{
      name: string
      description: string
      source: string
      context: string
      userInvocable: boolean
      disableModelInvocation: boolean
    }>
  }>
  execute: (name: string, args?: string) => Promise<{ success: boolean; output?: string; error?: string; context: string }>
  reload: (workspacePath?: string) => Promise<{ skills: Array<{ name: string; description: string; argumentHint?: string; source: string }> }>
  getAgentContext: () => Promise<{ prompt: string; skillCount: number }>
  /**
   * Audit P1-7 (2026-05): subscribe to the main-process `skill:reloaded`
   * broadcast that fires when `electron/skills/handlers.ts` hot-reloads
   * after a SKILL.md edit / git pull / external write. Returns an
   * unsubscribe function. Without this listener the renderer's skill list
   * silently went stale until the user manually clicked Reload.
   */
  onReloaded: (
    cb: (payload: {
      skills: Array<{ name: string; description: string; argumentHint?: string; source: string }>
    }) => void,
  ) => () => void
}

export function buildSkillsApi(): SkillsApi {
  return {
    list: () => ipcRenderer.invoke('skill:list'),
    getAll: () => ipcRenderer.invoke('skill:get-all'),
    execute: (name, args) => ipcRenderer.invoke('skill:execute', name, args),
    reload: (workspacePath) => ipcRenderer.invoke('skill:reload', workspacePath),
    getAgentContext: () => ipcRenderer.invoke('skill:get-agent-context'),
    onReloaded: (cb) => {
      const listener = (
        _event: unknown,
        payload: {
          skills: Array<{ name: string; description: string; argumentHint?: string; source: string }>
        },
      ): void => {
        cb(payload)
      }
      ipcRenderer.on('skill:reloaded', listener as (...args: unknown[]) => void)
      return () => {
        ipcRenderer.off('skill:reloaded', listener as (...args: unknown[]) => void)
      }
    },
  }
}

export interface PluginApi {
  fetchMarketplaceIndex: (
    urlOverride?: string | null,
  ) => Promise<{ success: boolean; pluginIds?: string[]; error?: string }>
  detectDelisted: (
    installedIds: string[],
    marketplaceUrl?: string | null,
  ) => Promise<{ delisted: string[]; error?: string }>
  bundleCachePath: () => Promise<{ path: string }>
  installMcpbBundle: (
    filePath: string,
  ) => Promise<
    | { success: true; added: string[]; cachePath: string }
    | { success: false; error: string; cachePath?: string }
  >
}

export function buildPluginApi(): PluginApi {
  return {
    fetchMarketplaceIndex: (urlOverride) =>
      ipcRenderer.invoke('plugin:fetch-marketplace-index', urlOverride ?? null),
    detectDelisted: (installedIds, marketplaceUrl) =>
      ipcRenderer.invoke('plugin:detect-delisted', installedIds, marketplaceUrl ?? null),
    bundleCachePath: () => ipcRenderer.invoke('plugin:bundle-cache-path'),
    installMcpbBundle: (filePath) => ipcRenderer.invoke('plugin:install-mcpb-bundle', filePath),
  }
}
