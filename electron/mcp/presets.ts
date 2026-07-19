/**
 * MCP presets (shared by Settings UI and agent auto-connect).
 * Agent `mcpServers` can use preset **id** or **npm package** (e.g. `@modelcontextprotocol/server-filesystem`).
 */

import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'
import { BRAVE_SEARCH_API_KEY_PLACEHOLDER } from '../settings/webSearchSettings'
import type { MCPServerConfig } from './transport'

/** When no folder is open, avoid `process.cwd()` in packaged builds (install dir). */
function presetWorkspaceFallback(): string {
  if (app.isPackaged) {
    return path.resolve(os.homedir())
  }
  return path.resolve(process.cwd())
}

export interface MCPPreset {
  id: string
  name: string
  description: string
  category: 'filesystem' | 'database' | 'api' | 'dev-tools' | 'browser' | 'other'
  /** Base config; `args` may contain `{workspace}` placeholder */
  config: Omit<MCPServerConfig, 'name'> & { args: string[] }
}

export const MCP_PRESETS: MCPPreset[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Project files via @modelcontextprotocol/server-filesystem',
    category: 'filesystem',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '{workspace}'],
      env: {},
    },
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'HTTP → markdown（通用网页抓取；与 Brave 搜索 API 互补）',
    category: 'api',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-server-fetch-typescript'],
      env: {},
    },
  },
  {
    id: 'brave-search',
    name: 'Brave 搜索',
    description:
      'Brave Search API：网页/本地检索（https://brave.com/search/api/）。请在「设置 → Tools」填写 Brave Key；连接时由应用注入真实密钥（预设中仅为占位符）。',
    category: 'api',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: { BRAVE_API_KEY: BRAVE_SEARCH_API_KEY_PLACEHOLDER },
    },
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: '浏览器自动化（@playwright/mcp；首次使用请在本机执行 npx playwright install 安装浏览器）',
    category: 'browser',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
      env: {},
    },
  },
  {
    id: 'figma',
    name: 'Figma',
    description:
      'Figma 文件与评论（figma-mcp）。请在 MCP 服务器环境变量或系统环境中设置 FIGMA_API_KEY；安全设置中勾选 File content / Comments。',
    category: 'api',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'figma-mcp'],
      env: {},
    },
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'Vercel 官方远程 MCP（mcp-remote；首次连接按日志/提示在浏览器完成 OAuth）',
    category: 'api',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.vercel.com'],
      env: {},
    },
  },
  {
    id: 'context7',
    name: 'Context7',
    description:
      'Up-to-date library docs & examples (@upstash/context7-mcp)。CONTEXT7_API_KEY 可选（提高限额）；在 MCP env 或系统环境中配置，勿留空键覆盖环境变量。',
    category: 'dev-tools',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      env: {},
    },
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Knowledge graph memory server',
    category: 'dev-tools',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      env: {},
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    description:
      'GitHub API。请在 MCP 服务器环境变量或系统环境中设置 GITHUB_PERSONAL_ACCESS_TOKEN（勿在预设中留空键）。',
    category: 'api',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {},
    },
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'SQLite MCP (pass DB path as extra arg in Settings if needed)',
    category: 'database',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-sqlite-server'],
      env: {},
    },
  },
]

function slugFromPackage(pkg: string): string {
  return (
    'npm-' +
    pkg
      .replace(/^@/, '')
      .replace(/[@/]/g, '-')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .slice(0, 80)
  )
}

/**
 * Build a runnable MCP config from preset id, npm-style package string, or saved name match.
 */
export function buildMcpConfigForSpecifier(
  spec: string,
  workspacePath: string | undefined,
): MCPServerConfig | null {
  const s = spec.trim()
  if (!s) return null

  const ws = (workspacePath && workspacePath.trim()) || presetWorkspaceFallback()
  const preset = MCP_PRESETS.find((p) => p.id === s)
  if (preset) {
    const args = preset.config.args.map((a) => (a === '{workspace}' ? ws : a))
    return {
      name: preset.id,
      transport: preset.config.transport,
      command: preset.config.command,
      args,
      env: { ...preset.config.env },
      url: preset.config.url,
      headers: preset.config.headers,
    }
  }

  // npm package / npx target
  const isPkg = s.startsWith('@') || s.startsWith('npm:') || s.endsWith('-server') || s.includes('modelcontextprotocol')
  if (isPkg || s.startsWith('@modelcontextprotocol/')) {
    const pkg = s.startsWith('npm:') ? s.slice(4).trim() : s
    const name = slugFromPackage(pkg)
    const args = ['-y', pkg]
    if (pkg.includes('filesystem')) {
      args.push(ws)
    }
    return {
      name,
      transport: 'stdio',
      command: 'npx',
      args,
      env: {},
    }
  }

  return null
}

/** Presets for Settings UI: substitute `{workspace}` in args using the given root (or cwd). */
export function getMcpPresetsForWorkspace(workspacePath: string | undefined | null): MCPPreset[] {
  const ws = (workspacePath && workspacePath.trim()) || presetWorkspaceFallback()
  return MCP_PRESETS.map((p) => ({
    ...p,
    config: {
      ...p.config,
      args: p.config.args.map((a) => (a === '{workspace}' ? ws : a)),
      env: p.config.env ? { ...p.config.env } : {},
    },
  }))
}
