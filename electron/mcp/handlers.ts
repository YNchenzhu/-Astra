/**
 * MCP IPC Handlers.
 * Manages MCP server connections from the renderer process.
 */

import type { IpcMain } from 'electron'
import { app } from 'electron'
import type { MCPServerConfig } from './transport'
import { MCPClientManager } from './client'
import { ensureMcpResourceToolsRegistered } from './mcpResourceToolRegistration'
import { toolRegistry } from '../tools/registry'
import { buildMcpConfigForSpecifier, getMcpPresetsForWorkspace } from './presets'
import path from 'node:path'
import { validateMcpConfigArrayForRenderer, validateMcpConfigForRenderer } from '../security/mcpConfigPolicy'
import { getWorkspacePath } from '../tools/workspaceState'
import { isFilesystemMcpStdioConfig } from './filesystemWorkspaceArgs'
import { discoverProjectMcpContext } from './mcpProjectDiscovery'
import { getUnconfiguredChannels, loadAllProjectScopedMcpEntries } from './pluginMcpIntegration'
import {
  mcpServerConfigFingerprint,
  recordApprovedFingerprints,
  recordDeclinedFingerprints,
} from './mcpApprovalStore'
import { getEnvVars } from '../tools/hooks/config'
import {
  fullResyncMcpRegistry,
  unregisterAllMcpToolsTracked,
  unregisterMcpToolsTrackedForServer,
} from './fullResyncMcpRegistry'
import { validatedHandle } from '../ipc/validatedHandle'
import {
  mcpConnectArgs,
  mcpDisconnectArgs,
  mcpHealthCheckArgs,
  mcpListResourcesArgs,
  mcpPresetsArgs,
  mcpReconnectAllArgs,
  mcpReconnectArgs,
  mcpSaveConfigsArgs,
} from '../ipc/schemas'

let mcpManager: MCPClientManager | null = null

function getManager(): MCPClientManager {
  if (!mcpManager) {
    const configPath = path.join(app.getPath('userData'), 'mcp-servers.json')
    mcpManager = new MCPClientManager(configPath)
  }
  return mcpManager
}

/**
 * Access the MCP manager if it has already been initialized — returns `null`
 * otherwise. Used by read-only consumers (e.g. coordinator worker-tool
 * surface, `mcpNamesFromRegistry`) that shouldn't force-create the manager
 * during module import.
 */
export function peekMcpManagerIfInitialized(): MCPClientManager | null {
  return mcpManager
}

function persistMcpConfigMerge(cfg: MCPServerConfig): void {
  getManager().mergeServerConfigIntoFile(cfg)
}

function mcpProjectApprovalsPath(): string {
  return path.join(app.getPath('userData'), 'mcp-project-approvals.json')
}

function mergeMcpSavedWithAdditions(
  saved: MCPServerConfig[],
  additions: MCPServerConfig[],
): MCPServerConfig[] {
  const map = new Map<string, MCPServerConfig>()
  for (const s of saved) map.set(s.name, s)
  for (const a of additions) map.set(a.name, { ...a })
  return [...map.values()]
}

function resolveMcpConfigsByFingerprints(
  workspaceResolved: string,
  fingerprints: Set<string>,
): MCPServerConfig[] {
  const { entries } = loadAllProjectScopedMcpEntries(
    workspaceResolved,
    getEnvVars(),
    process.env,
  )
  const out: MCPServerConfig[] = []
  for (const e of entries) {
    const fp = mcpServerConfigFingerprint(e.config)
    if (fingerprints.has(fp)) out.push(e.config)
  }
  return out
}

function parseMcpConnectPayload(raw: unknown): {
  config: MCPServerConfig
  workspacePathHint?: string | null
} {
  if (raw && typeof raw === 'object' && 'config' in raw) {
    const o = raw as { config: MCPServerConfig; workspacePath?: string | null }
    return { config: o.config, workspacePathHint: o.workspacePath }
  }
  return { config: raw as MCPServerConfig }
}

/**
 * After the UI workspace root changes, restart connected @modelcontextprotocol/server-filesystem
 * stdio servers so argv roots match the new folder (spawn-time only).
 */
export async function reconnectFilesystemMcpServersAfterWorkspaceChange(): Promise<void> {
  const manager = getSharedMcpManager()
  if (!manager) return
  const saved = manager.loadConfigs()
  const wsNow = getWorkspacePath()
  const connected = manager.listServers().filter((s) => s.connected)
  for (const row of connected) {
    const cfg = saved.find((c) => c.name === row.name)
    if (!cfg || !isFilesystemMcpStdioConfig(cfg)) continue
    try {
      await manager.disconnect(row.name)
      await manager.connect(cfg, { workspacePathHint: wsNow })
    } catch (e) {
      console.warn(`[MCP] Workspace change: failed to restart "${row.name}":`, e)
    }
  }
  fullResyncMcpRegistry(manager)
}

/**
 * Connect MCP servers by saved **name**, preset **id**, or **npm package** spec (see `buildMcpConfigForSpecifier`).
 */
export async function ensureMcpServersConnected(
  names: string[] | undefined,
  workspacePath?: string | null,
): Promise<string[]> {
  const newlyConnected: string[] = []
  if (!names?.length || !mcpManager) {
    if (names?.length && !mcpManager) {
      console.warn('[MCP] ensureMcpServersConnected: MCP manager not ready')
    }
    return newlyConnected
  }
  const manager = mcpManager
  const saved = manager.loadConfigs()
  const byName = new Map(saved.map((c) => [c.name, c]))
  const connected = new Set(
    manager.listServers().filter((s) => s.connected).map((s) => s.name),
  )
  for (const raw of names) {
    const n = raw.trim()
    if (!n) continue

    let cfg = byName.get(n)
    let fromDynamic = false
    if (!cfg) {
      const built = buildMcpConfigForSpecifier(n, workspacePath || undefined)
      if (built) {
        cfg = built
        fromDynamic = true
      }
    }
    if (!cfg) {
      console.warn(
        `[MCP] Unknown MCP specifier "${n}" (not in saved configs, presets, or npm-style package).`,
      )
      continue
    }

    if (connected.has(cfg.name)) continue

    const policy = validateMcpConfigForRenderer(cfg)
    if (!policy.ok) {
      console.warn(`[MCP] Skipping invalid config "${cfg.name}": ${policy.error}`)
      continue
    }

    try {
      const hint = workspacePath ?? getWorkspacePath()
      await manager.connect(cfg, { workspacePathHint: hint })
      fullResyncMcpRegistry(manager)
      connected.add(cfg.name)
      newlyConnected.push(cfg.name)
      if (fromDynamic) {
        persistMcpConfigMerge(cfg)
        byName.set(cfg.name, cfg)
      }
    } catch (e) {
      console.warn(`[MCP] Auto-connect "${cfg.name}" for agent failed:`, e)
    }
  }
  return newlyConnected
}

export function getSharedMcpManager(): MCPClientManager | null {
  return mcpManager
}

/**
 * Reconnect saved MCP servers after app start. Respects `autoConnectOnLaunch === false`
 * (set when renderer disconnects with `preserveAutoConnect === false`).
 * Runs async; failures are logged per server and do not block the app.
 */
export async function reconnectMcpServersOnLaunch(): Promise<void> {
  const manager = getManager()
  const saved = manager.loadConfigs().filter((c) => c.autoConnectOnLaunch !== false)
  if (saved.length === 0) return

  for (const config of saved) {
    const policy = validateMcpConfigForRenderer(config)
    if (!policy.ok) {
      console.warn(`[MCP] Startup skip "${config.name}": ${policy.error}`)
      continue
    }
    try {
      await manager.connect(config)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      manager.patchServerFieldsInFile(config.name, { lastError: message })
      console.warn(`[MCP] Startup auto-connect "${config.name}" failed:`, e)
    }
  }

  fullResyncMcpRegistry(manager)
}

export function registerMCPHandlers(ipcMain: IpcMain): void {
  const manager = getManager()
  ensureMcpResourceToolsRegistered(manager)

  validatedHandle('mcp:presets', mcpPresetsArgs, (_event, [workspacePath]) => {
    return getMcpPresetsForWorkspace(workspacePath ?? undefined)
  })

  ipcMain.handle('mcp:list-servers', () => {
    return manager.listServersDetailed()
  })

  ipcMain.handle('mcp:get-configs', () => {
    return manager.loadConfigs()
  })

  validatedHandle('mcp:connect', mcpConnectArgs, async (_event, [payload]) => {
    const { config, workspacePathHint } = parseMcpConnectPayload(payload)
    const policy = validateMcpConfigForRenderer(config)
    if (!policy.ok) {
      return { success: false, error: policy.error }
    }
    try {
      const tools = await manager.connect(config, {
        workspacePathHint:
          workspacePathHint !== undefined ? workspacePathHint : getWorkspacePath(),
      })
      fullResyncMcpRegistry(manager)
      return {
        success: true,
        toolCount: tools.length,
        serverName: config.name,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      manager.patchServerFieldsInFile(config.name, { lastError: message })
      return { success: false, error: message }
    }
  })

  validatedHandle(
    'mcp:disconnect',
    mcpDisconnectArgs,
    async (_event, [serverName, preserveAutoConnect]) => {
      try {
        await manager.disconnect(serverName)

        unregisterMcpToolsTrackedForServer(serverName)

        if (preserveAutoConnect === false) {
          manager.patchServerFieldsInFile(serverName, { autoConnectOnLaunch: false })
        }

        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: message }
      }
    },
  )

  ipcMain.handle('mcp:disconnect-all', async () => {
    try {
      await manager.disconnectAll()
      unregisterAllMcpToolsTracked()
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('mcp:list-tools', () => {
    return manager.getAllTools().map(({ serverName, tool }) => ({
      serverName,
      name: `mcp__${serverName}__${tool.name}`,
      originalName: tool.name,
      description: tool.description,
    }))
  })

  validatedHandle('mcp:save-configs', mcpSaveConfigsArgs, async (_event, [configs]) => {
    const policy = validateMcpConfigArrayForRenderer(configs as MCPServerConfig[])
    if (!policy.ok) {
      return { success: false, error: policy.error }
    }
    try {
      await manager.replaceAllConfigs(policy.configs)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  })

  validatedHandle('mcp:reconnect-all', mcpReconnectAllArgs, async (_event, [workspacePath]) => {
    const configs = manager.loadConfigs()
    const results: Array<{ name: string; success: boolean; toolCount?: number; error?: string }> = []
    const hint = workspacePath !== undefined ? workspacePath : getWorkspacePath()

    for (const config of configs) {
      const policy = validateMcpConfigForRenderer(config)
      if (!policy.ok) {
        results.push({ name: config.name, success: false, error: policy.error })
        continue
      }
      try {
        const tools = await manager.connect(config, { workspacePathHint: hint })
        results.push({ name: config.name, success: true, toolCount: tools.length })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        results.push({ name: config.name, success: false, error: message })
      }
    }

    fullResyncMcpRegistry(manager)

    return results
  })

  validatedHandle(
    'mcp:reconnect',
    mcpReconnectArgs,
    async (_event, [serverName, workspacePath]) => {
      try {
        const hint = workspacePath !== undefined ? workspacePath : getWorkspacePath()
        const tools = await manager.reconnectServer(serverName, { workspacePathHint: hint })
        fullResyncMcpRegistry(manager)
        return { success: true, toolCount: tools.length }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: message }
      }
    },
  )

  validatedHandle('mcp:health-check', mcpHealthCheckArgs, async (_event, [serverName]) => {
    const saved = manager.loadConfigs().find((c) => c.name === serverName)
    const transport = saved?.transport ?? 'stdio'
    const live = manager.listServers().find((s) => s.name === serverName && s.connected)
    if (!saved) {
      return {
        serverName,
        status: 'error',
        error: `未找到名为 "${serverName}" 的已保存配置`,
        transport,
        toolCount: 0,
      }
    }
    if (!live) {
      return {
        serverName,
        status: 'disconnected',
        suggestion: '请先点击「连接」建立会话后再检查健康状态。',
        transport,
        toolCount: 0,
      }
    }
    try {
      await manager.pingServer(serverName)
      return {
        serverName,
        status: 'connected',
        transport,
        toolCount: live.toolCount,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        serverName,
        status: 'error',
        error: message,
        suggestion: '可尝试「重新连接」或检查子进程 / 网络。',
        transport,
        toolCount: live.toolCount,
      }
    }
  })

  ipcMain.handle('mcp:diagnostics', async () => {
    const rows = manager.listServersDetailed()
    const out: Array<{
      serverName: string
      status: string
      error?: string
      suggestion?: string
      transport: string
      toolCount: number
    }> = []
    for (const r of rows) {
      if (r.connected) {
        try {
          await manager.pingServer(r.name)
          out.push({
            serverName: r.name,
            status: 'connected',
            transport: r.transport,
            toolCount: r.toolCount,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          out.push({
            serverName: r.name,
            status: 'error',
            error: message,
            suggestion: '可尝试「重新连接」。',
            transport: r.transport,
            toolCount: r.toolCount,
          })
        }
      } else {
        out.push({
          serverName: r.name,
          status: r.lastError ? 'error' : 'disconnected',
          error: r.lastError,
          suggestion: r.lastError ? undefined : '未连接；连接后可使用 MCP 工具。',
          transport: r.transport,
          toolCount: 0,
        })
      }
    }
    return out
  })

  validatedHandle('mcp:list-resources', mcpListResourcesArgs, async (_event, [serverName]) => {
    try {
      const resources = await manager.listResourcesForServer(serverName)
      return {
        success: true,
        resources: resources.map((r) => ({
          ...r,
          server: serverName,
        })),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, resources: [], error: message }
    }
  })

  ipcMain.handle(
    'mcp:read-resource',
    async (_event, params: { serverName: string; uri: string }) => {
      try {
        const tempDir = path.join(app.getPath('temp'), 'astra-mcp-resources')
        const contents = await manager.readResourceForServer(
          params.serverName,
          params.uri,
          tempDir,
        )
        return { success: true, contents }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: message }
      }
    },
  )

  /** Renderer MCP UI: same execution path as registry but no generic `mcp__` via tool:execute-ui. */
  ipcMain.handle(
    'mcp:invoke-tool',
    async (
      _event,
      payload: { serverName: string; toolName: string; input?: Record<string, unknown> },
    ) => {
      const serverName =
        typeof payload?.serverName === 'string' ? payload.serverName.trim() : ''
      const toolName = typeof payload?.toolName === 'string' ? payload.toolName.trim() : ''
      const input =
        payload?.input && typeof payload.input === 'object' && !Array.isArray(payload.input)
          ? payload.input
          : {}
      if (!serverName || !toolName) {
        return { success: false, error: 'serverName and toolName are required.' }
      }
      const fullName = `mcp__${serverName}__${toolName}`
      if (!toolRegistry.has(fullName)) {
        return {
          success: false,
          error: `MCP tool not registered (connect server first): ${serverName}/${toolName}`,
        }
      }
      return toolRegistry.execute(fullName, input)
    },
  )

  ipcMain.handle(
    'mcp:discover-project',
    async (_event, workspacePath: string | null | undefined) => {
      const ws =
        typeof workspacePath === 'string' && workspacePath.trim()
          ? workspacePath.trim()
          : getWorkspacePath()?.trim() || ''
      if (!ws) {
        return { success: true as const, pending: [], issues: [], entriesCount: 0 }
      }
      const { pending, issues, entries } = discoverProjectMcpContext({
        workspacePath: ws,
        savedConfigs: manager.loadConfigs(),
        approvalFilePath: mcpProjectApprovalsPath(),
        userConfig: getEnvVars(),
        processEnv: process.env,
      })
      return { success: true as const, pending, issues, entriesCount: entries.length }
    },
  )

  ipcMain.handle(
    'mcp:approve-project-mcp',
    async (
      _event,
      payload: { workspacePath?: string | null; fingerprints: string[] },
    ) => {
      const ws =
        typeof payload?.workspacePath === 'string' && payload.workspacePath.trim()
          ? payload.workspacePath.trim()
          : getWorkspacePath()?.trim() || ''
      if (!ws) {
        return { success: false as const, error: '未打开工作区路径。' }
      }
      const fingerprints = (payload?.fingerprints ?? []).filter(
        (f): f is string => typeof f === 'string' && f.length > 0,
      )
      if (fingerprints.length === 0) {
        return { success: false as const, error: '未选择要批准的 MCP 条目。' }
      }
      const fps = new Set(fingerprints)
      const additions = resolveMcpConfigsByFingerprints(path.resolve(ws), fps)
      if (additions.length === 0) {
        return { success: false as const, error: '未找到与指纹匹配的工程内 MCP 配置（可能已变更）。请重新扫描。' }
      }
      for (const cfg of additions) {
        const v = validateMcpConfigForRenderer(cfg)
        if (!v.ok) {
          return { success: false as const, error: `${cfg.name}: ${v.error}` }
        }
      }
      const saved = manager.loadConfigs()
      const merged = mergeMcpSavedWithAdditions(saved, additions)
      const policy = validateMcpConfigArrayForRenderer(merged)
      if (!policy.ok) {
        return { success: false as const, error: policy.error }
      }
      await manager.replaceAllConfigs(policy.configs)

      const approvedFps = additions.map((c) => mcpServerConfigFingerprint(c))
      recordApprovedFingerprints(mcpProjectApprovalsPath(), path.resolve(ws), approvedFps)

      const hint = path.resolve(ws)
      for (const cfg of additions) {
        try {
          await manager.connect(cfg, { workspacePathHint: hint })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          manager.patchServerFieldsInFile(cfg.name, { lastError: message })
          console.warn(`[MCP] approve-project connect "${cfg.name}" failed:`, e)
        }
      }
      fullResyncMcpRegistry(manager)
      return { success: true as const, mergedCount: additions.length }
    },
  )

  ipcMain.handle(
    'mcp:decline-project-mcp',
    async (
      _event,
      payload: { workspacePath?: string | null; fingerprints: string[] },
    ) => {
      const ws =
        typeof payload?.workspacePath === 'string' && payload.workspacePath.trim()
          ? payload.workspacePath.trim()
          : getWorkspacePath()?.trim() || ''
      if (!ws) {
        return { success: false as const, error: '未打开工作区路径。' }
      }
      const fingerprints = (payload?.fingerprints ?? []).filter(
        (f): f is string => typeof f === 'string' && f.length > 0,
      )
      if (fingerprints.length === 0) {
        return { success: false as const, error: '未选择要拒绝的条目。' }
      }
      recordDeclinedFingerprints(mcpProjectApprovalsPath(), path.resolve(ws), fingerprints)
      return { success: true as const }
    },
  )

  ipcMain.handle('mcp:unconfigured-channels', () => ({
    channels: getUnconfiguredChannels(),
  }))
}
