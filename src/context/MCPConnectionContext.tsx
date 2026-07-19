/**
 * React 侧 MCP 连接生命周期（与主进程 MCPClientManager 对应）。
 * 通过 {@link useManageMCPConnections} 提供 reconnect / toggle，并绑定当前工作区路径。
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
} from 'react'
import { useWorkspaceStore } from '../stores/useWorkspaceStore'
import type { MCPServerConfig } from '../types'

export type MCPConnectionContextValue = {
  workspacePath: string | null
  reconnectMcpServer: (serverName: string) => Promise<{
    success: boolean
    toolCount?: number
    error?: string
  }>
  /** 已连接则断开（不保留 autoConnect）；未连接则按已保存配置连接。 */
  toggleMcpServer: (serverName: string) => Promise<{ success: boolean; error?: string }>
}

const MCPConnectionContext = createContext<MCPConnectionContextValue | null>(null)

export const MCPConnectionProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const workspacePath = rootPath?.trim() ? rootPath.trim() : null

  const reconnectMcpServer = useCallback(
    async (serverName: string) => {
      return window.electronAPI.mcp.reconnect(serverName, workspacePath)
    },
    [workspacePath],
  )

  const toggleMcpServer = useCallback(
    async (serverName: string) => {
      const list = await window.electronAPI.mcp.listServers()
      const live = list.find((s) => s.name === serverName)
      if (live?.connected) {
        return window.electronAPI.mcp.disconnect(serverName, false)
      }
      const configs = await window.electronAPI.mcp.getConfigs()
      const cfg = configs.find((c) => c.name === serverName) as MCPServerConfig | undefined
      if (!cfg) {
        return { success: false, error: '未找到已保存的 MCP 配置。' }
      }
      const r = await window.electronAPI.mcp.connect(cfg, workspacePath)
      return r.success ? { success: true } : { success: false, error: r.error }
    },
    [workspacePath],
  )

  const value = useMemo<MCPConnectionContextValue>(
    () => ({
      workspacePath,
      reconnectMcpServer,
      toggleMcpServer,
    }),
    [workspacePath, reconnectMcpServer, toggleMcpServer],
  )

  return (
    <MCPConnectionContext.Provider value={value}>{children}</MCPConnectionContext.Provider>
  )
}

// Context-consumer hook co-located with its Provider — the idiomatic React
// pattern. HMR-only warning; splitting would force every hook user to
// thread a second import.
// eslint-disable-next-line react-refresh/only-export-components
export function useManageMCPConnections(): MCPConnectionContextValue {
  const ctx = useContext(MCPConnectionContext)
  if (!ctx) {
    throw new Error('useManageMCPConnections 必须在 MCPConnectionProvider 内使用')
  }
  return ctx
}
