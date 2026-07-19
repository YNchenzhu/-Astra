/**
 * Packaging consistency gate.
 *
 * Failure mode this protects against: a package is added to the electron
 * externals list (viteElectronExternals.ts) or to the MCP presets, dev keeps
 * working (everything resolves from the repo's node_modules / dev Node), and
 * the packaged build dies on end-user machines with "Cannot find module" or
 * a dead MCP preset. These assertions fail at unit-test time instead.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  EXTERNAL_PACKAGES,
  EXTERNAL_PREFIXES,
  EXTERNAL_NOT_SHIPPED,
  isElectronExternal,
} from '../viteElectronExternals'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
  },
}))

const repoRoot = path.resolve(__dirname, '..')

interface ElectronBuilderConfig {
  files: string[]
  asarUnpack: string[]
  extraResources: Array<{ from: string; to: string; filter?: string[] }>
}

function readBuilderConfig(): ElectronBuilderConfig {
  const raw = fs.readFileSync(path.join(repoRoot, 'electron-builder.json'), 'utf8')
  return JSON.parse(raw) as ElectronBuilderConfig
}

/**
 * Does a (possibly wildcarded) `node_modules/...` files glob cover `pkg`?
 * Handles both package-level globs (`node_modules/sharp/**` + `/*`) and
 * scope-level globs (`node_modules/@img/**` + `/*`, which cover every
 * package inside the scope).
 */
function filesEntryCoversPackage(entry: string, pkg: string): boolean {
  if (entry.startsWith('!')) return false
  const m = /^node_modules\/(.+?)\/\*\*\/\*$/.exec(entry)
  if (!m) return false
  const pattern = m[1]!
  const escaped = pattern
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${escaped}(/.*)?$`).test(pkg)
}

describe('electron externals ↔ electron-builder shipping contract', () => {
  const cfg = readBuilderConfig()

  it('every external package is shipped via electron-builder `files` (unless known-optional)', () => {
    const missing = EXTERNAL_PACKAGES.filter(
      (pkg) =>
        !(EXTERNAL_NOT_SHIPPED as readonly string[]).includes(pkg) &&
        !cfg.files.some((entry) => filesEntryCoversPackage(entry, pkg)),
    )
    expect(missing).toEqual([])
  })

  it('native / binary-carrying externals are asar-unpacked', () => {
    const needsUnpack = [
      'node-pty',
      'sharp',
      'onnxruntime-node',
      '@huggingface/transformers',
      '@napi-rs/canvas',
      '@vscode/ripgrep',
      // platform binary siblings
      '@vscode/ripgrep-win32-x64',
      '@napi-rs/canvas-win32-x64-msvc',
      '@img/sharp-win32-x64',
    ]
    const missing = needsUnpack.filter(
      (pkg) => !cfg.asarUnpack.some((entry) => filesEntryCoversPackage(entry, pkg)),
    )
    expect(missing).toEqual([])
  })

  it('vite.config.ts has no ad-hoc inline external predicate (must use isElectronExternal)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'vite.config.ts'), 'utf8')
    expect(src).not.toMatch(/external:\s*\(/)
    expect(src).toContain('isElectronExternal')
  })

  it('isElectronExternal matches ids and deep imports', () => {
    expect(isElectronExternal('node-pty')).toBe(true)
    expect(isElectronExternal('@vscode/ripgrep')).toBe(true)
    expect(isElectronExternal('@vscode/ripgrep-win32-x64')).toBe(true)
    expect(isElectronExternal('pdfjs-dist/legacy/build/pdf.mjs')).toBe(true)
    expect(isElectronExternal('@img/sharp-win32-x64')).toBe(true)
    expect(isElectronExternal('react')).toBe(false)
    // Sanity: every declared prefix keeps matching itself.
    for (const p of EXTERNAL_PREFIXES) expect(isElectronExternal(`${p}anything`)).toBe(true)
  })
})

describe('MCP presets ↔ bundled-mcp vendoring contract', () => {
  it('every npx-based MCP preset package is vendored in bundled-mcp/package.json', async () => {
    const { MCP_PRESETS } = await import('./mcp/presets')
    const npxPkgs = new Set<string>()
    for (const preset of MCP_PRESETS) {
      if (preset.config.command !== 'npx') continue
      // args shape: ['-y', '<pkg>', ...extra]
      const pkg = preset.config.args.find((a) => !a.startsWith('-'))
      expect(pkg, `preset ${preset.id} should name an npm package`).toBeTruthy()
      npxPkgs.add(pkg!)
    }

    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'bundled-mcp', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    const vendored = new Set(Object.keys(manifest.dependencies ?? {}))

    const missing = [...npxPkgs].filter((p) => !vendored.has(p))
    expect(
      missing,
      'add these to bundled-mcp/package.json (packaged builds cannot run bare npx)',
    ).toEqual([])
  })

  it('bundled-mcp is mapped into resources/node_modules by extraResources', () => {
    const cfg = readBuilderConfig()
    const entry = cfg.extraResources.find((r) => r.from === 'bundled-mcp/node_modules')
    expect(entry, 'extraResources must ship bundled-mcp/node_modules').toBeTruthy()
    // transport.ts#resolvePackagedNpxStdio reads process.resourcesPath/node_modules
    expect(entry!.to).toBe('node_modules')
  })

  it('bundled-mcp pins exact versions (reproducible installers)', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'bundled-mcp', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    for (const [pkg, version] of Object.entries(manifest.dependencies ?? {})) {
      expect(version, `${pkg} must be pinned (no ^ / ~ / ranges)`).toMatch(/^\d/)
    }
  })
})

describe('CI runtime contract', () => {
  it('uses an Electron-compatible Node version and installs its binary before tests', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { engines?: { node?: string }; devDependencies?: { electron?: string } }
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
      'utf8',
    )

    expect(manifest.engines?.node).toBe('>=22.12.0')
    expect(manifest.devDependencies?.electron).toBe('^43.0.0')
    expect(workflow).toMatch(/node-version:\s*['"]24['"]/)

    const electronInstallAt = workflow.indexOf('node node_modules/electron/install.js')
    const unitTestsAt = workflow.indexOf('npx vitest run')
    expect(electronInstallAt).toBeGreaterThan(-1)
    expect(unitTestsAt).toBeGreaterThan(electronInstallAt)
  })
})
