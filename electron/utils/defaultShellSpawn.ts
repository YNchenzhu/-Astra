/**
 * Resolves Settings "默认终端" (bash | powershell | cmd | zsh) into concrete spawn targets.
 * Windows: mitigates zh-CN OEM/ANSI vs UTF-8 mojibake where possible (chcp 65001, PS encodings).
 */

import fs from 'node:fs'
import { withWindowsUtf8Console } from './shellSpawn'

export type DefaultShellId = 'bash' | 'powershell' | 'cmd' | 'zsh'

/**
 * Run before user `-Command` body so stderr/stdout decode as UTF-8 in Node (zh-CN OEM is GBK).
 * `$OutputEncoding` affects piping to native exes (separate from console code page).
 * `chcp 65001` sets the console code page to UTF-8 as the primary mechanism for native commands.
 */
export const WINDOWS_POWERSHELL_UTF8_SESSION =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; ' +
  '$OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  'try { chcp 65001 | Out-Null } catch {}'

export function windowsGitBashPath(): string | null {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * True when the string clearly expects POSIX/bash parsing ($(), `cmd`, [[, heredoc, etc.).
 * On Windows, running these through cmd.exe causes broken quoting; route to Git Bash instead.
 */
export function looksLikePosixShellOneShot(command: string): boolean {
  const c = command.trim()
  if (!c) return false
  // $(...) command substitution (not $(VAR) in Make — still rare in one-shot cmd)
  if (/\$\([^)]+\)/.test(c)) return true
  // `...` command substitution (bash)
  if (/(?:^|[\s;|&])`[^`\r\n]+`(?:[\s;|&]|$)/m.test(c)) return true
  if (/\[\[\s/.test(c)) return true
  if (/\bwhile\s+read\b/.test(c)) return true
  if (/\bexport\s+[A-Za-z_][\w]*=/m.test(c)) return true
  if (/<<[-\s]?\w+/m.test(c)) return true
  // POSIX /dev/null or /dev/zero — cmd.exe / PowerShell have no equivalent
  if (/\/dev\/(?:null|zero|random|urandom)/.test(c)) return true
  // `&&` / `||` chain operators.
  //   - cmd.exe supports them natively since forever.
  //   - PowerShell 7+ supports them, but the ubiquitous Windows bundled
  //     PowerShell 5.1 (the one `powershell.exe` resolves to by default)
  //     rejects `&&` / `||` with "token '&&' is not a valid statement
  //     separator".
  //   - We always launch `powershell.exe` (not `pwsh.exe`) on the AI hot
  //     path, so any command chain containing `&&` or `||` needs to go to
  //     a shell that actually understands it. Git Bash does; fall through
  //     when Git Bash isn't installed (we keep PowerShell's native error
  //     which is at least deterministic).
  //   Note: `&` alone (background op) is NOT listed here — it's both a
  //   valid cmd.exe operator and a PS background-job operator.
  if (/(?:^|[^&|])&&(?:[^&|]|$)/.test(c)) return true
  if (/(?:^|[^&|])\|\|(?:[^&|]|$)/.test(c)) return true
  // Single-quoted arguments with embedded $variables — bash-style
  // parameter expansion that PowerShell doesn't do inside single quotes
  // either, but is a very strong signal of intent.
  if (/'[^']*\$[A-Za-z_{][^']*'/.test(c)) return true
  return false
}

/**
 * Windows cmd/PowerShell often lack POSIX utilities (`head`, GNU `find`, etc.). When the user
 * default shell is cmd or PowerShell but the command clearly expects a Unix userland, route the
 * whole line through Git Bash if available.
 */
export function looksLikePosixPipeline(command: string): boolean {
  const c = command.trim()
  if (!c) return false
  if (/\|\s*head\b/i.test(c)) return true
  if (/\|\s*tail\b/i.test(c)) return true
  if (/\|\s*xargs\b/i.test(c)) return true
  if (/\|\s*awk\s/.test(c)) return true
  if (/\|\s*sed\s/.test(c)) return true
  if (/\|\s*(?:grep|egrep|fgrep|rg)\s/.test(c)) return true
  if (/\|\s*(?:wc|sort|uniq|tr|cut|tee)\b/.test(c)) return true
  // GNU/BSD find (paths + flags like -name), not Windows find.exe "find string in files"
  if (/^\s*find\s+/i.test(c) && /(?:^|\s)-(?:name|path|type|iname|not-path|prune|maxdepth|mindepth|print0|delete|exec)\b/.test(c)) return true
  // POSIX grep / ripgrep flags that PowerShell lacks (e.g. -r, -l, --include, -n)
  if (/^(?:grep|egrep|fgrep|rg)\s+.*-(?:r|R|l|L|c|i|n|E|H|v|w|x|A|B|C|o|q|s|P)\b/i.test(c)) return true
  if (/\b(?:grep|egrep|fgrep|rg)\s+.*--(?:include|exclude|color|line-number|recursive|ignore-case|files-with-matches|count|context|after-context|before-context|extended-regexp|perl-regexp|word-regexp)\b/i.test(c)) return true
  return false
}

/**
 * Bare invocation of a POSIX/GNU userland utility (no pipe, no subshell, no flags yet).
 * On Windows, commands like `grep -n "foo" file.ts`, `awk '{print}' file`, `sed -n '1,10p'`
 * etc. have no PowerShell equivalent — running them through PS fails with
 * "grep not recognized". When Git Bash is installed, always route through it.
 *
 * We deliberately don't list `find` here: on Windows, `find.exe` is a built-in
 * (search string inside files) with a syntactically-compatible-looking but
 * semantically-different CLI — routing ALL `find` calls to bash would mask
 * valid cmd-style use. The `looksLikePosixPipeline` check still catches
 * `find . -name` etc. via its flag-based heuristic.
 *
 * Also excluded: `cat` — widely emulated by PowerShell's `Get-Content` alias,
 * and many users type `cat file.txt` expecting that alias; keep it native.
 */
export function looksLikePosixUtilityInvocation(command: string): boolean {
  const c = command.trim()
  if (!c) return false
  // Only consider the FIRST command in a chain. We don't want to match
  // `echo hi ; grep foo bar` because the user clearly expects cmd/PS for
  // the first half — Git Bash can still handle chains fine, but being
  // conservative here keeps our blast radius smaller.
  const firstToken = c.split(/[\s;|&]+/)[0]?.toLowerCase() ?? ''
  if (!firstToken) return false
  // Strip any drive-prefixed / directory-prefixed path (rare, but e.g.
  // `/usr/bin/grep` or just `grep` should both resolve).
  const bare = firstToken.split(/[/\\]/).pop() ?? firstToken
  const POSIX_UTILITIES = new Set([
    'grep', 'egrep', 'fgrep',
    'awk', 'gawk', 'nawk',
    'sed', 'gsed',
    'head', 'tail',
    'cut', 'sort', 'uniq', 'wc', 'tr', 'tee',
    'xargs',
    'rg', 'ripgrep',
    'basename', 'dirname',
    'comm', 'join', 'paste',
    'od', 'hexdump', 'xxd',
    'tac', 'rev',
    'which', // `which` ≠ Windows `where`; users writing `which node` expect POSIX
  ])
  return POSIX_UTILITIES.has(bare)
}

// NOTE: renamed from `useGitBashForWindowsCommand` to avoid tripping the
// `react-hooks/rules-of-hooks` linter, which treats any `use*` name as a
// React Hook regardless of module. This is a plain predicate.
function shouldUseGitBashForWindowsCommand(command: string): boolean {
  return (
    looksLikePosixShellOneShot(command) ||
    looksLikePosixPipeline(command) ||
    looksLikePosixUtilityInvocation(command)
  )
}

/**
 * Encode a PowerShell script for invocation via `powershell.exe -EncodedCommand <base64>`.
 *
 * Why this is necessary:
 *   When Node spawns `powershell.exe` on Windows with a command-line arg that
 *   contains spaces, Node wraps the arg in double quotes. PowerShell's
 *   command-line parser then treats the double-quoted string as an expandable
 *   string AT THE OUTER SCOPE — meaning `$_`, `$PSItem`, `$var` etc. are
 *   expanded BEFORE the script body runs. Since the outer scope has no
 *   `$_` pipeline variable, it collapses to the empty string, and a script
 *   like `Select-String ... | ForEach-Object { $_.LineNumber }` arrives at
 *   the parser as `Select-String ... | ForEach-Object { .LineNumber }` →
 *   "An expression was expected after '('".
 *
 *   `-EncodedCommand` accepts a base64 of UTF-16-LE bytes; PowerShell decodes
 *   into a pristine script string without any command-line tokenizer or
 *   double-quote variable expansion involved. This is the idiom both VSCode
 *   and Microsoft's own automation guidance recommend for non-trivial scripts.
 */
export function encodePowerShellCommand(script: string): string {
  // UTF-16-LE is the documented encoding PowerShell expects.
  return Buffer.from(script, 'utf16le').toString('base64')
}

export function parseDefaultShell(raw: unknown): DefaultShellId {
  if (raw === 'bash' || raw === 'powershell' || raw === 'cmd' || raw === 'zsh') return raw
  return process.platform === 'win32' ? 'powershell' : 'bash'
}

/** Long-lived interactive shell for the integrated terminal (PTY / fallback). */
export function getInteractiveShellSpec(choice: DefaultShellId): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    switch (choice) {
      case 'powershell':
        return { file: 'powershell.exe', args: ['-NoExit', '-Command', WINDOWS_POWERSHELL_UTF8_SESSION] }
      case 'cmd': {
        const com = process.env.ComSpec || 'cmd.exe'
        // chcp 65001 for UTF-8, with 2>nul to suppress errors on some Windows builds
        return { file: com, args: ['/K', 'chcp 65001 >nul 2>&1'] }
      }
      case 'bash': {
        const git = windowsGitBashPath()
        return git
          ? { file: git, args: ['--login', '-i'] }
          : { file: 'bash.exe', args: ['-l', '-i'] }
      }
      case 'zsh':
        return { file: 'zsh', args: ['-i'] }
      default:
        return { file: 'powershell.exe', args: ['-NoExit', '-Command', WINDOWS_POWERSHELL_UTF8_SESSION] }
    }
  }

  switch (choice) {
    case 'powershell':
      return { file: 'pwsh', args: [] }
    case 'cmd':
      return { file: process.env.SHELL || '/bin/bash', args: ['-l', '-i'] }
    case 'zsh': {
      const sh = process.env.SHELL?.includes('zsh') ? process.env.SHELL : '/bin/zsh'
      return { file: sh, args: ['-l', '-i'] }
    }
    case 'bash':
    default:
      return { file: process.env.SHELL || '/bin/bash', args: ['-l', '-i'] }
  }
}

/**
 * One-shot command execution (Bash tool, terminal:exec, hooks).
 * Always `shell: false` with explicit executable + args.
 */
export function getToolShellSpawnSpec(
  choice: DefaultShellId,
  command: string,
): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    switch (choice) {
      case 'cmd': {
        const gitBash = windowsGitBashPath()
        if (gitBash && shouldUseGitBashForWindowsCommand(command)) {
          return { file: gitBash, args: ['-lc', command] }
        }
        const com = process.env.ComSpec || 'cmd.exe'
        return { file: com, args: ['/d', '/s', '/c', withWindowsUtf8Console(command)] }
      }
      case 'powershell': {
        const gitBash = windowsGitBashPath()
        if (gitBash && shouldUseGitBashForWindowsCommand(command)) {
          return { file: gitBash, args: ['-lc', command] }
        }
        // `-EncodedCommand` instead of `-Command`: see `encodePowerShellCommand`
        // for why. Short version: `-Command "..."` passed via Node's spawn wraps
        // the script in double quotes, which makes PowerShell expand `$_` /
        // `$var` at the OUTER scope before the script runs — stripping
        // `$_.LineNumber` down to `.LineNumber` and breaking any ForEach-Object /
        // Where-Object pipeline.
        const psCmd = `${WINDOWS_POWERSHELL_UTF8_SESSION}; ${command}`
        return {
          file: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(psCmd)],
        }
      }
      case 'bash': {
        const git = windowsGitBashPath()
        const bash = git || 'bash.exe'
        return {
          file: bash,
          args: ['-lc', command],
        }
      }
      case 'zsh':
        return { file: 'zsh', args: ['-lc', command] }
      default:
        return {
          file: 'powershell.exe',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            encodePowerShellCommand(`${WINDOWS_POWERSHELL_UTF8_SESSION}; ${command}`),
          ],
        }
    }
  }

  switch (choice) {
    case 'powershell':
      return { file: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', command] }
    case 'zsh': {
      const z = process.env.SHELL?.includes('zsh') ? process.env.SHELL : '/bin/zsh'
      return { file: z, args: ['-lc', command] }
    }
    case 'cmd':
      return { file: process.env.SHELL || '/bin/bash', args: ['-lc', command] }
    case 'bash':
    default:
      return { file: process.env.SHELL || '/bin/bash', args: ['-lc', command] }
  }
}
