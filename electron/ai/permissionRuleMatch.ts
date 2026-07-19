/**
 * Settings → Permissions → tool rules (pattern → allow | ask | deny).
 * First matching rule wins; falls back to the global default mode.
 *
 * Extended (upstream-style):
 * - MCP server prefix: pattern `mcp__ServerName` matches all `mcp__ServerName__*`
 * - Optional `shellPattern` for Bash / PowerShell command matching (exact, `prefix:*`, `*` wildcard)
 * - Optional `pathPattern` gitignore-style line (via `ignore` package) for file-targeting tools
 */

import ignore from 'ignore'
import path from 'node:path'
import { getWorkspacePath } from '../tools/workspaceState'

export type PermissionRulePayload = {
  id: string
  pattern: string
  mode: 'allow' | 'ask' | 'deny'
  /** When set, Bash/PowerShell commands must match this (exact, `npm:*`, or `git *` wildcard). */
  shellPattern?: string
  /** Single gitignore-style line; matched against workspace-relative POSIX path when available. */
  pathPattern?: string
}

export type PermissionRuleContext = {
  bashCommand?: string
  /** Resolved absolute or workspace path for file tools */
  filePath?: string
  /** Normalized skill name when tool is `Skill` (for `skill:name` patterns). */
  skillInvocationName?: string
}

export function sanitizePermissionRules(raw: unknown): PermissionRulePayload[] {
  if (!Array.isArray(raw)) return []
  const out: PermissionRulePayload[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const pattern = typeof o.pattern === 'string' ? o.pattern : ''
    const mode = o.mode
    if (mode !== 'allow' && mode !== 'ask' && mode !== 'deny') continue
    if (!pattern.trim()) continue
    const id = typeof o.id === 'string' && o.id.trim() ? o.id : `rule-${out.length}`
    const shellPattern = typeof o.shellPattern === 'string' ? o.shellPattern : undefined
    const pathPattern = typeof o.pathPattern === 'string' ? o.pathPattern : undefined
    out.push({
      id,
      pattern,
      mode,
      ...(shellPattern?.trim() ? { shellPattern: shellPattern.trim() } : {}),
      ...(pathPattern?.trim() ? { pathPattern: pathPattern.trim() } : {}),
    })
  }
  return out
}

function alternativeMatchesTool(toolName: string, alt: string): boolean {
  const a = alt.trim()
  if (!a || a === '*') return true
  if (!a.includes('*') && !a.includes('?')) {
    return toolName.toLowerCase() === a.toLowerCase()
  }
  const escaped = a
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  try {
    return new RegExp(`^${escaped}$`, 'i').test(toolName)
  } catch {
    return false
  }
}

/** `mcp__Foo` matches tool `mcp__Foo__tool1` (whole-server deny). */
export function toolNameMatchesRulePattern(toolName: string, pattern: string): boolean {
  const p = pattern.trim()
  if (!p) return false
  if (p === '*') return true

  if (p.startsWith('mcp__')) {
    const rest = p.slice('mcp__'.length)
    if (!rest.includes('__')) {
      const prefix = `mcp__${rest}__`
      return toolName.toLowerCase().startsWith(prefix.toLowerCase()) || toolName.toLowerCase() === p.toLowerCase()
    }
  }

  const parts = p.split('|').map((s) => s.trim())
  for (const part of parts) {
    if (alternativeMatchesTool(toolName, part)) return true
  }
  return false
}

/** True if `pattern` matches `toolName` (supports `|`, `*`, `?`, MCP server prefix). */
export function toolMatchesPermissionPattern(toolName: string, pattern: string): boolean {
  return toolNameMatchesRulePattern(toolName, pattern)
}

/**
 * upstream shell rule: exact, legacy `prefix:*`, or `*` wildcard (dotAll).
 */
export function bashCommandMatchesRule(command: string, pattern: string): boolean {
  const c = command.trim()
  const p = pattern.trim()
  if (!p) return true
  if (p.endsWith(':*')) {
    const prefix = p.slice(0, -2).trim()
    return prefix.length > 0 && c.toLowerCase().startsWith(prefix.toLowerCase())
  }
  if (!p.includes('*')) {
    return c === p
  }
  const escaped = p
    .replace(/\\\\/g, '\0ESCBS\0')
    .replace(/\\\*/g, '\0STAR\0')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\0STAR\0/g, '\\*')
    .replace(/\0ESCBS\0/g, '\\\\')
  try {
    return new RegExp(`^${escaped}$`, 'ims').test(c)
  } catch {
    return false
  }
}

function isShellToolName(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'bash' || n === 'powershell'
}

function pathMatchesPathPattern(filePath: string, gitignoreLine: string): boolean {
  const ws = getWorkspacePath()
  if (!ws) {
    // No workspace → no rooted gitignore tree. The `ignore` library
    // rejects absolute / `..`-prefixed paths with a RangeError, which used
    // to escape from this function and crash the entire tool dispatch
    // (see audit-v4 session-memory `read_file` regression). With no
    // workspace anchor a workspace-relative permission rule can't
    // meaningfully match anything — return false instead of throwing.
    return false
  }
  let rel: string
  try {
    rel = path.relative(ws, filePath).replace(/\\/g, '/') || '.'
  } catch {
    return false
  }
  // Out-of-workspace target (e.g. session-memory writes under
  // `~/.claude/projects/<slug>/session-memory/`) — `path.relative` returns
  // `../../...` for those, and `ignore` rejects strings starting with `..`
  // with a `RangeError("path should be a `path.relative()`d string …")`.
  // Such files cannot be matched by a workspace-rooted gitignore line
  // anyway, so return false rather than crashing the caller.
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
    return false
  }
  const ig = ignore().add(gitignoreLine)
  return ig.ignores(rel)
}

function skillRulePatternMatches(pattern: string, skillName: string | undefined): boolean {
  const p = pattern.trim().toLowerCase()
  if (!p.startsWith('skill:')) return false
  if (!skillName?.trim()) return false
  const pat = p.slice('skill:'.length).trim()
  const sn = skillName.trim().toLowerCase()
  if (!pat || pat === '*') return true
  if (pat.includes('*') || pat.includes('?')) {
    const escaped = pat
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    try {
      return new RegExp(`^${escaped}$`, 'i').test(sn)
    } catch {
      return false
    }
  }
  return pat === sn
}

function ruleAppliesToInvocation(
  rule: PermissionRulePayload,
  toolName: string,
  ctx?: PermissionRuleContext,
): boolean {
  const pt = rule.pattern.trim()
  if (pt.toLowerCase().startsWith('skill:')) {
    if (toolName.toLowerCase() !== 'skill') return false
    return skillRulePatternMatches(pt, ctx?.skillInvocationName)
  }

  if (!toolNameMatchesRulePattern(toolName, rule.pattern)) return false

  if (rule.shellPattern?.trim()) {
    if (!isShellToolName(toolName)) return false
    const cmd = ctx?.bashCommand?.trim() ?? ''
    if (!bashCommandMatchesRule(cmd, rule.shellPattern)) return false
  }

  if (rule.pathPattern?.trim()) {
    if (!ctx?.filePath?.trim()) return false
    if (!pathMatchesPathPattern(ctx.filePath.trim(), rule.pathPattern.trim())) return false
  }

  return true
}

export function resolveToolPermissionMode(
  toolName: string,
  defaultMode: 'allow' | 'ask' | 'deny',
  rules: PermissionRulePayload[] | undefined,
  ctx?: PermissionRuleContext,
): { effectiveMode: 'allow' | 'ask' | 'deny'; matchedRule: boolean } {
  if (!rules?.length) {
    return { effectiveMode: defaultMode, matchedRule: false }
  }
  for (const rule of rules) {
    if (ruleAppliesToInvocation(rule, toolName, ctx)) {
      return { effectiveMode: rule.mode, matchedRule: true }
    }
  }
  return { effectiveMode: defaultMode, matchedRule: false }
}

/** Remove tools denied by listing rules before the model sees them (upstream assembleToolPool). */
export function isToolDeniedForModelListing(
  toolName: string,
  rules: ReadonlyArray<PermissionRulePayload> | undefined,
): boolean {
  if (!rules?.length) return false
  for (const r of rules) {
    if (r.mode !== 'deny') continue
    if (!toolNameMatchesRulePattern(toolName, r.pattern)) continue
    if (r.shellPattern?.trim() || r.pathPattern?.trim()) {
      continue
    }
    return true
  }
  return false
}
