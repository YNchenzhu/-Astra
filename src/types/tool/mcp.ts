// ============================================================================
// MCP Types
// ============================================================================

export interface MCPServerConfig {
  name: string
  transport: 'stdio' | 'sse'
  command: string
  args: string[]
  env?: Record<string, string>
  /** stdio 子进程工作目录；留空则使用主进程已同步的当前工作区根目录 */
  cwd?: string
  url?: string
  headers?: Record<string, string>
  /** false = 上次主动断开，下次启动不自动连接；未设置/true = 启动时尝试连接 */
  autoConnectOnLaunch?: boolean
  lastError?: string
  lastConnectedAt?: number
  resourceCount?: number
}

export interface MCPServerState {
  config: MCPServerConfig
  connected: boolean
  status: string
  toolCount: number
  resourceCount: number
  lastError?: string
  lastConnectedAt?: number
}
