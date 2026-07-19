/**
 * terminal:exec from renderer — cwd must be inside workspace; block obvious one-shot download/RCE patterns.
 */

import {
  getPrimaryWorkspaceRoot,
  hasSecurityWorkspaceRoot,
  resolvePathForWorkspaceAccess,
} from './workspaceAccess'

const MAX_COMMAND_CHARS = 500_000

const BLOCKED_SNIPPETS = [
  'invoke-expression',
  'iex(',
  'downloadstring',
  'downloadfile',
  'start-bitstransfer',
  'frombase64string',
  'certutil -urlcache',
  'regsvr32 ',
  'mshta ',
  'rundll32 ',
  'bash -c "$(curl',
  'bash -c "$(wget',
  'powershell -enc',
  'powershell -e ',
]

export function validateTerminalExec(
  command: string,
  cwd?: string,
): { ok: true; resolvedCwd: string } | { ok: false; error: string } {
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, error: 'Command is empty.' }
  }
  if (command.length > MAX_COMMAND_CHARS) {
    return { ok: false, error: 'Command exceeds maximum length.' }
  }

  const lower = command.toLowerCase()
  for (const b of BLOCKED_SNIPPETS) {
    if (lower.includes(b)) {
      return { ok: false, error: 'Command matches a blocked pattern for safety.' }
    }
  }

  if (hasSecurityWorkspaceRoot()) {
    const primary = getPrimaryWorkspaceRoot()!
    const cwdRaw = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : primary
    const cwdRes = resolvePathForWorkspaceAccess(cwdRaw)
    if (!cwdRes.ok) {
      return { ok: false, error: cwdRes.reason }
    }
    return { ok: true, resolvedCwd: cwdRes.resolved }
  }

  const fallbackCwd = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd()
  return { ok: true, resolvedCwd: fallbackCwd }
}
