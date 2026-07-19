/**
 * upstream 报告 §8.4 — MCP 与插件桥接（子集）：
 * - `.mcp.json`（mcpServers）
 * - `plugin.json` manifest 的 `mcpServers`（字符串 / 数组 / 对象）
 * - `plugin:${pluginId}:${serverName}` 作用域前缀
 * - 环境变量三层展开：${CLAUDE_PLUGIN_ROOT}/${ASTRA_PLUGIN_ROOT}、${user_config.X}、${VAR}
 *
 * MCPB（.mcpb ZIP）解压见 {@link readMcpbMcpServersRecord}。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { MCPServerConfig } from './transport'
import { readMcpbMcpServersRecord, resolveMcpbPath, isMcpbPath } from './mcpbBundle'
import { isPluginBlockedByPolicy } from '../plugins/pluginPolicy'
import { getUnconfiguredPermissionRelayChannels } from '../ai/permissionRelayBridge'
import {
  PluginMcpErrorCodes,
  describePluginMcpError,
  type PluginMcpErrorCode,
} from './pluginMcpErrors'

const ENV_VAR_INTERPOLATE = /\$\{([^}]+)\}/g

export type ScopedMcpEntry = {
  config: MCPServerConfig
  source: 'dot_mcp_json' | 'plugin_manifest'
  pluginId?: string
}

export type PluginMcpLoadIssue = { code: PluginMcpErrorCode; message: string; path?: string }

function readJsonFile(filePath: string): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: 'missing' }
    }
    const text = fs.readFileSync(filePath, 'utf8')
    return { ok: true, data: JSON.parse(text) as unknown }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

/** upstream: plugin:pluginName:serverName */
export function addPluginScopeToServerName(pluginId: string, serverName: string): string {
  const safePlugin = pluginId.replace(/:/g, '_')
  const safeServer = serverName.replace(/:/g, '_')
  return `plugin:${safePlugin}:${safeServer}`
}

/**
 * 解析 manifest / env 占位符。
 * - ${ASTRA_PLUGIN_ROOT} / ${CLAUDE_PLUGIN_ROOT} -> pluginRoot
 * - ${user_config.KEY} -> userConfig[KEY] ?? ''
 * - ${KEY} -> processEnv[KEY] ?? ''
 */
export function resolvePluginMcpEnvironment(
  value: string,
  ctx: {
    pluginRoot: string
    userConfig: Record<string, string>
    processEnv: NodeJS.ProcessEnv
  },
): string {
  return value.replace(ENV_VAR_INTERPOLATE, (_m, rawKey: string) => {
    const key = String(rawKey).trim()
    if (key === 'ASTRA_PLUGIN_ROOT' || key === 'CLAUDE_PLUGIN_ROOT') {
      return ctx.pluginRoot
    }
    if (key.startsWith('user_config.')) {
      const k = key.slice('user_config.'.length)
      return ctx.userConfig[k] ?? ''
    }
    return ctx.processEnv[key] ?? ''
  })
}

function resolveEnvRecord(
  env: Record<string, string> | undefined,
  ctx: { pluginRoot: string; userConfig: Record<string, string>; processEnv: NodeJS.ProcessEnv },
): Record<string, string> | undefined {
  if (!env) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    out[k] = resolvePluginMcpEnvironment(v, ctx)
  }
  return out
}

/** 将任意 JSON 条目转为 MCPServerConfig；失败返回 null。 */
export function rawEntryToMcpConfig(serverName: string, raw: unknown): MCPServerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const url = typeof o.url === 'string' ? o.url.trim() : ''
  const typeRaw = typeof o.type === 'string' ? o.type.toLowerCase() : ''
  if (url || typeRaw === 'sse' || typeRaw === 'http') {
    if (!url) return null
    const headers =
      o.headers && typeof o.headers === 'object' && !Array.isArray(o.headers)
        ? (o.headers as Record<string, string>)
        : undefined
    return {
      name: serverName,
      transport: 'sse',
      command: '',
      args: [],
      url,
      headers,
    }
  }

  const command = typeof o.command === 'string' ? o.command.trim() : ''
  if (!command) return null
  const args = Array.isArray(o.args)
    ? o.args.filter((a): a is string => typeof a === 'string')
    : []
  const env =
    o.env && typeof o.env === 'object' && !Array.isArray(o.env)
      ? (o.env as Record<string, string>)
      : undefined
  const cwd = typeof o.cwd === 'string' ? o.cwd : undefined
  return {
    name: serverName,
    transport: 'stdio',
    command,
    args,
    env,
    cwd,
  }
}

function parseMcpServersRecord(
  record: unknown,
  ctx: { pluginRoot: string; userConfig: Record<string, string>; processEnv: NodeJS.ProcessEnv },
  nameMapper: (logicalName: string) => string,
): { configs: MCPServerConfig[]; issues: PluginMcpLoadIssue[] } {
  const configs: MCPServerConfig[] = []
  const issues: PluginMcpLoadIssue[] = []
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    issues.push({
      code: PluginMcpErrorCodes.MANIFEST_VALIDATION_ERROR,
      message: 'mcpServers 必须是对象。',
    })
    return { configs, issues }
  }
  const seen = new Set<string>()
  for (const [logicalName, raw] of Object.entries(record as Record<string, unknown>)) {
    const name = nameMapper(logicalName.trim() || 'server')
    if (seen.has(name)) {
      issues.push({
        code: PluginMcpErrorCodes.MCP_SERVER_SUPPRESSED_DUPLICATE,
        message: `重复的服务器名已跳过: ${name}`,
      })
      continue
    }
    seen.add(name)

    let entry = raw
    if (typeof raw === 'string') {
      const parsed = readJsonFile(path.resolve(ctx.pluginRoot, raw))
      if (!parsed.ok) {
        issues.push({
          code: PluginMcpErrorCodes.PATH_NOT_FOUND,
          message: `无法读取 MCP 片段: ${raw}`,
        })
        continue
      }
      entry = parsed.data
    } else if (Array.isArray(raw)) {
      issues.push({
        code: PluginMcpErrorCodes.MCP_CONFIG_INVALID,
        message: `服务器 "${name}" 使用了不支持的数组格式。`,
      })
      continue
    }

    const base = rawEntryToMcpConfig(name, entry)
    if (!base) {
      issues.push({
        code: PluginMcpErrorCodes.MCP_CONFIG_INVALID,
        message: `服务器 "${name}" 配置无效。`,
      })
      continue
    }
    const resolved: MCPServerConfig = {
      ...base,
      env: resolveEnvRecord(base.env, ctx),
      cwd: base.cwd ? resolvePluginMcpEnvironment(base.cwd, ctx) : undefined,
    }
    configs.push(resolved)
  }
  return { configs, issues }
}

export function loadDotMcpJson(
  workspaceRoot: string,
  userConfig: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
): { entries: ScopedMcpEntry[]; issues: PluginMcpLoadIssue[] } {
  const filePath = path.join(workspaceRoot, '.mcp.json')
  const parsed = readJsonFile(filePath)
  const issues: PluginMcpLoadIssue[] = []
  if (!parsed.ok) {
    if (parsed.error === 'missing') {
      return { entries: [], issues: [] }
    }
    issues.push({
      code: PluginMcpErrorCodes.MANIFEST_PARSE_ERROR,
      message: parsed.error,
      path: filePath,
    })
    return { entries: [], issues }
  }
  const root = parsed.data
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    issues.push({
      code: PluginMcpErrorCodes.MANIFEST_VALIDATION_ERROR,
      message: '.mcp.json 根须为对象。',
      path: filePath,
    })
    return { entries: [], issues }
  }
  const mcpServers = (root as { mcpServers?: unknown }).mcpServers
  const ctx = { pluginRoot: workspaceRoot, userConfig, processEnv }
  const { configs, issues: inner } = parseMcpServersRecord(mcpServers, ctx, (n) => n)
  issues.push(...inner)
  return {
    entries: configs.map((c) => ({ config: c, source: 'dot_mcp_json' as const })),
    issues,
  }
}

/** Discover `plugin.json` paths under the workspace (root file, `.claude/plugins/*`, `plugins/*`) and built-in plugins. */
export function listPluginManifestDirs(workspaceRoot: string): string[] {
  const dirs: string[] = []
  const candidates = [
    path.join(workspaceRoot, 'plugin.json'),
    path.join(workspaceRoot, '.claude', 'plugins'),
    path.join(workspaceRoot, 'plugins'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      dirs.push(c)
    } else if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      try {
        for (const name of fs.readdirSync(c)) {
          const pluginDir = path.join(c, name)
          const manifest = path.join(pluginDir, 'plugin.json')
          if (fs.existsSync(manifest)) dirs.push(manifest)
        }
      } catch {
        /* ignore */
      }
    }
  }

  // Built-in plugins shipped with the application (e.g. everything-upstream).
  //
  // `__dirname` at runtime is `dist-electron/` (where the bundled `main.js` lives). The
  // source `electron/plugins/builtin/` is NOT copied into `dist-electron/`; instead
  // `electron-builder.json` ships it verbatim inside the asar via its `files` entry
  // (`electron/plugins/builtin/**/*`). In dev the same directory exists at
  // `<repo>/electron/plugins/builtin/`. Climb out of `dist-electron/` then descend into
  // `electron/plugins/builtin/` so the path resolves uniformly in both environments.
  const builtinDir = path.join(__dirname, '..', 'electron', 'plugins', 'builtin')
  if (fs.existsSync(builtinDir) && fs.statSync(builtinDir).isDirectory()) {
    try {
      for (const name of fs.readdirSync(builtinDir)) {
        const pluginDir = path.join(builtinDir, name)
        const manifest = path.join(pluginDir, 'plugin.json')
        if (fs.existsSync(manifest)) dirs.push(manifest)
      }
    } catch {
      /* ignore */
    }
  }

  return dirs
}

export function loadPluginManifestMcpServers(
  workspaceRoot: string,
  userConfig: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
): { entries: ScopedMcpEntry[]; issues: PluginMcpLoadIssue[] } {
  const manifests = listPluginManifestDirs(workspaceRoot)
  const entries: ScopedMcpEntry[] = []
  const issues: PluginMcpLoadIssue[] = []

  for (const manifestPath of manifests) {
    const parsed = readJsonFile(manifestPath)
    if (!parsed.ok) {
      issues.push({
        code: PluginMcpErrorCodes.MANIFEST_PARSE_ERROR,
        message: parsed.error,
        path: manifestPath,
      })
      continue
    }
    const data = parsed.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const mcpServers = (data as { mcpServers?: unknown }).mcpServers
    if (mcpServers === undefined) continue

    const pluginRoot = path.dirname(manifestPath)
    const dirName = path.basename(pluginRoot)
    const manifestName = (data as { name?: unknown }).name
    const pluginId =
      typeof manifestName === 'string' && manifestName.trim()
        ? manifestName.trim().replace(/:/g, '_')
        : dirName

    if (isPluginBlockedByPolicy(pluginId)) {
      issues.push({
        code: PluginMcpErrorCodes.MARKETPLACE_BLOCKED_BY_POLICY,
        message: `插件 "${pluginId}" 已在策略中禁用 (enabledPlugins)。`,
        path: manifestPath,
      })
      continue
    }

    const ctx = { pluginRoot, userConfig, processEnv }

    if (typeof mcpServers === 'string') {
      const ref = mcpServers.trim()
      if (isMcpbPath(ref)) {
        const abs = resolveMcpbPath(pluginRoot, ref)
        const rb = readMcpbMcpServersRecord(abs)
        if (!rb.ok) {
          issues.push({
            code: rb.code,
            message: describePluginMcpError(rb.code, rb.detail),
            path: manifestPath,
          })
          continue
        }
        const { configs, issues: inner } = parseMcpServersRecord(rb.mcpServers, ctx, (n) =>
          addPluginScopeToServerName(pluginId, n),
        )
        issues.push(...inner)
        for (const c of configs) {
          entries.push({ config: c, source: 'plugin_manifest', pluginId })
        }
        continue
      }
      const sub = readJsonFile(path.resolve(pluginRoot, mcpServers))
      if (!sub.ok) {
        issues.push({
          code: PluginMcpErrorCodes.PATH_NOT_FOUND,
          message: sub.error,
          path: manifestPath,
        })
        continue
      }
      const { configs, issues: inner } = parseMcpServersRecord(sub.data, ctx, (n) =>
        addPluginScopeToServerName(pluginId, n),
      )
      issues.push(...inner)
      for (const c of configs) {
        entries.push({ config: c, source: 'plugin_manifest', pluginId })
      }
      continue
    }

    const { configs, issues: inner } = parseMcpServersRecord(mcpServers, ctx, (n) =>
      addPluginScopeToServerName(pluginId, n),
    )
    issues.push(...inner)
    for (const c of configs) {
      entries.push({ config: c, source: 'plugin_manifest', pluginId })
    }
  }

  return { entries, issues }
}

export function loadAllProjectScopedMcpEntries(
  workspaceRoot: string,
  userConfig: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
): { entries: ScopedMcpEntry[]; issues: PluginMcpLoadIssue[] } {
  const a = loadDotMcpJson(workspaceRoot, userConfig, processEnv)
  const b = loadPluginManifestMcpServers(workspaceRoot, userConfig, processEnv)
  return {
    entries: [...a.entries, ...b.entries],
    issues: [...a.issues, ...b.issues],
  }
}

/** 报告 §8.5 — 未配置 HTTP 中继 Webhook 时的通道提示。 */
export function getUnconfiguredChannels(): Array<{ id: string; reason: string }> {
  return getUnconfiguredPermissionRelayChannels()
}
