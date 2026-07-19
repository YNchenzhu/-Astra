/**
 * Persistent conversational / runtime-analytics bridges.
 *
 * Groups five closely-related storage surfaces:
 *   - `memory:*`        long-lived user memory + auto-extraction
 *   - `context:*`       per-conversation token-budget analysis
 *   - `session:*`       scoped session lifecycle
 *   - `conversation:*`  on-disk conversation store (bundle-partitioned)
 *   - `telemetry:*`     ring-buffer events for Settings / bug-report UI
 *
 * Packaged together because they all revolve around conversation state
 * (write/read, summarise, analyze, export) and evolve in lockstep when
 * new bundle / model / context-packer semantics land.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'

export interface MemoryApi {
  list: () => Promise<Record<string, unknown>[]>
  scanMemdir: () => Promise<Record<string, unknown>[]>
  get: (filename: string) => Promise<Record<string, unknown>>
  create: (params: { name: string; description: string; type: string; content: string }) => Promise<Record<string, unknown>>
  update: (params: { filename: string; name?: string; description?: string; type?: string; content?: string }) => Promise<Record<string, unknown>>
  delete: (filename: string) => Promise<{ success: boolean }>
  setWorkspace: (path: string | null) => Promise<{ success: boolean }>
  recallForPrompt: (userMessage: string) => Promise<string>
  /**
   * Two-form invocation:
   *   - `recallForPromptAi(userMessage)`                                      ← legacy
   *   - `recallForPromptAi({ userMessage, alreadySurfaced: string[] })`       ← preferred
   *
   * The object form lets callers (e.g. MemoryPanel) pass the set of memory
   * filenames that were already attached earlier in the conversation, so the
   * AI selector won't re-surface them. Strings are coerced to the legacy form
   * so existing renderer code keeps working.
   */
  recallForPromptAi: (
    payload:
      | unknown
      | { userMessage: unknown; alreadySurfaced?: string[] },
  ) => Promise<string>
  teamSync: () => Promise<{ exported: number; imported: number; teamDir: string }>
  lastRecalled: () => Promise<Record<string, unknown>[]>
  toggleEnabled: (params: { filename: string; enabled: boolean }) => Promise<Record<string, unknown> | null>
  getSystemPromptSection: (autoMemoryEnabled: boolean) => Promise<string>
  validateDirectory: (dir: string) => Promise<{ valid: boolean; reason?: string }>
  resetRecallState: () => Promise<{ success: boolean }>
  drainExtractions: () => Promise<{ success: boolean }>
}

export function buildMemoryApi(): MemoryApi {
  return {
    list: () => ipcRenderer.invoke('memory:list'),
    scanMemdir: () => ipcRenderer.invoke('memory:scan-memdir'),
    get: (filename) => ipcRenderer.invoke('memory:get', filename),
    create: (params) => ipcRenderer.invoke('memory:create', params),
    update: (params) => ipcRenderer.invoke('memory:update', params),
    delete: (filename) => ipcRenderer.invoke('memory:delete', filename),
    setWorkspace: (path) => ipcRenderer.invoke('memory:set-workspace', path),
    recallForPrompt: (userMessage) => ipcRenderer.invoke('memory:recall-for-prompt', userMessage),
    recallForPromptAi: (payload) => ipcRenderer.invoke('memory:recall-for-prompt-ai', payload),
    teamSync: () => ipcRenderer.invoke('memory:team-sync'),
    lastRecalled: () => ipcRenderer.invoke('memory:last-recalled'),
    toggleEnabled: (params) => ipcRenderer.invoke('memory:toggle-enabled', params),
    getSystemPromptSection: (autoMemoryEnabled) =>
      ipcRenderer.invoke('memory:get-system-prompt-section', autoMemoryEnabled),
    validateDirectory: (dir) => ipcRenderer.invoke('memory:validate-directory', dir),
    resetRecallState: () => ipcRenderer.invoke('memory:reset-recall-state'),
    drainExtractions: () => ipcRenderer.invoke('memory:drain-extractions'),
  }
}

type AnalyzeInput = {
  model: string
  systemPrompt: string
  messages: Array<Record<string, unknown>>
  toolDefinitions?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
  memoryTokens?: number
  skillTokens?: number
}

export interface ContextApi {
  getState: (conversationId?: string) => Promise<Record<string, unknown>>
  getPromptDiagnostics: (
    payload?: { limit?: number; conversationId?: string } | number,
  ) => Promise<Record<string, unknown>[]>
  renderBaselineReport: (payload: {
    title?: string
    prompt: string
    notes?: string
    limit?: number
    conversationId?: string
  }) => Promise<string>
  renderBaselineComparison: (payload: {
    title?: string
    baselineLabel?: string
    currentLabel?: string
    baseline: Array<Record<string, unknown>>
    current: Array<Record<string, unknown>>
  }) => Promise<string>
  getThresholds: () => Promise<Record<string, unknown>>
  setThresholds: (thresholds: Record<string, unknown>) => Promise<{ success: boolean }>
  reset: (payload?: { conversationId?: string }) => Promise<{ success: boolean }>
  analyze: (input: AnalyzeInput) => Promise<unknown>
  analyzeFormatted: (input: AnalyzeInput) => Promise<unknown>
  analyzeLive: () => Promise<unknown>
  analyzeLiveFormatted: () => Promise<string>
  onDisplayUpdated: (
    callback: (payload: { conversationId: string | null }) => void,
  ) => () => void
  /** Push the renderer-side `providerRegistry.ts` model→window map to main once at boot. */
  setRegistryWindows: (
    map: Record<string, number>,
  ) => Promise<{ success: boolean; count?: number; error?: string }>
  getRegistryWindows: () => Promise<Record<string, number>>
  getUserWindowOverrides: () => Promise<Record<string, number>>
  setUserWindowOverride: (
    payload: { modelId: string; tokens: number },
  ) => Promise<{ success: boolean; error?: string }>
  clearUserWindowOverride: (
    payload: { modelId: string },
  ) => Promise<{ success: boolean; error?: string }>
}

export function buildContextApi(): ContextApi {
  return {
    getState: (conversationId) => ipcRenderer.invoke('context:get-state', conversationId),
    getPromptDiagnostics: (payload) =>
      ipcRenderer.invoke('context:get-prompt-diagnostics', payload),
    renderBaselineReport: (payload) =>
      ipcRenderer.invoke('context:render-baseline-report', payload),
    renderBaselineComparison: (payload) =>
      ipcRenderer.invoke('context:render-baseline-comparison', payload),
    getThresholds: () => ipcRenderer.invoke('context:get-thresholds'),
    setThresholds: (thresholds) => ipcRenderer.invoke('context:set-thresholds', thresholds),
    reset: (payload) => ipcRenderer.invoke('context:reset', payload),
    analyze: (input) => ipcRenderer.invoke('context:analyze', input),
    analyzeFormatted: (input) => ipcRenderer.invoke('context:analyze-formatted', input),
    analyzeLive: () => ipcRenderer.invoke('context:analyze-live'),
    analyzeLiveFormatted: () => ipcRenderer.invoke('context:analyze-live-formatted'),
    onDisplayUpdated: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: { conversationId: string | null }) => {
        callback(payload)
      }
      ipcRenderer.on('context:display-updated', handler)
      return () => ipcRenderer.removeListener('context:display-updated', handler)
    },
    setRegistryWindows: (map) => ipcRenderer.invoke('context:set-registry-windows', map),
    getRegistryWindows: () => ipcRenderer.invoke('context:get-registry-windows'),
    getUserWindowOverrides: () => ipcRenderer.invoke('context:get-user-window-overrides'),
    setUserWindowOverride: (payload) =>
      ipcRenderer.invoke('context:set-user-window-override', payload),
    clearUserWindowOverride: (payload) =>
      ipcRenderer.invoke('context:clear-user-window-override', payload),
  }
}

export interface SessionApi {
  getCurrent: () => Promise<Record<string, unknown>>
  getScoped: (workspacePath: string, conversationId?: string) => Promise<Record<string, unknown> | null>
  end: (opt?: { workspacePath?: string; conversationId?: string }) => Promise<{ success: boolean }>
  list: (workspacePath: string) => Promise<Record<string, unknown>[]>
  /** upstream §3.5 — force session-memory update from current messages (e.g. /summary). */
  manualMemoryExtract: (payload: {
    conversationId: string
    messages: Array<Record<string, unknown>>
  }) => Promise<{ ok: boolean; error?: string }>
  /**
   * Absolute path the `session-memory-internal` scribe writes to for the
   * given (conversationId, workspacePath). Returns `null` when the
   * conversation id is empty.
   */
  getMemoryPath: (payload: {
    conversationId: string
    workspacePath?: string | null
  }) => Promise<string | null>
}

export function buildSessionApi(): SessionApi {
  return {
    getCurrent: () => ipcRenderer.invoke('session:get-current'),
    getScoped: (workspacePath, conversationId) =>
      ipcRenderer.invoke('session:get-scoped', { workspacePath, conversationId }),
    end: (opt) => ipcRenderer.invoke('session:end', opt),
    list: (workspacePath) => ipcRenderer.invoke('session:list', workspacePath),
    manualMemoryExtract: (payload) =>
      ipcRenderer.invoke('session:manual-memory-extract', payload),
    getMemoryPath: (payload) =>
      ipcRenderer.invoke('session:get-memory-path', payload),
  }
}

export interface ConversationApi {
  /**
   * Every method accepts an optional trailing `bundleId` (plan §4.5.4).
   * Default/undefined maps to the `code-dev` bundle whose storage
   * partition is the pre-bundle location on disk — this keeps legacy
   * callers and all pre-existing conversations working without a
   * migration pass.
   */
  save: (params: {
    id: string
    messages: Record<string, unknown>[]
    workspacePath: string
    model?: string
    providerId?: string
    todos?: Record<string, unknown>[]
    bundleId?: string
  }) => Promise<Record<string, unknown>>
  load: (
    convId: string,
    workspacePath: string,
    bundleId?: string,
  ) => Promise<Record<string, unknown>>
  list: (workspacePath: string, bundleId?: string) => Promise<Record<string, unknown>[]>
  delete: (
    convId: string,
    workspacePath: string,
    bundleId?: string,
  ) => Promise<{ success: boolean }>
  rename: (
    convId: string,
    workspacePath: string,
    newTitle: string,
    bundleId?: string,
  ) => Promise<Record<string, unknown>>
  search: (
    query: string,
    workspacePath?: string,
    bundleId?: string,
  ) => Promise<Record<string, unknown>[]>
  autoTitle: (convId: string, workspacePath: string, bundleId?: string) => Promise<string>
  setOrder: (
    workspacePath: string,
    orderedIds: string[],
    bundleId?: string,
  ) => Promise<{ success: boolean }>
  /**
   * §10.4 — 复位指定会话的 thinking-clear latch（保留 lastSuccess 时间戳）。
   * Renderer 在 startNewConversation / clearConversationContext 后调用，让下一轮
   * agentic 请求重新评估 1h idle 条件。返回 success:false 时不应抛错（最坏
   * 情况下 latch 自然滚动）。
   */
  resetThinkingClearLatch: (
    conversationId: string,
  ) => Promise<{ success: boolean }>
}

export function buildConversationApi(): ConversationApi {
  return {
    save: (params) => ipcRenderer.invoke('conversation:save', params),
    load: (convId, workspacePath, bundleId) =>
      ipcRenderer.invoke('conversation:load', convId, workspacePath, bundleId),
    list: (workspacePath, bundleId) =>
      ipcRenderer.invoke('conversation:list', workspacePath, bundleId),
    delete: (convId, workspacePath, bundleId) =>
      ipcRenderer.invoke('conversation:delete', convId, workspacePath, bundleId),
    rename: (convId, workspacePath, newTitle, bundleId) =>
      ipcRenderer.invoke('conversation:rename', convId, workspacePath, newTitle, bundleId),
    search: (query, workspacePath, bundleId) =>
      ipcRenderer.invoke('conversation:search', query, workspacePath, bundleId),
    autoTitle: (convId, workspacePath, bundleId) =>
      ipcRenderer.invoke('conversation:autoTitle', convId, workspacePath, bundleId),
    setOrder: (workspacePath, orderedIds, bundleId) =>
      ipcRenderer.invoke('conversation:set-order', workspacePath, orderedIds, bundleId),
    resetThinkingClearLatch: (conversationId) =>
      ipcRenderer.invoke('conversation:reset-thinking-clear-latch', conversationId),
  }
}

/**
 * Telemetry ring buffer (context events + provider errors). Renderer never
 * writes — only reads for Settings / debug panels and bug-report export.
 * See `electron/telemetry/handlers.ts` for the full event schema.
 */
export interface TelemetryApi {
  recentEvents: (payload?: {
    limit?: number
    sinceMs?: number
    kind?: 'context' | 'provider_error'
  }) => Promise<unknown[]>
  exportBundle: (payload?: { limit?: number }) => Promise<unknown>
  writeBundleToDisk: (payload?: {
    destination?: string
    limit?: number
  }) => Promise<{ path: string }>
  summary: (payload?: { sinceMs?: number }) => Promise<unknown>
}

export function buildTelemetryApi(): TelemetryApi {
  return {
    recentEvents: (payload) => ipcRenderer.invoke('telemetry:recent-events', payload ?? {}),
    exportBundle: (payload) => ipcRenderer.invoke('telemetry:export-bundle', payload ?? {}),
    writeBundleToDisk: (payload) =>
      ipcRenderer.invoke('telemetry:write-bundle-to-disk', payload ?? {}),
    summary: (payload) => ipcRenderer.invoke('telemetry:summary', payload ?? {}),
  }
}
