/**
 * Limits and light validation for MCP server configs from the renderer (supply-chain / abuse mitigation).
 */

import type { MCPServerConfig } from '../mcp/transport'
import { hasSecurityWorkspaceRoot, resolvePathForWorkspaceAccess } from './workspaceAccess'

const MAX_COMMAND_LEN = 4096
const MAX_ARGS = 128
const MAX_ARG_LEN = 16_384
const MAX_ENV_KEYS = 48
const MAX_ENV_VALUE_LEN = 8192
const MAX_URL_LEN = 4096
const MAX_HEADER_PAIRS = 32
const MAX_HEADER_VALUE_LEN = 8192
const MAX_NAME_LEN = 128

const BLOCKED_COMMAND_SUBSTRINGS = ['\0', '\n', '\r']

export function validateMcpConfigForRenderer(config: MCPServerConfig): { ok: true } | { ok: false; error: string } {
  if (!config || typeof config !== 'object') {
    return { ok: false, error: 'Invalid MCP config.' }
  }
  const name = typeof config.name === 'string' ? config.name.trim() : ''
  if (!name || name.length > MAX_NAME_LEN) {
    return { ok: false, error: 'MCP server name is missing or too long.' }
  }
  const cmd = typeof config.command === 'string' ? config.command : ''
  if (!cmd.trim() || cmd.length > MAX_COMMAND_LEN) {
    return { ok: false, error: 'MCP command is missing or too long.' }
  }
  for (const b of BLOCKED_COMMAND_SUBSTRINGS) {
    if (cmd.includes(b)) {
      return { ok: false, error: 'MCP command contains disallowed characters.' }
    }
  }

  if (!Array.isArray(config.args)) {
    return { ok: false, error: 'MCP args must be an array.' }
  }
  if (config.args.length > MAX_ARGS) {
    return { ok: false, error: `MCP args exceed limit (${MAX_ARGS}).` }
  }
  for (const a of config.args) {
    if (typeof a !== 'string') {
      return { ok: false, error: 'MCP args must be strings.' }
    }
    if (a.length > MAX_ARG_LEN) {
      return { ok: false, error: 'A single MCP arg is too long.' }
    }
  }

  if (config.env != null) {
    if (typeof config.env !== 'object' || Array.isArray(config.env)) {
      return { ok: false, error: 'MCP env must be an object.' }
    }
    const keys = Object.keys(config.env)
    if (keys.length > MAX_ENV_KEYS) {
      return { ok: false, error: `MCP env has too many keys (max ${MAX_ENV_KEYS}).` }
    }
    for (const k of keys) {
      const v = (config.env as Record<string, string>)[k]
      if (typeof v !== 'string' || v.length > MAX_ENV_VALUE_LEN) {
        return { ok: false, error: 'MCP env values must be strings within length limits.' }
      }
    }
  }

  if (config.transport === 'sse') {
    const url = typeof config.url === 'string' ? config.url : ''
    if (!url.trim() || url.length > MAX_URL_LEN) {
      return { ok: false, error: 'SSE MCP requires a valid url within length limits.' }
    }
    if (config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)) {
      const hk = Object.keys(config.headers)
      if (hk.length > MAX_HEADER_PAIRS) {
        return { ok: false, error: 'Too many MCP SSE headers.' }
      }
      for (const k of hk) {
        const v = (config.headers as Record<string, string>)[k]
        if (typeof v !== 'string' || v.length > MAX_HEADER_VALUE_LEN) {
          return { ok: false, error: 'MCP header values must be strings within length limits.' }
        }
      }
    }
  }

  if (
    hasSecurityWorkspaceRoot() &&
    config.cwd != null &&
    typeof config.cwd === 'string' &&
    config.cwd.trim()
  ) {
    const cwdCheck = resolvePathForWorkspaceAccess(config.cwd.trim())
    if (!cwdCheck.ok) {
      return { ok: false, error: `MCP cwd: ${cwdCheck.reason}` }
    }
  }

  return { ok: true }
}

export function validateMcpConfigArrayForRenderer(
  configs: unknown,
): { ok: true; configs: MCPServerConfig[] } | { ok: false; error: string } {
  if (!Array.isArray(configs)) {
    return { ok: false, error: 'Configs must be an array.' }
  }
  if (configs.length > 256) {
    return { ok: false, error: 'Too many MCP server entries.' }
  }
  const out: MCPServerConfig[] = []
  for (const c of configs) {
    if (!c || typeof c !== 'object') {
      return { ok: false, error: 'Invalid MCP config entry.' }
    }
    const v = validateMcpConfigForRenderer(c as MCPServerConfig)
    if (!v.ok) return v
    out.push(c as MCPServerConfig)
  }
  return { ok: true, configs: out }
}
