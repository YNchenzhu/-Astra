/**
 * Ship Node-based language servers under `bundled-lsp/node_modules` (dev + extraResources when packaged).
 * Spawn them with Electron as Node (`ELECTRON_RUN_AS_NODE`) in production, or plain Node in tests / non-Electron.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Maps configured `command` basename → package dir + entry script under node_modules. */
const BUNDLED_ENTRY: Record<string, { packageName: string; script: string }> = {
  'typescript-language-server': {
    packageName: 'typescript-language-server',
    script: 'lib/cli.mjs',
  },
  'pyright-langserver': { packageName: 'pyright', script: 'langserver.index.js' },
  'vscode-json-language-server': {
    packageName: 'vscode-langservers-extracted',
    script: 'lib/json-language-server/node/jsonServerMain.js',
  },
  'vscode-json-languageserver': {
    packageName: 'vscode-langservers-extracted',
    script: 'lib/json-language-server/node/jsonServerMain.js',
  },
  'vscode-css-language-server': {
    packageName: 'vscode-langservers-extracted',
    script: 'lib/css-language-server/node/cssServerMain.js',
  },
  'vscode-html-language-server': {
    packageName: 'vscode-langservers-extracted',
    script: 'lib/html-language-server/node/htmlServerMain.js',
  },
  'vscode-markdown-language-server': {
    packageName: 'vscode-langservers-extracted',
    script: 'lib/markdown-language-server/node/main.js',
  },
}

function isElectronRuntime(): boolean {
  return typeof process.versions.electron === 'string' && process.versions.electron.length > 0
}

/**
 * Root of hoisted `node_modules` for bundled LSP packages (`bundled-lsp/node_modules`).
 * Override with `ASTRA_BUNDLED_LSP_ROOT` for tests.
 */
export function getBundledLspNodeModulesRoot(): string | undefined {
  const envRoot = process.env.ASTRA_BUNDLED_LSP_ROOT?.trim()
  if (envRoot) {
    const r = path.resolve(envRoot)
    try {
      if (fs.existsSync(r) && fs.statSync(r).isDirectory()) return r
    } catch {
      /* ignore */
    }
    return undefined
  }

  try {
    // Lazy `require` so this helper stays importable outside an Electron
    // main-process (e.g. static-analysis tooling) — `app` isn't wired up
    // until the Electron module is evaluated.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
    if (app.isPackaged && typeof process.resourcesPath === 'string') {
      const p = path.join(process.resourcesPath, 'bundled-lsp', 'node_modules')
      if (fs.existsSync(p)) return p
    }
    const fromApp = path.join(app.getAppPath(), 'bundled-lsp', 'node_modules')
    if (fs.existsSync(fromApp)) return fromApp
  } catch {
    /* require('electron') unavailable */
  }

  const cwd = path.join(process.cwd(), 'bundled-lsp', 'node_modules')
  return fs.existsSync(cwd) ? cwd : undefined
}

export function bundledLspPackagePresent(packageName: string): boolean {
  const root = getBundledLspNodeModulesRoot()
  if (!root) return false
  return fs.existsSync(path.join(root, packageName, 'package.json'))
}

function normalizeCommandKey(command: string): string {
  const base = path.basename(command.replace(/\\/g, '/'))
  return base.replace(/\.(cmd|exe|bat)$/i, '')
}

/**
 * If a bundled script exists for this command, run it via Electron-as-Node (packaged) or `node` (dev/tests).
 * Absolute existing `command` paths are left unchanged.
 *
 * Resolution order (audit #16):
 *   1. If the caller passed `override.bundledPackage` + `override.bundledScript`, use those
 *      verbatim — this is the escape hatch for `.lsp.json`-declared bundled servers.
 *   2. Otherwise, look the command's base name up in the built-in `BUNDLED_ENTRY` map
 *      (covers the default shipped servers: `typescript-language-server`, `pyright`, …).
 *   3. Otherwise return the command unchanged (PATH spawn).
 */
export function resolveBundledLspSpawn(
  command: string,
  args: string[],
  baseEnv?: Record<string, string>,
  override?: { bundledPackage?: string; bundledScript?: string },
): { command: string; args: string[]; env: Record<string, string> } {
  const mergeEnv = (): Record<string, string> => ({
    ...(process.env as Record<string, string>),
    ...baseEnv,
  })

  if (path.isAbsolute(command) && fs.existsSync(command)) {
    return { command, args, env: mergeEnv() }
  }

  let packageName: string | undefined
  let script: string | undefined

  if (override?.bundledPackage && override.bundledScript) {
    packageName = override.bundledPackage
    script = override.bundledScript
  } else {
    const key = normalizeCommandKey(command)
    const entry = BUNDLED_ENTRY[key]
    if (entry) {
      packageName = entry.packageName
      script = entry.script
    }
  }

  const root = getBundledLspNodeModulesRoot()
  if (!packageName || !script || !root) {
    return { command, args, env: mergeEnv() }
  }

  const scriptPath = path.join(root, packageName, script)
  if (!fs.existsSync(scriptPath)) {
    if (override?.bundledPackage) {
      // User asked for a bundled launch but the file is missing — surface this in
      // the console to help diagnose packaging issues. Fall back to PATH spawn so
      // `dev` with a non-bundled install path still works.
      console.warn(
        `[LSP] bundled script not found: ${scriptPath} — falling back to PATH spawn for "${command}"`,
      )
    }
    return { command, args, env: mergeEnv() }
  }

  const extra: Record<string, string> = {}
  if (isElectronRuntime()) {
    extra.ELECTRON_RUN_AS_NODE = '1'
  }

  return {
    command: process.execPath,
    args: [scriptPath, ...args],
    env: { ...mergeEnv(), ...extra },
  }
}
