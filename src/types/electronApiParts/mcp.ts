import type { MCPServerConfig } from '../tool'
import type {
  MCPDiagnosticCompact,
  MCPPresetCompact,
  MCPResourceCompact,
  MCPResourceContent,
} from '../mcpModels'

export interface ElectronMcpApi {
  listServers: () => Promise<Array<{ name: string; transport: string; status: string; connected: boolean; toolCount: number; resourceCount: number; lastError?: string; lastConnectedAt?: number }>>
  getConfigs: () => Promise<MCPServerConfig[]>
  connect: (
    config: MCPServerConfig,
    workspacePath?: string | null,
  ) => Promise<{ success: boolean; toolCount?: number; error?: string }>
  disconnect: (serverName: string, preserveAutoConnect?: boolean) => Promise<{ success: boolean; error?: string }>
  disconnectAll: () => Promise<{ success: boolean; error?: string }>
  listTools: () => Promise<Array<{ serverName: string; name: string; originalName: string; description?: string }>>
  saveConfigs: (configs: MCPServerConfig[]) => Promise<{ success: boolean; error?: string }>
  reconnectAll: (
    workspacePath?: string | null,
  ) => Promise<Array<{ name: string; success: boolean; toolCount?: number; error?: string }>>
  healthCheck: (serverName: string) => Promise<MCPDiagnosticCompact>
  diagnostics: () => Promise<MCPDiagnosticCompact[]>
  presets: (workspacePath?: string | null) => Promise<MCPPresetCompact[]>
  reconnect: (
    serverName: string,
    workspacePath?: string | null,
  ) => Promise<{ success: boolean; toolCount?: number; error?: string }>
  listResources: (serverName?: string) => Promise<{ success: boolean; resources: MCPResourceCompact[]; error?: string }>
  readResource: (params: { serverName: string; uri: string }) => Promise<{ success: boolean; contents?: MCPResourceContent[]; error?: string }>
  invokeTool: (params: {
    serverName: string
    toolName: string
    input?: Record<string, unknown>
  }) => Promise<{ success: boolean; output?: string; error?: string }>
  discoverProject: (workspacePath?: string | null) => Promise<{
    success: boolean
    pending: Array<{
      config: MCPServerConfig
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
