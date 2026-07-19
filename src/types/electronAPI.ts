import type {
  DiagnosticsHubPatch,
  DiagnosticsHubSnapshot,
} from './diagnosticsHub'
import type {
  BuddyStateResponse,
  BuddyTickResult,
  BuddyMoodType,
} from './buddyModels'
import type { SkillInfo } from './agentModels'
import type {
  FileTreeNode,
  IngestedAttachmentResult,
  SearchResultItem,
  ToolDefinitionCompact,
} from './workspaceModels'
import type { ElectronAiApi } from './electronApiParts/ai'
import type {
  ElectronAgentsApi,
  ElectronOrchestrationApi,
} from './electronApiParts/agents'
import type { ElectronMcpApi } from './electronApiParts/mcp'
import type { ElectronContextApi } from './electronApiParts/context'
import type { ElectronBundleApi } from './electronApiParts/bundle'
import type { ElectronLspApi } from './electronApiParts/lsp'
import type { ElectronGitApi } from './electronApiParts/git'
import type { ElectronMemoryApi } from './electronApiParts/memory'
import type { ElectronConversationApi } from './electronApiParts/conversation'
import type {
  ElectronEmbeddingApi,
  ElectronVectorApi,
  ElectronWorkspaceIndexApi,
} from './electronApiParts/embedding'

export interface H5StatusPayload {
  settings: {
    enabled: boolean
    tokenPreview: string | null
    allowedOrigins: string[]
    publicBaseUrl: string | null
    host: string
    port: number
    hasToken: boolean
  }
  server: { running: boolean; host: string; port: number; lanAddress: string | null; lanAddresses: string[] }
  error?: string
}

export interface H5ConfigPatch {
  enabled?: boolean
  allowedOrigins?: string[]
  publicBaseUrl?: string | null
  host?: string
  port?: number
}

export interface ImConfigView {
  serverUrl: string
  defaultProjectDir: string
  wechat: {
    accountId: string
    baseUrl: string
    botTokenPreview: string | null
    hasBotToken: boolean
    allowedUsers: string[]
    pairedUsers: Array<{ userId: string | number; displayName: string; pairedAt: number }>
  }
  pairing: { active: boolean; expiresAt: number | null }
}

export interface ImConfigPatch {
  serverUrl?: string
  defaultProjectDir?: string
  wechat?: {
    accountId?: string
    baseUrl?: string
    botToken?: string
    allowedUsers?: string[]
  }
}

export interface ImConfigResult {
  config: ImConfigView
  suggestedServerUrl: string
}

// Electron API types
declare global {
  interface Window {
    electronAPI: {
      platform: string
      clipboard?: {
        readPngImage: () => Promise<
          | { ok: false }
          | { ok: true; base64: string; mediaType: 'image/png'; size: number }
        >
      }
      debugSessionLog?: (payload: Record<string, unknown>) => void
      onLifecycleLog?: (
        callback: (payload: {
          channelId: string
          message: string
          type?: 'info' | 'warning' | 'error'
        }) => void,
      ) => () => void
      lifecycle?: {
        setBeforeQuitFlushHandler: (fn: () => Promise<void> | void) => () => void
      }
      rendererPrefs?: {
        get: () => Promise<Record<string, string> | null>
        patch: (patch: Record<string, string>) => Promise<{ success: boolean; error?: string }>
      }
      ai: ElectronAiApi
      plugin: {
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
      settings: {
        get: () => Promise<Record<string, unknown>>
        set: (settings: Record<string, unknown>) => Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>
      }
      h5: {
        getStatus: () => Promise<H5StatusPayload>
        setConfig: (patch: H5ConfigPatch) => Promise<H5StatusPayload>
        generateToken: () => Promise<{ token: string; preview: string; status: H5StatusPayload }>
        start: () => Promise<H5StatusPayload>
        stop: () => Promise<H5StatusPayload>
      }
      im: {
        getConfig: () => Promise<ImConfigResult>
        setConfig: (patch: ImConfigPatch) => Promise<ImConfigResult>
        generatePairingCode: () => Promise<{ code: string; expiresAt: number; config: ImConfigView }>
        wechatStartLogin: () => Promise<{ sessionKey: string; qrDataUrl: string; message: string }>
        wechatPollLogin: (sessionKey: string) => Promise<{ connected: boolean; status: string; message: string; config: ImConfigView }>
        wechatUnbind: () => Promise<{ config: ImConfigView }>
        wechatSidecarStatus: () => Promise<{ running: boolean; error: string | null; bundleAvailable: boolean }>
        wechatSidecarStart: () => Promise<{ running: boolean; error: string | null; bundleAvailable: boolean }>
        wechatSidecarStop: () => Promise<{ running: boolean; error: string | null; bundleAvailable: boolean }>
      }
      fs: {
        readFile: (filePath: string) => Promise<{ success: boolean; content?: string; encoding?: string; error?: string }>
        readFileBinary: (filePath: string) => Promise<{ success: boolean; bytes?: Uint8Array; error?: string }>
        writeFile: (filePath: string, content: string) => Promise<{ success: boolean; warning?: string; error?: string }>
        copyFile: (srcPath: string, destPath: string) => Promise<{ success: boolean; error?: string }>
        fileTree: (dirPath: string, maxDepth?: number) => Promise<{ success: boolean; tree?: FileTreeNode[]; error?: string }>
        search: (params: { dirPath: string; query: string; maxResults?: number; maxMatchesPerFile?: number }) => Promise<{ success: boolean; results?: SearchResultItem[]; truncated?: boolean; error?: string }>
        stat: (filePath: string) => Promise<{ success: boolean; isFile?: boolean; isDirectory?: boolean; size?: number; mtime?: string; error?: string }>
        exists: (filePath: string) => Promise<{ success: boolean; exists?: boolean; error?: string }>
        delete: (filePath: string) => Promise<{ success: boolean; error?: string }>
        createDir: (dirPath: string) => Promise<{ success: boolean; error?: string }>
        openDialog: (options?: { title?: string; properties?: string[]; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<{ success: boolean; canceled: boolean; paths: string[] }>
        saveDialog: (options?: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<{ success: boolean; canceled: boolean; path?: string }>
        startWorkspaceWatcher: (workspacePath: string) => Promise<{ success: boolean; error?: string }>
        stopWorkspaceWatcher: () => Promise<{ success: boolean; error?: string }>
        onWorkspaceFileChanged: (callback: (payload: { workspacePath: string; filePath: string; relativePath: string; changeType: 'add' | 'change' | 'unlink' }) => void) => () => void
        showItemInFolder: (fullPath: string) => Promise<{ success: boolean; error?: string }>
        openPath: (fullPath: string) => Promise<{ success: boolean; error?: string }>
        renameInWorkspace: (
          workspaceRoot: string,
          fromRelative: string,
          toRelative: string,
        ) => Promise<{ success: boolean; error?: string }>
      }
      tasks: {
        drainNotifications: () => Promise<{ hasNotifications: boolean; xml: string | null }>
        getPillLabel: () => Promise<{
          pill: { label: string; needsCta: boolean; needsInput: boolean }
          backgroundCount: number
          foregroundCount: number
        }>
        /**
         * Snapshot the V2 TaskManager-managed task list. Optional
         * `conversationId` filter scopes to the active chat. Lifecycle
         * deltas after the snapshot arrive over `ai:stream-event` as
         * `{ type: 'task-v2:lifecycle', event, task }`.
         */
        listV2: (params?: { conversationId?: string }) => Promise<{
          tasks: Array<{
            taskId: string
            subject: string
            description?: string
            activeForm?: string
            status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'
            owner?: string
            source?: string
            blockedBy: string[]
            metadata: Record<string, unknown>
            createdAt: number
            updatedAt: number
            startedAt?: number
            finishedAt?: number
            error?: string
            summary?: string
            runtimeKind?: string
            agentId?: string
            conversationId?: string
            parentTaskId?: string
          }>
        }>
      }
      window: {
        minimize: () => Promise<void>
        maximize: () => Promise<void>
        close: () => Promise<void>
      }
      system: {
        notify: (params: {
          title: string
          body?: string
          silent?: boolean
          onlyWhenMinimized?: boolean
          mode?: 'off' | 'minimized' | 'background' | 'always'
        }) => Promise<{ success: boolean; skipped?: boolean; error?: string }>
      }
      terminal: {
        create: (cwd?: string) => Promise<{ sessionId: number; fallback?: boolean; error?: string }>
        write: (sessionId: number, data: string) => Promise<void>
        resize: (sessionId: number, cols: number, rows: number) => Promise<void>
        close: (sessionId: number) => Promise<void>
        onData: (sessionId: number, callback: (data: string) => void) => () => void
        onExit: (sessionId: number, callback: (exitCode: number) => void) => () => void
        exec: (command: string, cwd?: string) => Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }>
      }
      output: {
        onAppend: (callback: (data: { channelId: string; message: string; type?: string }) => void) => () => void
      }
      tools: {
        list: () => Promise<{ tools: string[]; definitions: ToolDefinitionCompact[] }>
        execute: (toolName: string, input: Record<string, unknown>) => Promise<{ success: boolean; output?: string; error?: string }>
        glob: (pattern: string, cwd?: string, options?: { maxResults?: number; includeDirs?: boolean }) => Promise<{ success: boolean; output?: string; error?: string }>
        grep: (pattern: string, cwd?: string, options?: { include?: string; exclude?: string; maxResults?: number; context?: number; caseInsensitive?: boolean }) => Promise<{ success: boolean; output?: string; error?: string }>
        webFetch: (url: string, options?: { selector?: string; maxLength?: number }) => Promise<{ success: boolean; output?: string; error?: string }>
        webSearch: (query: string, options?: { maxResults?: number; region?: string; engine?: string }) => Promise<{ success: boolean; output?: string; error?: string }>
        braveTestKey: (candidate?: string) => Promise<
          | {
              ok: true
              status: 200
              keyPreview: string
              message: string
              shapeWarnings?: Array<'too-short' | 'wrong-prefix' | 'invalid-charset'>
            }
          | {
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
        >
        baiduTestKey: (candidate?: string) => Promise<
          | {
              ok: true
              status: 200
              keyPreview: string
              message: string
              shapeWarnings?: Array<'too-short' | 'wrong-prefix' | 'invalid-charset'>
            }
          | {
              ok: false
              status: number
              reason:
                | 'none'
                | 'auth_invalid'
                | 'rate_limit'
                | 'server'
                | 'network'
                | 'other'
              keyPreview: string
              message: string
              detail?: string
              shapeWarnings?: Array<'too-short' | 'wrong-prefix' | 'invalid-charset'>
            }
        >
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
      agents: ElectronAgentsApi
      orchestration?: ElectronOrchestrationApi
      mcp: ElectronMcpApi
      planning: {
        getStatus: () => Promise<null | {
          planFilePath: string
          total: number
          pending: number
          inProgress: number
          completed: number
        }>
      }
      memory: ElectronMemoryApi
      context: ElectronContextApi
      session: {
        getCurrent: () => Promise<import('./workspaceModels').SessionSnapshot | null>
        /** Session for workspace + conversation when renderer has no ALS (unlike getCurrent). */
        getScoped: (workspacePath: string, conversationId?: string) => Promise<import('./workspaceModels').SessionSnapshot | null>
        /** Omit args to end all active main-process session slots; pass scope to end one chat only. */
        end: (opt?: { workspacePath?: string; conversationId?: string }) => Promise<{ success: boolean }>
        list: (workspacePath: string) => Promise<Array<{ sessionId: string; title: string; state: string; lastUpdated: string }>>
        manualMemoryExtract: (payload: {
          conversationId: string
          messages: Array<Record<string, unknown>>
        }) => Promise<{ ok: boolean; error?: string }>
        /** Absolute path of the session-memory markdown for this conversation + workspace. */
        getMemoryPath: (payload: {
          conversationId: string
          workspacePath?: string | null
        }) => Promise<string | null>
      }
      conversation: ElectronConversationApi
      buddy: {
        get: () => Promise<BuddyStateResponse>
        hatch: (seed?: string) => Promise<BuddyStateResponse>
        setSpecies: (species: string) => Promise<BuddyStateResponse>
        pet: () => Promise<BuddyStateResponse>
        tick: () => Promise<BuddyTickResult>
        update: (patch: { enabled?: boolean; muted?: boolean; name?: string; persona?: string; emoji?: string; mood?: BuddyMoodType }) => Promise<BuddyStateResponse>
      }
      bundle?: ElectronBundleApi
      skills: {
        list: () => Promise<{ skills: SkillInfo[] }>
        getAll: () => Promise<{ skills: SkillInfo[] }>
        execute: (name: string, args?: string) => Promise<{ success: boolean; output?: string; error?: string; context: string }>
        reload: (workspacePath?: string) => Promise<{ skills: SkillInfo[] }>
        getAgentContext: () => Promise<{ prompt: string; skillCount: number }>
        /**
         * Audit P1-7 (2026-05): subscribe to `skill:reloaded` broadcasts from
         * the main process (fired by `electron/skills/handlers.ts` on
         * SKILL.md hot-reload). Returns an unsubscribe function. Optional so
         * older preload shells that don't expose this listener degrade
         * gracefully.
         */
        onReloaded?: (cb: (payload: { skills: SkillInfo[] }) => void) => () => void
      }
      tabAutocomplete: {
        requestCompletion: (params: {
          prefix: string
          suffix: string
          language?: string
          filePath?: string
          recentSnippets?: Array<{ path: string; content: string }>
        }) => Promise<{ completion: string; latencyMs: number }>
        cancel: () => Promise<void>
      }
      hooks?: {
        fireStatusLine: (payload: Record<string, unknown>) => Promise<{ ok: true }>
        fireFileSuggestion: (payload: Record<string, unknown>) => Promise<{ ok: true }>
      }
      lsp: ElectronLspApi
      diagnostics?: {
        getSnapshot: () => Promise<DiagnosticsHubSnapshot>
        onPatch: (callback: (patch: DiagnosticsHubPatch) => void) => () => void
      }
      workspaceTrust?: {
        check: (payload: { path: string }) => Promise<{ trusted: boolean }>
        list: () => Promise<{ roots: string[] }>
        add: (payload: { path: string }) => Promise<{ success: boolean; error?: string }>
        remove: (payload: { path: string }) => Promise<{ success: boolean; error?: string }>
      }
      git?: ElectronGitApi
      /**
       * DiffTransaction bridge (P1–P4). Observability + user intents.
       *
       * `requestSnapshot` runs once at renderer mount; `onBroadcast` streams incremental
       * `DtBroadcast` events. Intent methods (`intentRetry` / `intentAbort` /
       * `intentRebase` / `intentUndo`) are the renderer-originated side of the DT FSM.
       *
       * Marked optional so a non-Electron test harness that doesn't install the bridge
       * still type-checks — runtime callers in the renderer can safely probe
       * `window.electronAPI.diffTx?.…`.
       */
      diffTx?: {
        requestSnapshot: () => Promise<{ transactions: unknown[] }>
        onBroadcast: (callback: (event: unknown) => void) => () => void
        intentRetry: (id: string) => Promise<{ ok: boolean; state?: string; reason?: string }>
        intentAbort: (
          id: string,
          reason?: string,
        ) => Promise<{ ok: boolean; state?: string; reason?: string }>
        intentRebase: (id: string) => Promise<{ ok: boolean; state?: string; reason?: string }>
        intentUndo: (id: string) => Promise<{ ok: boolean; state?: string; reason?: string }>
      }
      /**
       * Telemetry ring buffer readout (main is the source of truth; renderer
       * only reads for Settings / debug panels and bug-report export). See
       * `electron/telemetry/handlers.ts`.
       */
      telemetry?: {
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
      /**
       * Attachment ingestion + sha256-keyed disk cache (PDF / Office /
       * CSV / text / image). Renderer uses this to parse files in the
       * main process, stage vision blocks for conversation dehydration,
       * and surface cache stats in Settings → 向量模型.
       */
      attachments?: {
        ingest: (args: { path?: string; name?: string }) => Promise<IngestedAttachmentResult>
        ingestBuffer: (args: { name: string; base64: string }) => Promise<IngestedAttachmentResult>
        cacheGet: (args: { sha256: string; kind: string }) => Promise<IngestedAttachmentResult | null>
        cacheStats: () => Promise<{ files: number; bytes: number }>
        cacheClear: () => Promise<{ removed: number }>
        cacheStageImage: (args: { base64: string; mediaType: string }) => Promise<
          { ok: true; sha256: string } | { ok: false; error: string }
        >
      }
      embedding?: ElectronEmbeddingApi
      vector?: ElectronVectorApi
      workspaceIndex?: ElectronWorkspaceIndexApi
    }
  }
}

export {}
