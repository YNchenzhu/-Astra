/**
 * MCP Transport Factory.
 * Creates the appropriate transport (stdio or SSE) for connecting to an MCP server.
 *
 * NOTE: Transport classes are loaded dynamically via import() to avoid
 * rolldown bundling issues with require("child_process") inside the SDK.
 *
 * Packaged builds: `npx @scope/pkg ...` does not resolve packages under
 * `resources/node_modules`. We rewrite to Electron-as-Node + package bin entry
 * (see 打包问题记录.txt 问题 9).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { app } from 'electron'
import { parseNpxMcpArgs } from './npxArgs'
import {
  copyProcessEnvForMcpStdioChild,
  ensureNodeToolingBinDirsOnPath,
  shrinkMcpStdioEnvIfNeeded,
} from './mcpStdioEnv'
import { ensureSystem32OnPath, normalizeWin32ComSpec, win32ShortPathIfNeeded } from './win32SpawnPath'
import { getWorkspacePath } from '../tools/workspaceState'
import { resolveBraveSearchApiKey } from '../settings/webSearchSettings'

/** Presets use `KEY: ''` as UI placeholders; must not wipe `process.env` or disk settings. */
function omitEmptyStringEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v !== '') out[k] = v
  }
  return out
}

function isBraveSearchMcpArgs(args: string[]): boolean {
  return args.some((a) => /server-brave-search|@modelcontextprotocol\/server-brave-search/i.test(a))
}

/**
 * Stdio MCP servers often throw when the host closes the pipe while a JSON-RPC
 * reply is still in flight (EPIPE). That surfaces as noisy stderr / unhandled
 * 'error' in the child; piping stderr here lets us filter the known case.
 */
function attachMcpServerStderrSink(stderr: Readable | null | undefined, serverLabel: string): void {
  if (!stderr || typeof stderr.on !== 'function') return
  stderr.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    if (/EPIPE|broken pipe|errno:\s*-4047/i.test(text)) {
      return
    }
    const trimmed = text.trimEnd()
    if (trimmed) {
      console.warn(`[MCP ${serverLabel} stderr]`, trimmed)
    }
  })
  stderr.on('error', () => {
    /* Child teardown races; ignore */
  })
}

export interface MCPServerConfig {
  name: string
  transport: 'stdio' | 'sse'
  command: string
  args: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** stdio 子进程工作目录；留空则使用当前主进程工作区（若已设置） */
  cwd?: string
  /** false = 用户主动断开后启动不再自动连；未设置视为 true */
  autoConnectOnLaunch?: boolean
  lastError?: string
  lastConnectedAt?: number
  resourceCount?: number
}

function isNpxCommand(command: string): boolean {
  const base = path.basename(command, path.extname(command)).toLowerCase()
  return base === 'npx'
}

function resolvePackageEntryScript(pkgDir: string): string | null {
  const pkgJsonPath = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) return null
  let pkg: { bin?: string | Record<string, string>; main?: string }
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as typeof pkg
  } catch {
    return null
  }
  const { bin, main } = pkg
  if (typeof bin === 'string') {
    return path.join(pkgDir, bin)
  }
  if (bin && typeof bin === 'object') {
    const first = Object.values(bin)[0]
    if (typeof first === 'string') return path.join(pkgDir, first)
  }
  if (typeof main === 'string') return path.join(pkgDir, main)
  return null
}

function resolvePackagedNpxStdio(config: MCPServerConfig): MCPServerConfig {
  const configWithEnv = { ...config, env: omitEmptyStringEnv(config.env) ?? config.env }
  if (configWithEnv.transport !== 'stdio' || !isNpxCommand(configWithEnv.command)) {
    return configWithEnv
  }
  if (!app.isPackaged) {
    return configWithEnv
  }

  const parsed = parseNpxMcpArgs(configWithEnv.args)
  if (!parsed) {
    console.warn('[MCP] Packaged npx: could not parse package from args, using npx as-is')
    return configWithEnv
  }

  const resourcesNm = path.join(process.resourcesPath, 'node_modules')
  const pkgDir = path.join(resourcesNm, parsed.pkgName)
  if (!fs.existsSync(pkgDir)) {
    console.warn(`[MCP] Packaged npx: missing ${pkgDir}, using npx as-is`)
    return configWithEnv
  }

  const entry = resolvePackageEntryScript(pkgDir)
  if (!entry || !fs.existsSync(entry)) {
    console.warn(`[MCP] Packaged npx: no runnable entry in ${pkgDir}, using npx as-is`)
    return configWithEnv
  }

  const nodePath =
    process.env.NODE_PATH && process.env.NODE_PATH.length > 0
      ? `${resourcesNm}${path.delimiter}${process.env.NODE_PATH}`
      : resourcesNm

  const exe = win32ShortPathIfNeeded(process.execPath)
  const script = win32ShortPathIfNeeded(entry)

  const baseEnv = omitEmptyStringEnv(configWithEnv.env) ?? {}
  return {
    ...configWithEnv,
    command: exe,
    args: [script, ...parsed.forwardedArgs],
    env: {
      ...baseEnv,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: nodePath,
    },
  }
}

export async function createTransport(config: MCPServerConfig) {
  if (config.transport === 'stdio') {
    if (process.platform === 'win32') {
      normalizeWin32ComSpec()
    }
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const resolved = resolvePackagedNpxStdio(config)
    const ws = getWorkspacePath()
    let cwd: string | undefined =
      resolved.cwd && String(resolved.cwd).trim()
        ? resolved.cwd
        : ws && ws.trim()
          ? ws
          : app.isPackaged
            ? os.homedir()
            : undefined
    if (cwd && !fs.existsSync(cwd)) {
      console.warn(`[MCP] stdio cwd does not exist (${cwd}), falling back`)
      cwd = app.isPackaged ? os.homedir() : undefined
    }
    // Strip empty env values again here so saved mcp-servers.json / presets never wipe process.env (→ instant child exit, -32000).
    const configEnv = omitEmptyStringEnv(resolved.env as Record<string, string> | undefined) ?? {}
    const applyWorkspaceAndBraveApiKey = (env: Record<string, string>) => {
      if (ws && ws.trim()) env.ASTRA_WORKSPACE = ws
      if (isBraveSearchMcpArgs(resolved.args)) {
        const k = resolveBraveSearchApiKey()
        if (k) env.BRAVE_API_KEY = k
        else delete env.BRAVE_API_KEY
      }
    }
    // Do not spread full `process.env`: Electron/the IDE inject NODE_OPTIONS / ELECTRON_* that break child `node` (→ -32000).
    let merged: Record<string, string> = {
      ...copyProcessEnvForMcpStdioChild(),
      ...configEnv,
    }
    applyWorkspaceAndBraveApiKey(merged)
    if (process.platform === 'win32') {
      ensureSystem32OnPath(merged)
    }
    ensureNodeToolingBinDirsOnPath(merged)
    merged = shrinkMcpStdioEnvIfNeeded(merged, configEnv)
    applyWorkspaceAndBraveApiKey(merged)
    if (process.platform === 'win32') {
      ensureSystem32OnPath(merged)
    }
    ensureNodeToolingBinDirsOnPath(merged)
    const transport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      cwd,
      stderr: 'pipe',
      env: merged,
    })
    attachMcpServerStderrSink(transport.stderr as Readable | null, config.name)
    return transport
  }

  if (config.transport === 'sse') {
    if (!config.url) {
      throw new Error('SSE transport requires a URL')
    }
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    return new SSEClientTransport(
      new URL(config.url),
      {
        requestInit: {
          headers: config.headers,
        },
      }
    )
  }

  throw new Error(`Unknown transport type: ${config.transport}`)
}
