/**
 * Windows spawn helpers: paths with spaces in `command` / argv[0] can yield
 * `spawn … ENOENT` when packaged MCP rewrites `npx` → `process.execPath` + script.
 *
 * MCP stdio uses `@modelcontextprotocol/sdk` → `cross-spawn`, which wraps `.cmd`
 * shims (e.g. `npx`) with `cmd.exe` using `process.env.ComSpec` (see cross-spawn
 * `lib/parse.js`). A missing/invalid ComSpec or a child `PATH` without System32
 * surfaces as `spawn C:\Windows\system32\cmd.exe ENOENT`.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getPathFromEnv, setPathOnEnv } from './envPath'

function windowsInstallRoot(): string {
  for (const k of ['windir', 'SystemRoot', 'SYSTEMROOT'] as const) {
    const v = process.env[k]
    if (v?.trim()) return v
  }
  return 'C:\\Windows'
}

/**
 * Point ComSpec at the first existing `cmd.exe` so cross-spawn can run `.cmd` shims.
 * Mutates `process.env` (main process only).
 */
export function normalizeWin32ComSpec(): void {
  if (process.platform !== 'win32') return
  const windir = windowsInstallRoot()
  const candidates = [
    process.env.ComSpec,
    process.env.COMSPEC,
    path.join(windir, 'System32', 'cmd.exe'),
    path.join(windir, 'Sysnative', 'cmd.exe'),
  ].filter((c): c is string => Boolean(c?.trim()))
  for (const c of candidates) {
    const normalized = path.normalize(c)
    try {
      if (fs.existsSync(normalized)) {
        process.env.ComSpec = normalized
        process.env.COMSPEC = normalized
        return
      }
    } catch {
      /* try next */
    }
  }
}

/**
 * `cross-spawn` resolves commands with `which` using the **spawn options env** PATH.
 * MCP server `env` in JSON can replace PATH without System32 → ENOENT for `npx` / `cmd`.
 */
export function ensureSystem32OnPath(env: Record<string, string>): void {
  if (process.platform !== 'win32') return
  const windir = env.windir || env.SystemRoot || env.SYSTEMROOT || windowsInstallRoot()
  const dirs = [path.join(windir, 'System32'), path.join(windir, 'Sysnative')].filter((d) => {
    try {
      return fs.existsSync(d)
    } catch {
      return false
    }
  })
  if (dirs.length === 0) return
  const delim = path.delimiter
  const parts = getPathFromEnv(env)
    .split(delim)
    .map((p) => p.trim())
    .filter(Boolean)
  const seen = new Set(parts.map((p) => p.toLowerCase()))
  const prefix: string[] = []
  for (const d of dirs) {
    if (!seen.has(d.toLowerCase())) {
      prefix.push(d)
      seen.add(d.toLowerCase())
    }
  }
  if (prefix.length === 0) return
  setPathOnEnv(env, [...prefix, ...parts].join(delim))
}

export function win32ShortPathIfNeeded(absPath: string): string {
  if (process.platform !== 'win32' || !absPath) return absPath
  if (!absPath.includes(' ')) return absPath
  if (!fs.existsSync(absPath)) return absPath
  const windir = windowsInstallRoot()
  const cmdCandidate = path.join(windir, 'System32', 'cmd.exe')
  const cmdExec = fs.existsSync(cmdCandidate) ? cmdCandidate : 'cmd.exe'
  try {
    const escaped = absPath.replace(/"/g, '""')
    const cmdLine = `for %I in ("${escaped}") do @echo %~sI`
    const out = execFileSync(cmdExec, ['/d', '/s', '/c', cmdLine], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    const candidate = lines[lines.length - 1] ?? ''
    if (candidate && fs.existsSync(candidate)) return candidate
  } catch {
    /* keep long path */
  }
  return absPath
}
