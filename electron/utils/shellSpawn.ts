/**
 * Windows: cmd.exe often uses a legacy ANSI/OEM code page (e.g. GBK on zh-CN).
 * Node reads child stdout as UTF-8 by default → mojibake for tool output (Bash, exec).
 * Prefer switching the console to UTF-8 (65001) and nudging Python toward UTF-8.
 */

export function shellSpawnEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = { ...base } as Record<string, string>
  if (process.platform !== 'win32') return env
  if (env.PYTHONIOENCODING === undefined) env.PYTHONIOENCODING = 'utf-8'
  if (env.PYTHONUTF8 === undefined) env.PYTHONUTF8 = '1'
  // Git Bash / MSYS2 / WSL locale for Chinese character support
  if (env.LANG === undefined) env.LANG = 'en_US.UTF-8'
  if (env.LC_ALL === undefined) env.LC_ALL = 'en_US.UTF-8'
  if (env.LC_CTYPE === undefined) env.LC_CTYPE = 'UTF-8'
  return env
}

/** Prefix cmd line so the session uses UTF-8 before running the user command. */
export function withWindowsUtf8Console(command: string): string {
  const c = command.trim()
  if (process.platform !== 'win32') return c
  if (/^\s*chcp\s+65001\b/i.test(c)) return c
  // chcp 65001 has a known bug on some Windows builds (hangs on pipe close);
  // chain with 2>nul so failures don't block the actual command.
  return `chcp 65001>nul 2>&1 & ${c}`
}

/**
 * PowerShell encoding setup — extended to cover external native commands.
 * PowerShell's $OutputEncoding only controls encoding *between* PS and pipeline
 * targets, but many native commands use the OEM code page directly.
 * We use chcp 65001 to set the console code page to UTF-8 as the primary mechanism.
 */
export const WINDOWS_POWERSHELL_UTF8_SESSION =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; ' +
  '$OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  // Switch console code page to UTF-8 (65001); try/catch suppresses errors on some builds
  'try { chcp 65001 | Out-Null } catch {}'
