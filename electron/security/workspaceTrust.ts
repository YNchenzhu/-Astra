/**
 * Workspace trust list — upstream-style gate before running workspace-scoped LSP configs
 * (arbitrary `command` from `.lsp.json`).
 */

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { readDiskSettings } from '../settings/settingsAccess'
import { parseWorkspaceTrustMode } from './workspaceTrustSettings'

const FILE = 'trusted-workspaces.json'

function trustFilePath(): string {
  return path.join(app.getPath('userData'), FILE)
}

function normalizeRoot(p: string): string {
  const t = path.resolve(String(p).trim())
  return process.platform === 'win32' ? t.toLowerCase() : t
}

function readList(): string[] {
  try {
    const f = trustFilePath()
    if (!fs.existsSync(f)) return []
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  } catch {
    return []
  }
}

function writeList(entries: string[]): void {
  const f = trustFilePath()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify([...new Set(entries.map(normalizeRoot))].sort(), null, 2))
}

/**
 * - **legacy** (default): when the trust store file does not exist yet, treat all workspaces
 *   as trusted (upgrade compatibility). After the file exists, only listed roots are trusted.
 * - **strict**: missing file means nothing is trusted until the user adds a root (upstream-style
 *   explicit trust from first run). Set via Settings → 权限 → 工作区信任模式.
 */
export function isWorkspaceTrusted(workspacePath: string): boolean {
  const mode = parseWorkspaceTrustMode(readDiskSettings().workspaceTrustMode)
  if (!fs.existsSync(trustFilePath())) {
    return mode !== 'strict'
  }
  const n = normalizeRoot(workspacePath)
  return readList().some((e) => normalizeRoot(e) === n)
}

export function listTrustedWorkspaceRoots(): string[] {
  return readList()
}

export function addTrustedWorkspaceRoot(workspacePath: string): void {
  const n = normalizeRoot(workspacePath)
  const next = readList().filter((e) => normalizeRoot(e) !== n)
  next.push(n)
  writeList(next)
}

export function removeTrustedWorkspaceRoot(workspacePath: string): void {
  const n = normalizeRoot(workspacePath)
  writeList(readList().filter((e) => normalizeRoot(e) !== n))
}
