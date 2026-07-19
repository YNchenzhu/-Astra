/**
 * Build a safe environment for MCP stdio children spawned from the Electron main process.
 *
 * Passing the full `process.env` through often breaks plain Node servers: the IDE/VS Code/Electron
 * inject `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, inspector flags, etc. Child `node` then exits
 * immediately → stdio closes → MCP client sees error -32000 "Connection closed".
 *
 * Windows also caps the process environment block (~32KiB UTF-16); a bloated parent env can fail
 * child creation or yield unstable behavior.
 *
 * GUI-launched Electron often inherits a **short PATH** without `node` / global npm — `npx` then
 * exits immediately. We prepend common install dirs (and NVM/FNM/Volta when those vars exist).
 */

import fs from 'node:fs'
import path from 'node:path'
import { getPathFromEnv, setPathOnEnv } from './envPath'

/** Strip these when copying from the parent (case-insensitive keys on Windows). */
const MCP_STDIO_PARENT_ENV_STRIP = new Set(
  [
    'NODE_OPTIONS',
    'NODE_REPL_EXTERNAL_MODULE',
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ATTACH_CONSOLE',
    'ELECTRON_ENABLE_SECURITY_WARNINGS',
    'VSCODE_INSPECTOR_OPTIONS',
    'VSCODE_L10N_BUNDLE_LOCATION',
  ].map((k) => k.toUpperCase()),
)

const WIN_MINIMAL_ENV_KEYS = new Set(
  [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'SYSTEMDRIVE',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'USERNAME',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'PROGRAMFILESARM64',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'PUBLIC',
    'COMPUTERNAME',
    'USERDOMAIN',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
    'COMSPEC',
    'NODE_PATH',
    'TZ',
  ].map((k) => k.toUpperCase()),
)

const UNIX_MINIMAL_ENV_KEYS = new Set(
  ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_PATH', 'TZ'].map((k) =>
    k.toUpperCase(),
  ),
)

function shouldStripParentEnvKey(key: string): boolean {
  return MCP_STDIO_PARENT_ENV_STRIP.has(key.toUpperCase())
}

/** UTF-16 code units + NUL terminators; good enough to stay under the ~32KiB Windows cap. */
export function approximateWin32EnvBlockUnits(env: Record<string, string>): number {
  let n = 0
  for (const [k, v] of Object.entries(env)) {
    n += k.length + 1 + v.length + 1
  }
  return n + 1
}

export function copyProcessEnvForMcpStdioChild(options?: { minimal?: boolean }): Record<string, string> {
  const minimal = options?.minimal === true
  const allow = minimal
    ? process.platform === 'win32'
      ? WIN_MINIMAL_ENV_KEYS
      : UNIX_MINIMAL_ENV_KEYS
    : null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue
    if (shouldStripParentEnvKey(k)) continue
    if (allow && !allow.has(k.toUpperCase())) continue
    out[k] = v
  }
  return out
}

const WIN32_ENV_BLOCK_SOFT_LIMIT = 30_000
const UNIX_ENV_SOFT_LIMIT = 200_000

/**
 * If the merged env is huge (Windows), rebuild from a minimal parent slice plus user `configEnv`
 * (secrets and overrides must stay in `configEnv`).
 */
export function shrinkMcpStdioEnvIfNeeded(
  merged: Record<string, string>,
  configEnv: Record<string, string>,
): Record<string, string> {
  const limit = process.platform === 'win32' ? WIN32_ENV_BLOCK_SOFT_LIMIT : UNIX_ENV_SOFT_LIMIT
  const size =
    process.platform === 'win32' ? approximateWin32EnvBlockUnits(merged) : approximateUnixEnvUtf8Bytes(merged)
  if (size <= limit) return merged
  const minimal = copyProcessEnvForMcpStdioChild({ minimal: true })
  return { ...minimal, ...configEnv }
}

function approximateUnixEnvUtf8Bytes(env: Record<string, string>): number {
  let n = 0
  for (const [k, v] of Object.entries(env)) {
    n += k.length + 1 + v.length + 1
  }
  return n
}

/**
 * Prepend directories that typically contain `node` / `npx` when the parent PATH is minimal
 * (e.g. app started from Explorer or IDE without a shell profile).
 */
export function ensureNodeToolingBinDirsOnPath(env: Record<string, string>): void {
  const delim = path.delimiter
  const raw = getPathFromEnv(env)
  const parts = raw.split(delim).map((s) => s.trim()).filter(Boolean)
  const seen = new Set(parts.map((p) => p.toLowerCase()))
  const extras: string[] = []

  const pushIfDir = (p: string | undefined) => {
    if (!p?.trim()) return
    const n = path.normalize(p.trim())
    try {
      if (fs.existsSync(n) && !seen.has(n.toLowerCase())) {
        extras.push(n)
        seen.add(n.toLowerCase())
      }
    } catch {
      /* ignore */
    }
  }

  if (process.platform === 'win32') {
    const programFiles = env.ProgramFiles || process.env.ProgramFiles
    const programFilesX86 = env['ProgramFiles(x86)'] || process.env['ProgramFiles(x86)']
    const appData = env.APPDATA || process.env.APPDATA
    const userProfile = env.USERPROFILE || process.env.USERPROFILE
    const localAppData = env.LOCALAPPDATA || process.env.LOCALAPPDATA
    pushIfDir(programFiles ? path.join(programFiles, 'nodejs') : undefined)
    pushIfDir(programFilesX86 ? path.join(programFilesX86, 'nodejs') : undefined)
    pushIfDir(appData ? path.join(appData, 'npm') : undefined)
    pushIfDir(env.NVM_SYMLINK || process.env.NVM_SYMLINK)
    pushIfDir(env.NVM_BIN || process.env.NVM_BIN)
    pushIfDir(env.FNM_MULTISHELL_PATH || process.env.FNM_MULTISHELL_PATH)
    pushIfDir(userProfile ? path.join(userProfile, '.volta', 'bin') : undefined)
    pushIfDir(userProfile ? path.join(userProfile, 'scoop', 'shims') : undefined)
    if (localAppData) {
      pushIfDir(path.join(localAppData, 'fnm'))
    }
  } else {
    pushIfDir('/usr/local/bin')
    pushIfDir('/opt/homebrew/bin')
    const home = env.HOME || process.env.HOME
    pushIfDir(home ? path.join(home, '.volta', 'bin') : undefined)
    pushIfDir(env.NVM_BIN || process.env.NVM_BIN)
    pushIfDir(env.FNM_MULTISHELL_PATH || process.env.FNM_MULTISHELL_PATH)
  }

  if (extras.length === 0) return
  setPathOnEnv(env, [...extras, ...parts].join(delim))
}
