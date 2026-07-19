/**
 * upstream report §5.7 — overly broad Bash allow rules (YOLO-equivalent).
 * Used for diagnostics / future settings validation; does not auto-block execution.
 */

import type { PermissionRulePayload } from './permissionRuleMatch'

const INTERPRETER_PREFIXES = [
  'python',
  'node',
  'deno',
  'ruby',
  'perl',
  'php',
  'lua',
  'npx',
  'bunx',
  'npm',
  'yarn',
  'pnpm',
  'bun',
]

function isBashLikePattern(p: string): boolean {
  const x = p.trim().toLowerCase()
  return x === 'bash' || x === 'powershell' || x === 'shell'
}

/**
 * True when an **allow** rule effectively grants unrestricted shell (no shellPattern, or pattern is `*`).
 */
export function isUnrestrictedShellAllowRule(rule: PermissionRulePayload): boolean {
  if (rule.mode !== 'allow') return false
  if (!isBashLikePattern(rule.pattern) && rule.pattern !== '*') return false
  const sp = rule.shellPattern?.trim()
  if (!sp || sp === '*') return true
  return false
}

/**
 * True when allow rule uses a shellPattern that prefixes a script interpreter (report CROSS_PLATFORM_CODE_EXEC subset).
 */
export function isInterpreterPrefixAllowRule(rule: PermissionRulePayload): boolean {
  if (rule.mode !== 'allow') return false
  if (!rule.shellPattern?.trim()) return false
  const sp = rule.shellPattern.trim().toLowerCase()
  if (sp === '*' || sp === '*:*') return false
  const head = sp.endsWith(':*') ? sp.slice(0, -2).trim() : sp.split(/\s+/)[0] ?? ''
  if (!head) return false
  return INTERPRETER_PREFIXES.some((pre) => head === pre || head.startsWith(`${pre}:`))
}

export function listDangerousPermissionRules(rules: PermissionRulePayload[]): PermissionRulePayload[] {
  return rules.filter((r) => isUnrestrictedShellAllowRule(r) || isInterpreterPrefixAllowRule(r))
}
