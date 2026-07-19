/**
 * @modelcontextprotocol/server-filesystem reads allowed roots from argv after the package name.
 * Saved configs often contain a stale absolute path; align with the current workspace when spawning.
 *
 * Packaged Electron: `process.cwd()` is usually the install directory — never use it as the project root.
 */

import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'
import { parseNpxMcpArgs } from './npxArgs'
import type { MCPServerConfig } from './transport'
import { getWorkspacePath } from '../tools/workspaceState'

export function isFilesystemMcpPackageName(pkgName: string): boolean {
  return pkgName.toLowerCase().includes('server-filesystem')
}

export function isFilesystemMcpStdioConfig(config: MCPServerConfig): boolean {
  if (config.transport !== 'stdio') return false
  const parsed = parseNpxMcpArgs(config.args || [])
  return !!(parsed && isFilesystemMcpPackageName(parsed.pkgName))
}

/** Resolve using the path grammar carried by the value, not the host OS. */
function resolvePortableAbsolutePath(candidate: string): string {
  if (/^[a-z]:[\\/]/i.test(candidate) || candidate.startsWith('\\\\')) {
    return path.win32.resolve(candidate)
  }
  return path.resolve(candidate)
}

/** True if `p` is under the packaged app's install/resources tree (not a user project). */
export function isLikelyPackagedAppPath(candidate: string): boolean {
  if (!app.isPackaged) return false
  const c = path.resolve(candidate).toLowerCase()
  const exeDir = path.resolve(path.dirname(process.execPath)).toLowerCase()
  const res = path.resolve(process.resourcesPath).toLowerCase()
  const sep = path.sep.toLowerCase()
  return c === exeDir || c === res || c.startsWith(res + sep) || c.startsWith(exeDir + sep)
}

/**
 * Resolve directory passed to server-filesystem.
 * @param workspaceHint — from renderer IPC (current UI workspace), wins over main {@link getWorkspacePath}.
 */
export function resolveFilesystemMcpAllowedRoot(
  config: MCPServerConfig,
  workspaceHint?: string | null,
): string {
  const parsed = parseNpxMcpArgs(config.args || [])
  const forwardedFirst =
    parsed && parsed.forwardedArgs.length > 0 ? String(parsed.forwardedArgs[0]!).trim() : ''

  const hint = (workspaceHint && workspaceHint.trim()) || getWorkspacePath()?.trim() || ''
  if (hint) {
    return resolvePortableAbsolutePath(hint)
  }

  // No synced workspace yet (e.g. startup auto-reconnect before renderer calls memory:set-workspace):
  // keep saved path if it is not the install directory.
  if (forwardedFirst) {
    const existing = resolvePortableAbsolutePath(forwardedFirst)
    if (!isLikelyPackagedAppPath(existing)) {
      return existing
    }
  }

  if (app.isPackaged) {
    return path.resolve(os.homedir())
  }

  return path.resolve(process.cwd())
}

/**
 * For npx-based filesystem MCP, replace forwarded directory args with {@link resolveFilesystemMcpAllowedRoot}.
 */
export function applyFilesystemMcpWorkspaceRoot(
  config: MCPServerConfig,
  workspaceHint?: string | null,
): MCPServerConfig {
  if (config.transport !== 'stdio') return config
  const parsed = parseNpxMcpArgs(config.args)
  if (!parsed || !isFilesystemMcpPackageName(parsed.pkgName)) return config

  const root = resolveFilesystemMcpAllowedRoot(config, workspaceHint)
  const drop = parsed.forwardedArgs.length
  const head = drop > 0 ? config.args.slice(0, config.args.length - drop) : config.args
  return { ...config, args: [...head, root] }
}
