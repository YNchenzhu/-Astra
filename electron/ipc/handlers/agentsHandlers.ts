/**
 * IPC handlers + helpers for the Agents panel (custom-agent management).
 *
 * Channels exposed:
 *   - `agents:sync-custom`     persist renderer snapshot + refresh main tools
 *   - `agents:list-all`        disk-backed agents grouped by scope
 *   - `agents:list-active`     live registry + disk run-history
 *   - `agents:abort-active`    kill a running agent
 *   - `agents:save-to-disk`    write agent.md to scope-selected directory
 *   - `agents:delete-from-disk` delete agent.md and rebuild tool list
 *   - `agents:set-disabled`    hide agents from main AI routing
 *   - `agents:set-extra-dirs`  add user-owned scan roots + rewire watcher
 *   - `agents:pick-directory`  native folder picker
 *
 * Plus the broadcast helper `broadcastAgentsChanged()` and the chokidar-
 * watcher lifecycle (`restartCustomAgentsWatcher` / `disposeCustomAgentsWatcher`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { app, dialog, type IpcMain } from 'electron'
import { validatedHandle } from '../validatedHandle'
import {
  agentsSyncCustomArgs,
  agentsListAllArgs,
  agentsListActiveArgs,
  agentsAbortActiveArgs,
  agentsPauseActiveArgs,
  agentsResumeActiveArgs,
  agentsSaveToDiskArgs,
  agentsDeleteFromDiskArgs,
  agentsSetDisabledArgs,
  agentsSetExtraDirsArgs,
  agentsPickDirectoryArgs,
} from '../schemas'
import { loadSettings, saveSettings } from '../../settings/settingsStore'
import { getMainWindow, sendToMainWindow } from '../../window/mainWindow'
import {
  applyRendererCustomAgentsFromMain,
  parseRendererCustomAgentsPayload,
} from '../../agents/rendererCustomAgentsMain'
import {
  listAllDiskAgentsForPanel,
  saveAgentMarkdown,
  deleteAgentMarkdown,
} from '../../agents/agentsPanelService'
import { startCustomAgentsWatcher } from '../../agents/customAgentsWatcher'
import { rebuildAgentDefinitions, setDisabledCustomAgentTypes } from '../../tools/registry'
import { getWorkspacePath } from '../../tools/workspaceState'
import {
  getActiveAgents,
  lookupActiveAgent,
  markActiveAgentKilled,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_MAX_AGENT_TOKEN_BUDGET,
} from '../../agents/activeAgentRegistry'
import { getAgentHistorySnapshot } from '../../agents/activeAgentHistory'
import {
  interruptOrchestrationKernelForConversation,
  pauseOrchestrationKernelForConversation,
  resumeOrchestrationKernelForConversation,
} from '../../orchestration/activeKernelRegistry'
import { getMultiAgentOrchestrator } from '../../agents/multiAgentOrchestratorSingleton'
import { abortToolsInTree } from '../../orchestration/toolRuntime/state'
import { asAgentId } from '../../tools/ids'

/** Broadcast the "agent list changed" ping used by the panel to refresh. */
export function broadcastAgentsChanged(): void {
  try {
    sendToMainWindow('agents:changed')
  } catch (err) {
    console.warn('[agents:changed] broadcast failed:', err)
  }
}

function getExtraAgentDirs(): string[] {
  const s = loadSettings()
  const raw = (s as Record<string, unknown>).customAgentsExtraDirs
  if (!Array.isArray(raw)) return []
  return raw.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
}

export function getDisabledCustomAgentsFromSettings(): string[] {
  const s = loadSettings()
  const raw = (s as Record<string, unknown>).disabledCustomAgents
  if (!Array.isArray(raw)) return []
  return raw.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
}

export function getPanelScopeOpts() {
  const settings = loadSettings()
  const userDataPath =
    (settings.agentStoragePath as string) || path.join(app.getPath('userData'), '.agents')
  return {
    workspacePath: getWorkspacePath() || null,
    userDataPath,
    extraDirs: getExtraAgentDirs(),
  }
}

// Holds the dispose handle of the active chokidar watcher so
// `restartCustomAgentsWatcher` can tear it down before wiring a new one up.
// Keeping it module-scoped (rather than per-window) lets us stop the watcher
// cleanly during `before-quit`.
let disposeCustomAgentsWatcher: (() => void) | null = null

export function restartCustomAgentsWatcher(): void {
  try {
    disposeCustomAgentsWatcher?.()
  } catch (err) {
    console.warn('[agents] dispose previous watcher failed:', err)
  }
  disposeCustomAgentsWatcher = null
  try {
    const opts = getPanelScopeOpts()
    disposeCustomAgentsWatcher = startCustomAgentsWatcher({
      workspacePath: opts.workspacePath,
      userDataPath: opts.userDataPath,
      extraDirs: opts.extraDirs,
      onChange: () => {
        try {
          rebuildAgentDefinitions(opts.workspacePath, opts.userDataPath, undefined)
        } catch (err) {
          console.warn('[agents] rebuild after fs change failed:', err)
        }
        broadcastAgentsChanged()
      },
    })
  } catch (err) {
    console.warn('[agents] startCustomAgentsWatcher failed (non-fatal):', err)
  }
}

export function disposeCustomAgentsWatcherNow(): void {
  try {
    disposeCustomAgentsWatcher?.()
    disposeCustomAgentsWatcher = null
  } catch (err) {
    console.warn('[Main] dispose custom-agents watcher failed:', err)
  }
}

export function registerAgentsHandlers(_ipcMain: IpcMain): void {
  // Sync custom agents (persist JSON + refresh main-process Agent tool / definitions)
  validatedHandle('agents:sync-custom', agentsSyncCustomArgs, async (_event, [agents]) => {
    try {
      const settings = loadSettings()
      const agentStoragePath =
        (settings.agentStoragePath as string) || path.join(app.getPath('userData'), '.agents')

      if (!fs.existsSync(agentStoragePath)) {
        fs.mkdirSync(agentStoragePath, { recursive: true })
      }

      const agentsFile = path.join(agentStoragePath, 'custom-agents.json')
      fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2))

      const snapshots = parseRendererCustomAgentsPayload(agents)
      applyRendererCustomAgentsFromMain(snapshots, {
        workspacePath: getWorkspacePath(),
        userDataPath: agentStoragePath,
        agentStoragePath: undefined,
      })
      broadcastAgentsChanged()

      return { success: true, count: snapshots.length }
    } catch (error) {
      console.error('IPC agents:sync-custom failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  validatedHandle('agents:list-all', agentsListAllArgs, async () => {
    try {
      const opts = getPanelScopeOpts()
      const { agents, scopeDirs } = listAllDiskAgentsForPanel(opts)
      return {
        success: true,
        agents,
        scopeDirs,
        disabledCustomAgents: getDisabledCustomAgentsFromSettings(),
      }
    } catch (error) {
      console.error('IPC agents:list-all failed:', error)
      return {
        success: false,
        agents: [] as unknown[],
        scopeDirs: {
          userGlobal: path.join(app.getPath('home'), '.claude', 'agents'),
          userApp: null,
          project: null,
          extra: [] as string[],
        },
        disabledCustomAgents: [] as string[],
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  // Phase 3 Sprint 3.1a — Running Agents panel.
  //
  // `agents:list-active` serializes the live ActiveAgent map into a
  // renderer-safe snapshot. Excluded fields (internal / security-sensitive):
  //   - abortController, timeoutHandle, resolve       (can't be cloned)
  //   - messages, pendingMessages content             (conversation data;
  //                                                     we expose *count*
  //                                                     but not bodies)
  //   - agentDef                                      (includes closures)
  //
  // We expose everything else the UI needs for a diagnostic panel:
  // identity, lifecycle timestamps, status, token usage vs budget,
  // timeout, mailbox depth, team / parent relationships.
  validatedHandle('agents:list-active', agentsListActiveArgs, async () => {
    const agents = getActiveAgents()
    const now = Date.now()

    // Live entries (includes registry's in-memory terminal history).
    // session-memory-internal is a host-internal scribe that already routes
    // its lifecycle through `sessionMemoryStatus` (header pill) and is hidden
    // from the Agent tool routing list (registryAgentTools.ts:173). Surfacing
    // it in `agents:list-active` would (a) inflate the BundleContextBar
    // running-agent badge with a process the user did not spawn, and (b)
    // appear in the Running Agents panel where it is not abortable in any
    // useful way — its abort path is owned by the trigger / extract module.
    const liveRows = Array.from(agents.values())
      .filter((a) => a.agentType !== 'session-memory-internal')
      .map((a) => ({
      agentId: a.agentId as unknown as string,
      agentType: a.agentType,
      description: a.description,
      name: a.name,
      teamName: a.teamName,
      status: a.status,
      startTime: a.startTime,
      endedAt: a.endedAt,
      elapsedMs: (a.endedAt ?? now) - a.startTime,
      tokenCount: a.tokenCount ?? 0,
      maxTokenBudget: a.agentDef.maxTokenBudget ?? DEFAULT_MAX_AGENT_TOKEN_BUDGET,
      tokenBudgetExceeded: a.tokenBudgetExceeded === true,
      timeoutMs: a.agentDef.timeout ?? DEFAULT_AGENT_TIMEOUT_MS,
      pendingMessageCount: a.pendingMessages.length,
      parentAgentId: a.parentAgentId,
      streamConversationId: a.streamConversationId,
      background: a.agentDef.background === true,
      model: a.agentDef.model,
      // P1-1: spawn-time permission-mode snapshot for the Running Agents
      // panel (upstream §3.1 visibility). May be undefined for legacy /
      // resumed agents that started before the field existed.
      permissionMode: a.permissionModeSnapshot,
      fromDisk: false as const,
    }))

    // Sprint 3.4: merge in disk history for records that aren't still
    // in-memory. Dedupe by agentId — live wins (its fields are fresher).
    const liveIds = new Set(liveRows.map((r) => r.agentId))
    const diskRows = getAgentHistorySnapshot()
      .filter((r) => !liveIds.has(r.agentId))
      .map((r) => ({
        agentId: r.agentId,
        agentType: r.agentType,
        description: r.description,
        name: r.name,
        teamName: r.teamName,
        status: r.status,
        startTime: r.startTime,
        endedAt: r.endedAt,
        elapsedMs: (r.endedAt ?? now) - r.startTime,
        tokenCount: r.tokenCount,
        maxTokenBudget: r.maxTokenBudget,
        tokenBudgetExceeded: r.tokenBudgetExceeded,
        timeoutMs: r.timeoutMs,
        pendingMessageCount: r.pendingMessageCount,
        parentAgentId: r.parentAgentId,
        streamConversationId: r.streamConversationId,
        background: r.background,
        model: r.model,
        // P1-1: persisted snapshot. Older history lines won't have it;
        // the renderer treats missing values as "no badge".
        permissionMode: r.permissionMode,
        fromDisk: true as const,
      }))

    return {
      agents: [...liveRows, ...diskRows],
      fetchedAt: now,
    }
  })

  // `agents:abort-active` flips the registry entry to 'killed', aborts
  // its AbortController, and lets the existing cleanup pathway drop
  // the row via staleness. We don't unregister here — the agentic loop
  // that owns the entry handles its own teardown and resolves the
  // `resolve` promise; unregistering from under it would race.
  //
  // Best-effort orchestration-layer notifications run BEFORE we mutate the
  // registry entry, so any kernel / orchestrator listener sees the agent
  // as still 'running' when their cleanup logic fires:
  //   1. If the parent main-chat conversation has a registered
  //      `OrchestrationKernel`, inform it via `kernel.interrupt('user')`
  //      so its telemetry records the right reason instead of just seeing
  //      the abort signal.
  //   2. Background sub-agents are also tracked in
  //      `MultiAgentOrchestrator`; calling `interruptTree(agentId, 'user')`
  //      cascades the interrupt to any descendants the agent had spawned
  //      itself, mirroring the kernel-tree semantics for legacy agents.
  // Both calls are wrapped in try/catch — bookkeeping must never block the
  // user-visible "stop" action.
  validatedHandle('agents:abort-active', agentsAbortActiveArgs, async (_event, [{ agentId }]) => {
    // Depth-audit finding R2 — route through the discriminated lookup so an
    // ambiguous NAME (≥2 running namesakes) returns a distinct, actionable
    // error instead of `getActiveAgent` silently collapsing it to undefined
    // ("未找到"), which made the agent un-killable by name. Mirrors the
    // `sendToAgent` ambiguity handling.
    const lookup = lookupActiveAgent(agentId)
    if (lookup.kind === 'ambiguous') {
      return {
        ok: false as const,
        error: `名称 "${agentId}" 对应 ${lookup.count} 个运行中的 agent,请改用具体的 agentId 来终止。`,
      }
    }
    if (lookup.kind !== 'found') {
      return { ok: false as const, error: `未找到 id 为 "${agentId}" 的运行中 agent` }
    }
    const agent = lookup.agent
    if (agent.status !== 'running') {
      return {
        ok: false as const,
        error: `Agent "${agentId}" 状态是 ${agent.status},已经结束。`,
      }
    }
    try {
      const convId =
        typeof agent.streamConversationId === 'string'
          ? agent.streamConversationId.trim()
          : ''
      if (convId) {
        try {
          interruptOrchestrationKernelForConversation(convId, 'user')
        } catch (err) {
          console.warn('[agents:abort-active] kernel.interrupt failed:', err)
        }
      }
      // Audit GAP-6 / BUG-6 — cascade the TOOL-tree abort BEFORE interrupting
      // the agent tree. `interruptTree` only aborts kernels / AbortController
      // shims; it does NOT fire tool cancel signals or free quota slots for
      // in-flight tools owned by no-kernel (legacy) sub-agents, which could
      // otherwise keep occupying mutation/shell/network slots until the 120s
      // runtime cleanup. `abortToolsInTree` fires the cancel signals +
      // `markToolAborted` transitively (this is exactly what the
      // `ToolOrchestrator.interruptAgentTree` facade does internally).
      try {
        abortToolsInTree(asAgentId(String(agent.agentId)), 'tree_interrupt:user')
      } catch (err) {
        console.warn('[agents:abort-active] abortToolsInTree failed:', err)
      }
      try {
        const cascaded = getMultiAgentOrchestrator().interruptTree(
          String(agent.agentId),
          'user',
        )
        if (cascaded > 1) {
          console.log(
            `[agents:abort-active] interrupt cascaded to ${cascaded - 1} descendant agent(s) of ${agent.agentId}`,
          )
        }
      } catch (err) {
        console.warn('[agents:abort-active] orchestrator.interruptTree failed:', err)
      }

      // P1-9 + depth-audit R4: delegate the registry mutation to the shared
      // terminal helper so the abort-before-status ordering AND the wall-clock
      // timer cleanup live in one place (see `markActiveAgentKilled`). It
      // aborts the loop's controller BEFORE flipping `status='killed'`, so any
      // downstream `agent.status !== 'running'` check (sendMessage routing,
      // mailbox enqueue, recordAgentTokenUsage, ...) can never observe a
      // "stopped on the surface but still consuming tokens" inversion.
      markActiveAgentKilled(agent)
      return { ok: true as const, agentId: agent.agentId as unknown as string }
    } catch (err) {
      return {
        ok: false as const,
        error: `终止失败:${err instanceof Error ? err.message : String(err)}`,
      }
    }
  })

  // Stage 2.1 — cooperatively pause the orchestration kernel for the given
  // conversation. Pause is observed at the next iteration boundary; in-flight
  // tool execution and streaming are NOT interrupted (use `agents:abort-active`
  // for hard stop). Returns `{ ok: false }` when the conversation has no
  // registered kernel (legacy path / session already ended).
  //
  // Keyed on conversationId rather than agentId because the kernel registry
  // is keyed on conversation; this matches the `orchestration:*` channel shape
  // and lets the renderer pause from any UI surface that has the conversation
  // id (chat header, command palette, etc.) without resolving an agentId.
  validatedHandle(
    'agents:pause-active',
    agentsPauseActiveArgs,
    async (_event, [{ conversationId }]) => {
      const ok = pauseOrchestrationKernelForConversation(conversationId)
      // Contract audit (2026-07) — cascade the pause into every sub-agent
      // registered under this conversation AND report honest coverage.
      // Legacy sub-agents are tracked via an AbortController shim whose
      // `pause()` returns false (no cooperative pause point); previously
      // that gap was invisible and the UI implied the whole conversation
      // paused. The renderer uses `childrenUnsupported` to tell the user
      // which part keeps running.
      let childrenPaused = 0
      let childrenUnsupported = 0
      try {
        const r = getMultiAgentOrchestrator().pauseByConversation(conversationId)
        childrenPaused = r.supported
        childrenUnsupported = r.unsupported
      } catch (err) {
        console.warn('[agents:pause-active] pauseByConversation failed:', err)
      }
      return { ok, childrenPaused, childrenUnsupported }
    },
  )

  // Stage 2.1 — resume a paused orchestration kernel.
  validatedHandle(
    'agents:resume-active',
    agentsResumeActiveArgs,
    async (_event, [{ conversationId }]) => {
      const ok = resumeOrchestrationKernelForConversation(conversationId)
      // Symmetric to pause: resume kernel-backed children; shim children
      // were never paused so `unsupported` here is informational only.
      let childrenResumed = 0
      try {
        const r = getMultiAgentOrchestrator().resumeByConversation(conversationId)
        childrenResumed = r.supported
      } catch (err) {
        console.warn('[agents:resume-active] resumeByConversation failed:', err)
      }
      return { ok, childrenResumed }
    },
  )

  validatedHandle('agents:save-to-disk', agentsSaveToDiskArgs, async (_event, [params]) => {
    try {
      const opts = getPanelScopeOpts()
      const res = saveAgentMarkdown({
        scope: params.scope,
        extraDirIndex: params.extraDirIndex,
        agent: params.agent,
        opts,
      })
      if (!res.success) return res
      // Re-scan + rebuild Agent tool so the main AI sees the new .md immediately.
      rebuildAgentDefinitions(opts.workspacePath, opts.userDataPath, undefined)
      broadcastAgentsChanged()
      return res
    } catch (error) {
      console.error('IPC agents:save-to-disk failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  validatedHandle('agents:delete-from-disk', agentsDeleteFromDiskArgs, async (_event, [sourcePath]) => {
    try {
      const opts = getPanelScopeOpts()
      const res = deleteAgentMarkdown(sourcePath, opts)
      if (res.success) {
        rebuildAgentDefinitions(opts.workspacePath, opts.userDataPath, undefined)
        broadcastAgentsChanged()
      }
      return res
    } catch (error) {
      console.error('IPC agents:delete-from-disk failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  validatedHandle('agents:set-disabled', agentsSetDisabledArgs, async (_event, [names]) => {
    try {
      // De-dupe + normalise; persist into the shared settings file alongside
      // the rest of user prefs.
      const cleaned = Array.from(
        new Set(
          (names || [])
            .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
            .map((n) => n.trim()),
        ),
      )
      const prev = loadSettings()
      const merged = { ...prev, disabledCustomAgents: cleaned }
      saveSettings(merged)
      setDisabledCustomAgentTypes(cleaned)
      // Rebuild so the Agent tool's routing description updates immediately.
      const opts = getPanelScopeOpts()
      rebuildAgentDefinitions(opts.workspacePath, opts.userDataPath, undefined)
      broadcastAgentsChanged()
      return { success: true }
    } catch (error) {
      console.error('IPC agents:set-disabled failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  validatedHandle('agents:set-extra-dirs', agentsSetExtraDirsArgs, async (_event, [dirs]) => {
    try {
      const cleaned = Array.from(
        new Set(
          (dirs || [])
            .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
            .map((d) => d.trim()),
        ),
      )
      const prev = loadSettings()
      const merged = { ...prev, customAgentsExtraDirs: cleaned }
      saveSettings(merged)
      // Rewire the watcher so new dirs start firing `agents:changed`.
      restartCustomAgentsWatcher()
      // Re-scan right now so the current list-all reflects the new roots.
      const opts = getPanelScopeOpts()
      rebuildAgentDefinitions(opts.workspacePath, opts.userDataPath, undefined)
      broadcastAgentsChanged()
      return { success: true }
    } catch (error) {
      console.error('IPC agents:set-extra-dirs failed:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  validatedHandle('agents:pick-directory', agentsPickDirectoryArgs, async (_event, [title]) => {
    try {
      const mainWindow = getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { canceled: true }
      }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: title || '选择 agent 目录',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { canceled: true }
      }
      return { path: result.filePaths[0] }
    } catch (error) {
      console.error('IPC agents:pick-directory failed:', error)
      return { canceled: true }
    }
  })
}
