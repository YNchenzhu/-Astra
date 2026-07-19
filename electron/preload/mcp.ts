/**
 * MCP (Model Context Protocol) server management bridge.
 *
 * One-and-done domain: listing / connect / disconnect / reconnect, plus
 * per-server health checks, resource / tool invocation, and the
 * project-MCP approval flow.
 */
import { ipcRenderer } from 'electron'

type McpServerStatus = {
  name: string
  transport: string
  status: string
  connected: boolean
  toolCount: number
  resourceCount: number
  lastError?: string
  lastConnectedAt?: number
}

type McpDiagnostics = {
  serverName: string
  status: string
  error?: string
  suggestion?: string
  transport: string
  toolCount: number
}

export interface McpApi {
  listServers: () => Promise<Array<McpServerStatus>>
  getConfigs: () => Promise<Record<string, unknown>[]>
  connect: (config: {
    name: string
    transport: 'stdio' | 'sse'
    command: string
    args: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
    cwd?: string
    autoConnectOnLaunch?: boolean
  }, workspacePath?: string | null) => Promise<{ success: boolean; toolCount?: number; error?: string }>
  disconnect: (serverName: string, preserveAutoConnect?: boolean) => Promise<{ success: boolean; error?: string }>
  disconnectAll: () => Promise<{ success: boolean; error?: string }>
  listTools: () => Promise<Array<{ serverName: string; name: string; originalName: string; description?: string }>>
  saveConfigs: (configs: Record<string, unknown>[]) => Promise<{ success: boolean; error?: string }>
  reconnectAll: (
    workspacePath?: string | null,
  ) => Promise<Array<{ name: string; success: boolean; toolCount?: number; error?: string }>>
  reconnect: (
    serverName: string,
    workspacePath?: string | null,
  ) => Promise<{ success: boolean; toolCount?: number; error?: string }>
  presets: (workspacePath?: string | null) => Promise<
    Array<{ id: string; name: string; description: string; category: string; config: Record<string, unknown> }>
  >
  healthCheck: (serverName: string) => Promise<McpDiagnostics>
  diagnostics: () => Promise<Array<McpDiagnostics>>
  listResources: (
    serverName: string,
  ) => Promise<{ success: boolean; resources: Array<Record<string, unknown>>; error?: string }>
  readResource: (params: {
    serverName: string
    uri: string
  }) => Promise<{ success: boolean; contents?: Array<Record<string, unknown>>; error?: string }>
  invokeTool: (params: {
    serverName: string
    toolName: string
    input?: Record<string, unknown>
  }) => Promise<{ success: boolean; output?: string; error?: string }>
  discoverProject: (
    workspacePath?: string | null,
  ) => Promise<{
    success: boolean
    pending: Array<{
      config: Record<string, unknown>
      fingerprint: string
      source: string
      pluginId?: string
      sourceLabel: string
    }>
    issues: Array<{ code: string; message: string; path?: string }>
    entriesCount: number
  }>
  approveProjectMcp: (params: {
    workspacePath?: string | null
    fingerprints: string[]
  }) => Promise<{ success: boolean; mergedCount?: number; error?: string }>
  declineProjectMcp: (params: {
    workspacePath?: string | null
    fingerprints: string[]
  }) => Promise<{ success: boolean; error?: string }>
  unconfiguredChannels: () => Promise<{ channels: Array<{ id: string; reason: string }> }>
}

export function buildMcpApi(): McpApi {
  return {
    listServers: () => ipcRenderer.invoke('mcp:list-servers'),
    getConfigs: () => ipcRenderer.invoke('mcp:get-configs'),
    connect: (config, workspacePath) =>
      ipcRenderer.invoke('mcp:connect', { config, workspacePath }),
    disconnect: (serverName, preserveAutoConnect) =>
      ipcRenderer.invoke('mcp:disconnect', serverName, preserveAutoConnect),
    disconnectAll: () => ipcRenderer.invoke('mcp:disconnect-all'),
    listTools: () => ipcRenderer.invoke('mcp:list-tools'),
    saveConfigs: (configs) => ipcRenderer.invoke('mcp:save-configs', configs),
    reconnectAll: (workspacePath) => ipcRenderer.invoke('mcp:reconnect-all', workspacePath),
    reconnect: (serverName, workspacePath) =>
      ipcRenderer.invoke('mcp:reconnect', serverName, workspacePath),
    presets: (workspacePath) => ipcRenderer.invoke('mcp:presets', workspacePath ?? null),
    healthCheck: (serverName) => ipcRenderer.invoke('mcp:health-check', serverName),
    diagnostics: () => ipcRenderer.invoke('mcp:diagnostics'),
    listResources: (serverName) => ipcRenderer.invoke('mcp:list-resources', serverName),
    readResource: (params) => ipcRenderer.invoke('mcp:read-resource', params),
    invokeTool: (params) => ipcRenderer.invoke('mcp:invoke-tool', params),
    discoverProject: (workspacePath) => ipcRenderer.invoke('mcp:discover-project', workspacePath ?? null),
    approveProjectMcp: (params) => ipcRenderer.invoke('mcp:approve-project-mcp', params),
    declineProjectMcp: (params) => ipcRenderer.invoke('mcp:decline-project-mcp', params),
    unconfiguredChannels: () => ipcRenderer.invoke('mcp:unconfigured-channels'),
  }
}
