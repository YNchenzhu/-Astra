/**
 * `app.whenReady()` orchestration.
 *
 * Extracted from `electron/main.ts`. Responsible for the one-time startup
 * sequence: bringing up services (memory / session / conversation / LSP /
 * MCP / cron / bundles / orchestration), wiring the window, hydrating
 * custom agents, and finally registering every renderer-facing IPC
 * channel that depends on the above.
 *
 * The function is invoked once from `main.ts` inside `app.whenReady().then`.
 * Any new subsystem bootstrap belongs here, NOT in `main.ts`.
 */
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'

import { ensureBundleDataLayout } from '../paths/bundleDataPaths'
import { loadSettings } from '../settings/settingsStore'
import { createMainWindow, getMainWindow } from '../window/mainWindow'
import {
  applyRendererCustomAgentsFromMain,
  readPersistedCustomAgentsFile,
} from '../agents/rendererCustomAgentsMain'
import { initAgentHistoryStore } from '../agents/activeAgentHistory'
import { registerFileHandlers } from '../fs/handlers'
import { registerWorkspaceTrustHandlers } from '../security/workspaceTrustHandlers'
import { registerLspIpcHandlers } from '../lsp/ipcHandlers'
import { registerPlanningIpcHandlers } from '../planning/ipcHandlers'
import { registerLspAdminIpcHandlers } from '../lsp/adminIpcHandlers'
import { registerDiagnosticsIpcBridge } from '../diagnostics/ipcBridge'
import { registerToolHandlers } from '../ai/tools'
import { registerAdvancedToolHandlers } from '../ai/advancedTools'
import { registerTerminalHandlers } from '../terminal/handler'
import { registerMCPHandlers, reconnectMcpServersOnLaunch } from '../mcp/handlers'
import { registerPluginIntegrationHandlers } from '../plugins/ipcHandlers'
import { registerMemoryHandlers } from '../memory/handlers'
import { initMemoryService } from '../memory/service'
import { registerContextHandlers } from '../context/handlers'
import { registerTelemetryHandlers } from '../telemetry/handlers'
import { registerSessionHandlers } from '../session/handlers'
import { initSessionService } from '../session/service'
import { registerConversationHandlers } from '../conversation/handlers'
import { initConversationService } from '../conversation/service'
import { registerH5Handlers } from '../h5/h5Handlers'
import { registerImHandlers } from '../h5/imHandlers'
import { startH5Server } from '../h5/h5Server'
import { startWechatSidecar } from '../h5/wechatSidecar'
import { registerSkillHandlers } from '../skills/handlers'
import { registerBuddyHandlers } from '../buddy/handlers'
import { initBuddyService } from '../buddy/service'
import { registerGitHandlers } from '../git/handlers'
import { bootstrapBundles, registerBundleHandlers } from '../ipc/bundleHandlers'
import { contextManager } from '../context/manager'
import { setUserContextWindowOverridesBulk } from '../context/modelWindowOverrides'
import { initOrchestrationStore } from '../orchestration/store'
import { logAppendixABootstrapPhase } from '../orchestration/appendixAFlow'
import { initEventDrivenNetwork } from '../events/EventDrivenNetwork'
import { installRuntimeHookBridges } from '../tools/hooks/runtimeHookBridges'
import { installCacheSafeParamsSnapshotHook } from '../agents/cacheSafeParams'
import { applySandboxFromSettingsRecord } from '../utils/sandbox'
import {
  setPermissionRelayResolver,
} from '../ai/permissionRelayBridge'
import { respondPermissionRequest } from '../ai/interactionState'
import { initializeLspServerManager } from '../lsp/manager'
import {
  initAgentTools,
  rebuildAgentDefinitions,
  setDisabledCustomAgentTypes,
  toolRegistry,
} from '../tools/registry'
import { getWorkspacePath } from '../tools/workspaceState'
import { getToolDefinitions } from '../tools/schema'
import { initCronScheduler, setCronFireHandler } from '../tools/cronScheduler'

import { wireDiskSettingsAccess } from '../ipc/handlers/settingsHandlers'
import {
  getDisabledCustomAgentsFromSettings,
  registerAgentsHandlers,
  restartCustomAgentsWatcher,
} from '../ipc/handlers/agentsHandlers'
import { registerSettingsHandlers } from '../ipc/handlers/settingsHandlers'
import { registerAiHandlers } from '../ipc/handlers/aiHandlers'
import { registerToolIpcHandlers } from '../ipc/handlers/toolHandlers'
import { registerWindowHandlers } from '../ipc/handlers/windowHandlers'
import { registerAttachmentHandlers } from '../ipc/handlers/attachmentHandlers'
import { registerEmbeddingHandlers } from '../ipc/handlers/embeddingHandlers'
import { registerTaskHandlers } from '../ipc/handlers/taskHandlers'
import {
  registerSystemHandlers,
  wireTaskManagerV2LifecycleBridge,
  wireTaskRuntimeOutputBridge,
} from '../ipc/handlers/systemHandlers'
import { registerOrchestrationHandlers } from '../ipc/handlers/orchestrationHandlers'

export async function bootstrapApp(bundleDataRoot: string): Promise<void> {
  logAppendixABootstrapPhase('P0_app_when_ready', { phase: 'app.whenReady' })

  // Wire the tool-worker host's workspace-path provider before any
  // tool dispatch can happen. The host stays lazy (no worker spawn
  // until a `runIn:'worker'` tool is invoked with the feature flag
  // enabled), so this is cheap.
  try {
    const { getToolWorkerHost, refreshToolWorkerFromMainDiskSettingsIfEnabled } =
      await import('../tools/workerProcess/toolWorkerHost')
    const { isToolWorkerDispatchEnabled } = await import(
      '../tools/workerProcess/toolWorkerEnv'
    )
    const { onWorkspacePathChange } = await import('../tools/workspaceState')
    getToolWorkerHost().setWorkspacePathProvider(() => getWorkspacePath())
    // Worker boots before the user opens a folder (prewarm). Re-send
    // `tool_init` whenever the main workspace path changes so the worker's
    // own `workspaceState` singleton stays in sync — without this, file tools
    // dispatched into the worker see `workspacePath = null` and reject with
    // "No workspace folder is open" even after the user opens a folder.
    onWorkspacePathChange(() => {
      refreshToolWorkerFromMainDiskSettingsIfEnabled()
    })
    if (isToolWorkerDispatchEnabled()) {
      try {
        await getToolWorkerHost().prewarm()
      } catch (prewarmErr) {
        console.warn('[bootstrapApp] tool-worker prewarm failed:', prewarmErr)
      }
    }
  } catch (err) {
    console.warn('[bootstrapApp] tool-worker host wiring failed:', err)
  }

  // Sub-agent Worker pool — pre-spawn 2 hot workers so the first
  // Explore/Plan/Verification spawn skips the ~1.5-3.5s cold-start tax
  // (Worker thread spawn + module-graph cold import). Idempotent;
  // disabled when `POLE_AGENT_WORKER_POOL=0`; pool size override via
  // `POLE_AGENT_WORKER_POOL_SIZE` (see `subAgentWorkerPool.ts`).
  try {
    const { initSubAgentWorkerPool } = await import('../agents/subAgentWorkerPool')
    initSubAgentWorkerPool()
  } catch (err) {
    console.warn('[bootstrapApp] sub-agent worker pool init failed:', err)
  }

  // One-shot: archive pre-fingerprint vector caches into a `vector-store-
  // legacy-<ts>/` directory and drop a marker so we don't re-probe on
  // subsequent launches. Pure caches → safe to archive without rebuild.
  // Fire-and-forget (non-blocking startup); we broadcast the report to
  // the renderer once mainWindow exists so the UI can show a one-time
  // toast inviting the user to delete the archive.
  void import('../embedding/migration').then(async ({ migrateVectorStoreV1ToV2 }) => {
    try {
      const report = await migrateVectorStoreV1ToV2()
      const w = getMainWindow()
      if (report.migrated && w && !w.isDestroyed()) {
        w.webContents.send('embedding:migration-report', report)
      }
    } catch (err) {
      console.warn('[Main] vector-store v1→v2 migration failed:', err)
    }
  })

  // Install-time wiring: disk-settings loader/writer share the same load →
  // merge → save + hooks semantics as `settings:set`.
  wireDiskSettingsAccess()

  setPermissionRelayResolver((requestId, behavior) => {
    respondPermissionRequest({ requestId, behavior })
  })

  // Wire the lifecycle event bus (TaskManager → lifecycleEventBus → subscribers).
  // Without this, `TaskCompleted` / `TaskFailed` never fire and downstream
  // consumers (post-task memory extraction, audit log) are dormant. We route
  // the subscriber `appendOutput(channelId, message, type)`
  // payloads to the renderer via the `output:append` IPC channel, which the
  // Output panel (`TerminalPanel.tsx`) already subscribes to through the
  // `electronAPI.output.onAppend` preload surface — previously this channel
  // had no sender and the subscription was dead.
  initEventDrivenNetwork((channelId, message, type) => {
    const w = getMainWindow()
    if (w && !w.isDestroyed()) {
      try {
        w.webContents.send('output:append', { channelId, message, type })
      } catch {
        /* ignore send errors during reload */
      }
    }
  })

  const win = createMainWindow()
  const settings = loadSettings()
  applySandboxFromSettingsRecord(settings.sandbox)

  // 系统级持久化修复：把用户在「设置 → 上下文」中保存的阈值从磁盘应用到
  // 主进程单例 `contextManager`。之前 `context:set-thresholds` IPC 只更新
  // 内存，重启后所有阈值都会回到 DEFAULT_THRESHOLDS，用户设置等同于无效。
  // updateThresholds 已做 NaN/非数字字段回退与 anchorBudgetChars 下限校验。
  const persistedContextThresholds = (settings as Record<string, unknown>).contextThresholds
  if (persistedContextThresholds && typeof persistedContextThresholds === 'object') {
    try {
      contextManager.updateThresholds(persistedContextThresholds as Record<string, number>)
    } catch (err) {
      console.warn('[Main] Failed to apply persisted contextThresholds:', err)
    }
  }

  // Per-model context-window user overrides (Settings → 上下文 → 模型窗口覆盖).
  // Registry-declared windows are pushed by the renderer at boot via
  // `context:set-registry-windows`; this slot only carries user-edited values.
  const persistedWindowOverrides = (settings as Record<string, unknown>).modelContextWindowOverrides
  if (persistedWindowOverrides && typeof persistedWindowOverrides === 'object') {
    try {
      setUserContextWindowOverridesBulk(persistedWindowOverrides as Record<string, number>)
    } catch (err) {
      console.warn('[Main] Failed to apply persisted modelContextWindowOverrides:', err)
    }
  }
  const dataStoragePath = (settings.dataStoragePath as string) || app.getPath('userData')
  const agentStoragePath = (settings.agentStoragePath as string) || path.join(app.getPath('userData'), '.agents')

  initOrchestrationStore(app.getPath('userData'))
  // Sprint 3.4: load persisted agent run history into memory so
  // the Running Agents panel can show entries from previous sessions.
  try {
    initAgentHistoryStore(app.getPath('userData'))
  } catch (err) {
    console.warn('[Main] initAgentHistoryStore failed:', err)
  }

  // Import-time-equivalent IPC surface. These used to live at the top
  // level of `main.ts`; extracting them as `register*Handlers(ipcMain)`
  // lets us keep registration ordering explicit.
  registerSettingsHandlers(ipcMain)
  registerAgentsHandlers(ipcMain)
  registerOrchestrationHandlers(ipcMain)
  registerAiHandlers(ipcMain)
  registerToolIpcHandlers(ipcMain)
  registerWindowHandlers(ipcMain)

  registerFileHandlers(ipcMain)
  registerWorkspaceTrustHandlers(ipcMain)
  registerLspIpcHandlers(ipcMain)
  registerPlanningIpcHandlers(ipcMain)
  registerToolHandlers(ipcMain)
  registerAdvancedToolHandlers(ipcMain)
  registerTerminalHandlers(ipcMain, win)
  registerMCPHandlers(ipcMain)
  void reconnectMcpServersOnLaunch().catch((err) => {
    console.warn('[Main] MCP startup auto-reconnect failed:', err)
  })

  // ---------- LSP admin + Diagnostics Hub IPC (new-feature wire-up) ----------
  registerLspAdminIpcHandlers(ipcMain, { getMainWindow })
  registerDiagnosticsIpcBridge(ipcMain, {
    getWindows: () => BrowserWindow.getAllWindows(),
  })

  // ---------- DiffTransaction subsystem (P1/P2/P3/P4) ----------
  //
  // One consolidated block so it survives the "file got reverted externally" pattern we
  // saw during P3 development. If you need to rip this out for a rollback, delete from
  // here to the matching end-of-block marker — no other code references these modules.
  {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dt = require('../diff') as typeof import('../diff')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dtIpc = require('../diff/diffTxIpc') as typeof import('../diff/diffTxIpc')
    dtIpc.initDiffTxIpc(ipcMain, win)
    dtIpc.setDiffTxIpcWindow(win)
    dt.initDiffTxIntentsIpc(ipcMain)
    dt.attachStaleWatcher({ autoStart: true })
    dt.attachUndoQueue({ autoStart: true })
    try {
      dt.attachWal({
        rootDir: path.join(app.getPath('userData'), 'diff-txs'),
        // Stable id (NOT per-pid): a per-pid namespace meant every restart read an
        // empty new dir, so crash recovery never found the prior session's in-flight
        // DTs and old pid-* dirs leaked forever. A fixed id lets rehydrate() actually
        // recover the last session; attachWal() migrates+sweeps any legacy pid-* dirs.
        sessionId: 'default',
      })
    } catch (e) {
      console.warn('[main] diff-tx WAL attach failed (non-fatal):', e)
    }
  }
  // ---------- end DiffTransaction subsystem ----------

  registerPluginIntegrationHandlers(ipcMain)
  // BUG-P1 fix: cron task delivery resilience.
  //
  // Before: when the BrowserWindow is destroyed (closed, recreated, or
  // not-yet-created), the fire was silently dropped — no log, no retry,
  // no observability. Scheduled agent tasks could be permanently lost
  // every time the user closed and reopened the window between fires.
  //
  // After: log the missed fire so operators can see what happened, and
  // queue it for delivery once the renderer is back. Tasks scheduled
  // less than 30s ago are considered "fresh" and re-emitted; older
  // queued tasks are dropped (the task's own recurring schedule will
  // pick them up next tick if relevant).
  const pendingCronFires: Array<{
    taskId: string
    cron: string
    prompt: string
    agentId?: string
    firedAt: number
  }> = []
  const PENDING_CRON_MAX = 64
  const PENDING_CRON_TTL_MS = 30_000

  function flushPendingCronFires(): void {
    if (pendingCronFires.length === 0) return
    const w = getMainWindow()
    if (!w || w.isDestroyed()) return
    const now = Date.now()
    let delivered = 0
    let expired = 0
    while (pendingCronFires.length > 0) {
      const entry = pendingCronFires.shift()!
      if (now - entry.firedAt > PENDING_CRON_TTL_MS) {
        expired++
        continue
      }
      try {
        w.webContents.send('ai:cron-fire', entry)
        delivered++
      } catch (err) {
        console.warn('[appBootstrap] flushPendingCronFires send failed:', err)
      }
    }
    if (delivered > 0 || expired > 0) {
      console.log(
        `[appBootstrap] flushed cron queue (delivered=${delivered}, expired=${expired})`,
      )
    }
  }

  setCronFireHandler((task) => {
    const payload = {
      taskId: task.id,
      cron: task.cron,
      prompt: task.prompt,
      agentId: task.agentId,
      firedAt: Date.now(),
    }
    const w = getMainWindow()
    if (w && !w.isDestroyed()) {
      try {
        w.webContents.send('ai:cron-fire', payload)
      } catch (err) {
        console.warn('[appBootstrap] cron-fire send failed, queuing:', err)
        pendingCronFires.push(payload)
        if (pendingCronFires.length > PENDING_CRON_MAX) {
          pendingCronFires.shift() // drop oldest
        }
      }
      return
    }
    console.warn(
      `[appBootstrap] cron-fire arrived without an active window (taskId=${task.id}, cron=${task.cron}); queueing for renderer ready`,
    )
    pendingCronFires.push(payload)
    if (pendingCronFires.length > PENDING_CRON_MAX) {
      pendingCronFires.shift() // drop oldest to bound memory
    }
  })

  // Drain the queue every time a window comes up. Cheap on the steady
  // state (queue is empty) and recovers cron deliveries that arrived
  // while the window was being recreated (e.g. after a workspace switch).
  app.on('browser-window-created', (_e, win) => {
    win.webContents.once('did-finish-load', flushPendingCronFires)
  })
  await initCronScheduler(dataStoragePath)
  // Audit P0-3 (2026-05): hydrate the V2 TaskManager persistence layer
  // BEFORE registering agent tools, so the first tool invocation already
  // sees any tasks the previous run had open. Previously the function was
  // defined in `electron/tools/TaskManager.ts` but had zero call sites —
  // V2 Task tools would always start with an empty tasks/counter snapshot
  // across restarts, regardless of what was on disk.
  try {
    const { initTaskManagerPersistence } = await import('../tools/TaskManager')
    initTaskManagerPersistence(app.getPath('userData'))
  } catch (err) {
    console.warn('[Main] initTaskManagerPersistence failed (non-fatal):', err)
  }
  initAgentTools(undefined, agentStoragePath)

  // Hydrate the renderer-snapshot (localStorage-backed custom agents) and the
  // "hidden from main AI" set from the on-disk settings file so the Agent
  // tool's routing description matches what the user configured last session.
  const persistedAgents = readPersistedCustomAgentsFile(agentStoragePath)
  if (persistedAgents.length > 0) {
    applyRendererCustomAgentsFromMain(persistedAgents, {
      workspacePath: getWorkspacePath(),
      userDataPath: agentStoragePath,
      agentStoragePath: undefined,
    })
  }
  try {
    setDisabledCustomAgentTypes(getDisabledCustomAgentsFromSettings())
    // Trigger a rebuild so the disabled filter kicks in even when the user
    // has no renderer custom agents (pure disk-only case).
    rebuildAgentDefinitions(getWorkspacePath(), agentStoragePath, undefined)
  } catch (err) {
    console.warn('[Main] Failed to hydrate disabledCustomAgents:', err)
  }
  // Start the .md watcher so external edits (text editor / git pull / another
  // Claude-family tool) hot-reload the Agent tool list.
  restartCustomAgentsWatcher()

  // ---------- Bundle system (§4.5.10 of personal workspace plan) ----------
  //
  // Register IPC handlers first so the renderer can query while we activate;
  // then run the initial scan + activation. Mounted AFTER `setDiskSettingsLoader`
  // so `readPersistedLastActiveBundleId` sees real settings, and AFTER custom
  // agents are hydrated so later phases can merge bundle agents with customs.
  //
  // Failure here is non-fatal: if the bundles dir is missing or all preset
  // JSONs are malformed, the app continues without an active bundle (the
  // renderer falls back to the legacy single-workspace UI path).
  try {
    registerBundleHandlers(app, {
      getMainWindow,
      getWorkspacePath: () => getWorkspacePath(),
    })
    const activeBundle = bootstrapBundles(app, getWorkspacePath())
    if (activeBundle) {
      console.log(
        `[Main] Bundle activated: ${activeBundle.meta.id} (${activeBundle.meta.name})`,
      )
    } else {
      console.warn('[Main] No bundle activated at startup (no presets found?)')
    }
  } catch (err) {
    console.error('[Main] Bundle bootstrap failed (non-fatal):', err)
  }
  // ---------- end Bundle system ----------

  // ---------- Plan runtime ----------
  // Bind the TaskManager → plan-file sync listener and rehydrate the latest
  // persisted plan for this workspace. Audit F-01 / F-02: previously
  // `initPlanRuntime` only ran on the first ExitPlanMode of a session and
  // `restoreLatestPlan` had no caller at all, so an app restart silently
  // dropped the live plan link (the `.plan.md` and its V2 tasks survived on
  // disk, but `activePlan` was null and progress sync was dead until the user
  // re-ran ExitPlanMode). Runs AFTER `initTaskManagerPersistence` (above) so
  // the restore reconciles against the already-hydrated task store.
  try {
    const { initPlanRuntime, restoreLatestPlan } = await import('../planning/planRuntime')
    initPlanRuntime()
    const wsForPlan = getWorkspacePath()
    if (wsForPlan && restoreLatestPlan(wsForPlan)) {
      console.log('[Main] Restored latest plan for workspace')
    }
  } catch (err) {
    console.warn('[Main] Plan runtime bootstrap failed (non-fatal):', err)
  }
  // ---------- end Plan runtime ----------

  initMemoryService(bundleDataRoot)
  registerMemoryHandlers(ipcMain)
  registerContextHandlers(ipcMain)
  registerTelemetryHandlers(ipcMain)
  initSessionService(app.getPath('userData'), dataStoragePath)
  registerSessionHandlers(ipcMain)
  initConversationService(app.getPath('userData'), dataStoragePath)
  registerConversationHandlers(ipcMain)

  // H5 / remote-access server (opt-in). Handlers are always registered so the
  // Settings panel works; the HTTP/WS server only starts when enabled on disk.
  registerH5Handlers(ipcMain)
  registerImHandlers(ipcMain)
  void startH5Server()
    .then(() => {
      // Auto-launch the WeChat adapter sidecar if an account is already bound.
      // No-op (with a recorded reason) when not bound or the bundle is absent.
      try {
        startWechatSidecar()
      } catch (err) {
        console.warn('[appBootstrap] WeChat sidecar autostart failed (non-fatal):', err)
      }
    })
    .catch((err) => {
      console.warn('[appBootstrap] H5 server autostart failed (non-fatal):', err)
    })
  // §10.3 — cross-restart persistence for the thinking-block signature
  // strip-on-model-change guard. Seeds the in-memory
  // `lastStreamModelByConversation` map from a sidecar JSON next to the
  // conversation folders, so a model swap that straddles a restart still
  // triggers signature stripping on the post-restart turn. See
  // `electron/context/anthropicThinkingTranscript.ts` for the sidecar
  // format and write semantics. Shared storage root with
  // `initConversationService` above by design — same lifecycle, same
  // user-data partition rules.
  void import('../context/anthropicThinkingTranscript').then(
    ({ initThinkingStreamModelPersistence }) => {
      initThinkingStreamModelPersistence(dataStoragePath)
    },
  ).catch(() => { /* non-fatal: degrade gracefully to in-memory only */ })

  registerAttachmentHandlers(ipcMain)
  registerEmbeddingHandlers(ipcMain)

  // IndexerManager — wrap buildWorkspaceIndex with cancel + state tracking.
  // Register shutdown cleanup so the embedding worker terminates on app exit.

  installRuntimeHookBridges()

  // Take a serialisable snapshot of the main agent's turn-end state on every
  // query-loop termination. Downstream consumers (background dream/extract
  // workers, remote IM adapters, future side-query paths) read the latest
  // snapshot via `getLatestCacheSafeParams(conversationId)` instead of
  // racing with the live ALS context. upstream parity (§query/stopHooks).
  installCacheSafeParamsSnapshotHook()

  // Skills before LSP so loadLspConfigs can merge skill-scoped `.lsp.json`.
  // Pass the workspace path and the main-window accessor so the SKILL.md
  // file watcher (BUG-SK2 fix) can hot-reload the skill registry and
  // notify the renderer when a skill changes on disk.
  registerSkillHandlers(
    ipcMain,
    getWorkspacePath() || undefined,
    app.getPath('userData'),
    () => getMainWindow(),
  )
  // Hydrate buddy state from `<userData>/buddy-state.json` BEFORE registering
  // IPC. Renderer's first `buddy:get` would otherwise hit `getBuddyState`'s
  // lazy `defaultState('cursor-ui-clone')` fallback and skip the persisted
  // enabled/muted/mood the user last set (audit finding P0-1).
  try {
    initBuddyService(app.getPath('userData'))
  } catch (err) {
    console.warn('[Main] initBuddyService failed (non-fatal):', err)
  }
  registerBuddyHandlers(ipcMain)
  registerGitHandlers(ipcMain)

  // Initialize LSP server manager (async, non-blocking)
  initializeLspServerManager(undefined, app.getPath('userData'))

  // Subscribe to task runtime output events and broadcast via IPC.
  wireTaskRuntimeOutputBridge()
  // Subscribe to V2 TaskManager lifecycle events (upstream parity for
  // `useTasksV2` fs.watch + signal) and broadcast via IPC so the
  // renderer's task list slice can mirror them in real time.
  wireTaskManagerV2LifecycleBridge()

  registerTaskHandlers(ipcMain)
  registerSystemHandlers(ipcMain)

  logAppendixABootstrapPhase('P0_ipc_handlers_registered', {
    phase: 'after_ipc_skill_memory_session_conversation',
    handlers: [
      'file', 'workspace_trust', 'lsp', 'tool', 'advanced_tool',
      'terminal', 'mcp', 'plugin', 'memory', 'context', 'session', 'conversation', 'skill',
      'buddy', 'clipboard', 'renderer_prefs', 'tab_autocomplete', 'system_notify',
    ],
    orchestrationKernel: true,
  })
  logAppendixABootstrapPhase('P0_agent_tools_initialized', {
    toolCount: toolRegistry.list().length,
    definitionCount: getToolDefinitions().length,
    toolNames: toolRegistry.list().slice(0, 30),
    mcpInitialized: true,
    pluginsInitialized: true,
    cronInitialized: true,
    lspInitialized: true,
    memoryInitialized: true,
    sessionInitialized: true,
    conversationInitialized: true,
    bundleDataRoot,
  })

  console.log('[Main] Available tools:', toolRegistry.list())
  console.log('[Main] Tool definitions count:', getToolDefinitions().length)
}

/** Install-side root computed early in main.ts, forwarded here for the
 *  memory-service ctor. Re-exported for ergonomics. */
export { ensureBundleDataLayout }
