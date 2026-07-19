/**
 * Renderer → main tool invocation: strict whitelist + workspace path checks on tool inputs.
 * Agentic loop uses toolRegistry.execute in-process and does not use this IPC path.
 */

import { resolvePathForWorkspaceAccess } from './workspaceAccess'

function isOptionalReadDiagnosticsEnabled(): boolean {
  const v = process.env.ASTRA_READ_DIAGNOSTICS?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

const STATIC_UI_SAFE_TOOLS = new Set<string>([
  'Read',
  'Glob',
  'Grep',
  'list_files',
  'WebFetch',
  'WebSearch',
  'ToolSearch',
  'Brief',
  'MemdirScan',
  'ReadDiagnostics',
  'LSP',
  'ReadMcpResourceTool',
  'ListMcpResourcesTool',
  'DiscoverSkills',
])

const PATH_INPUT_KEYS = new Set([
  'filePath',
  'file_path',
  'dirPath',
  'dir_path',
  'cwd',
])

export function isRendererToolInvokeAllowed(toolName: string): boolean {
  if (!toolName || typeof toolName !== 'string') return false
  /** MCP tools must use `mcp:invoke-tool` (validates server/tool exist); bridge marks all MCP as isReadOnly which would be too permissive here. */
  if (toolName.startsWith('mcp__')) return false
  if (toolName === 'ReadDiagnostics' && !isOptionalReadDiagnosticsEnabled()) return false
  return STATIC_UI_SAFE_TOOLS.has(toolName)
}

/**
 * Validate string path-like fields on tool input when workspace is enforced.
 */
export function assertRendererToolInputPaths(
  toolName: string,
  input: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  if (toolName === 'WebFetch' || toolName === 'LSP') {
    return { ok: true }
  }

  for (const key of Object.keys(input)) {
    if (!PATH_INPUT_KEYS.has(key)) continue
    const v = input[key]
    if (typeof v !== 'string' || !v.trim()) continue
    if (/^https?:\/\//i.test(v.trim())) continue
    const r = resolvePathForWorkspaceAccess(v.trim())
    if (!r.ok) {
      return { ok: false, error: `${toolName}.${key}: ${r.reason}` }
    }
  }
  return { ok: true }
}
