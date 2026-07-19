/**
 * upstream-style: in `acceptEdits` mode, auto-approve a **narrow** set of workspace
 * filesystem shell commands (report §5.1 / step 4 Mode-based: mkdir, touch, rm, sed, …).
 *
 * Conservative: only the first `&&` / `;` segment is considered; nested `bash -c` is not unpacked.
 */

/** Report §5.1 examples plus common single-segment companions (no chmod/chown — too broad). */
const POSIX_FS_COMMANDS = new Set([
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'sed',
  'mv',
  'cp',
  'ln',
  'tee',
  'truncate',
  'install',
  'patch',
])

const POWERSHELL_FS_COMMANDS = new Set([
  'mkdir',
  'md',
  'new-item',
  'ni',
  'remove-item',
  'rm',
  'del',
  'erase',
  'rd',
  'rmdir',
  'ri',
  'copy-item',
  'cpi',
  'cp',
  'move-item',
  'mi',
  'mv',
  'set-content',
  'sc',
  'add-content',
  'ac',
  'clear-content',
  'clc',
  'sed', // Git Bash / WSL path often still registered
  'tee-object',
  'tee',
  'out-file',
  'of',
  'rename-item',
  'ren',
  'rni',
])

function stripOptionalSudo(segment: string): string {
  return segment.replace(/^\s*sudo\s+/i, '').trim()
}

/** First path segment before `&&` or `;` (no nested parsing). */
export function firstShellSegment(command: string): string {
  const t = command.trim()
  if (!t) return ''
  const seg = t.split(/&&|;/)[0]?.trim() ?? t
  return seg
}

/**
 * Extract the invoked command name (lowercase, no extension) from a one-line shell segment.
 * Skips `VAR=value` assignments and a leading `env` with assignments.
 */
export function posixLeadingCommandName(segment: string): string {
  const s = stripOptionalSudo(segment)
  const parts = s.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i]!)) {
    i++
  }
  if (parts[i]?.toLowerCase() === 'env') {
    i++
    while (i < parts.length && /^[^\s=]+=.+/.test(parts[i]!)) {
      i++
    }
  }
  const raw = parts[i] ?? ''
  const base = raw.replace(/^.*[/\\]/, '')
  return base.replace(/\.(exe|com|bat|cmd|ps1)$/i, '').toLowerCase()
}

/** First significant token for PowerShell (strip leading `&`, `.`). */
export function powershellLeadingCommandName(segment: string): string {
  const s = segment.trim()
  if (!s) return ''
  const parts = s.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < parts.length && (parts[i] === '&' || parts[i] === '.')) {
    i++
  }
  const raw = parts[i] ?? ''
  return raw.replace(/^.*[/\\]/, '').replace(/\.(exe|com|bat|cmd|ps1)$/i, '').toLowerCase()
}

export function isAcceptEditsFilesystemShellCommand(
  command: string,
  shell: 'posix' | 'powershell',
): boolean {
  const seg = firstShellSegment(command)
  if (!seg) return false
  if (shell === 'powershell') {
    const name = powershellLeadingCommandName(seg)
    return name !== '' && POWERSHELL_FS_COMMANDS.has(name)
  }
  const name = posixLeadingCommandName(seg)
  return name !== '' && POSIX_FS_COMMANDS.has(name)
}
