/**
 * Normalize MCP stdio rows where the user put an npm package name in `command`
 * instead of `npx` + `-y` + package in `args`.
 */

import type { MCPServerConfig } from './transport'

function looksLikeNpmPackageToken(cmd: string): boolean {
  const c = cmd.trim()
  if (!c) return false
  if (c === 'npx' || c === 'pnpm' || c === 'yarn' || c === 'node') return false
  if (/\.(exe|cmd|bat|sh)$/i.test(c)) return false
  if (/^[a-z]:\\/i.test(c) || c.startsWith('\\\\')) return false
  if (c.startsWith('./') || c.startsWith('../') || (c.startsWith('/') && !c.startsWith('@')))
    return false
  return (
    c.startsWith('@') ||
    c.includes('modelcontextprotocol') ||
    c.includes('mcp-server') ||
    c.endsWith('-server')
  )
}

/**
 * If `command` is clearly an npm package, rewrite to `npx` with `-y`, package, then prior args.
 */
export function normalizeStdioNpxMcpConfig(config: MCPServerConfig): MCPServerConfig {
  if (config.transport !== 'stdio') return config
  const command = (config.command || '').trim()
  if (!looksLikeNpmPackageToken(command)) {
    return config
  }
  const pkg = command
  const rest = [...(config.args || [])]
  const alreadyHasY = rest[0] === '-y' || rest[0] === '--yes'
  const args = alreadyHasY ? [rest[0]!, pkg, ...rest.slice(1)] : ['-y', pkg, ...rest]
  return { ...config, command: 'npx', args }
}
