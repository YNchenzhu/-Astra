import React from 'react'
import { Database, FolderOpen, Globe, Monitor, Wrench, Zap } from 'lucide-react'
import type { MCPServerConfig } from '../../types'
import type { Messages } from '../../i18n'

type McpMessages = Messages['settings']['mcp']

export type MCPStatus = 'unconfigured' | 'ready' | 'connecting' | 'connected' | 'error' | 'disconnected'

export interface MCPPreset {
  id: string
  name: string
  description: string
  config: Record<string, unknown>
  category: string
}

export interface MCPDiagnostic {
  serverName: string
  status: string
  error?: string
  suggestion?: string
  transport: string
  toolCount: number
}

export interface MCPResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
  server: string
}

export interface MCPListedTool {
  serverName: string
  name: string
  originalName: string
  description?: string
}

export function buildStatusConfig(
  t: McpMessages,
): Record<MCPStatus, { color: string; label: string; pulse?: boolean }> {
  return {
    unconfigured: { color: '#45475a', label: t.statusUnconfigured },
    ready: { color: '#89b4fa', label: t.statusReady },
    connecting: { color: '#f9e2af', label: t.statusConnecting, pulse: true },
    connected: { color: '#a6e3a1', label: t.statusConnected },
    error: { color: '#f38ba8', label: t.statusError },
    disconnected: { color: '#6c7086', label: t.statusDisconnected },
  }
}

export const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  filesystem: <FolderOpen size={16} />,
  database: <Database size={16} />,
  api: <Globe size={16} />,
  'dev-tools': <Wrench size={16} />,
  browser: <Monitor size={16} />,
  other: <Zap size={16} />,
}

export function buildCategoryLabels(t: McpMessages): Record<string, string> {
  return {
    filesystem: t.catFilesystem,
    database: t.catDatabase,
    api: t.catApi,
    'dev-tools': t.catDevTools,
    browser: t.catBrowser,
    other: t.catOther,
  }
}

/** Split MCP argv line; respects "quoted segments" so paths with spaces stay one token. */
export function splitMcpArgsLine(raw: string): string[] {
  const s = raw.trim()
  if (!s) return []
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      if (c === quote) {
        quote = null
      } else {
        cur += c
      }
      continue
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'"
      continue
    }
    if (/\s/.test(c)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

export function formatMcpSpawnLine(cfg: MCPServerConfig): string {
  const cmd = (cfg.command || '').trim() || 'npx'
  const parts = (cfg.args || []).map(String)
  return parts.length ? `${cmd} ${parts.join(' ')}` : cmd
}

export function isFilesystemMcpConfig(cfg: MCPServerConfig): boolean {
  const blob = [cfg.command || '', ...(cfg.args || [])].join(' ').toLowerCase()
  return blob.includes('server-filesystem')
}
