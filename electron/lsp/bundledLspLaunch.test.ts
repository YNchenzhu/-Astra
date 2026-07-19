import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveBundledLspSpawn } from './bundledLspLaunch'

describe('resolveBundledLspSpawn (audit #16)', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-lsp-'))
    process.env.ASTRA_BUNDLED_LSP_ROOT = tmpRoot
  })

  afterEach(() => {
    delete process.env.ASTRA_BUNDLED_LSP_ROOT
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  function plantPackage(packageName: string, script: string): string {
    const dir = path.join(tmpRoot, packageName, path.dirname(script))
    fs.mkdirSync(dir, { recursive: true })
    const scriptPath = path.join(tmpRoot, packageName, script)
    fs.writeFileSync(scriptPath, '// mock lsp\n', 'utf-8')
    return scriptPath
  }

  it('uses the built-in BUNDLED_ENTRY when command matches', () => {
    const scriptPath = plantPackage('typescript-language-server', 'lib/cli.mjs')
    const out = resolveBundledLspSpawn('typescript-language-server', ['--stdio'])
    expect(out.command).toBe(process.execPath)
    expect(out.args[0]).toBe(scriptPath)
    expect(out.args).toContain('--stdio')
  })

  it('honors user-provided bundledPackage + bundledScript override', () => {
    const scriptPath = plantPackage('my-lang-server', 'dist/server.js')
    const out = resolveBundledLspSpawn(
      'my-lang-server', // Not in BUNDLED_ENTRY, would fall back to PATH without override.
      ['--stdio'],
      undefined,
      { bundledPackage: 'my-lang-server', bundledScript: 'dist/server.js' },
    )
    expect(out.command).toBe(process.execPath)
    expect(out.args[0]).toBe(scriptPath)
    expect(out.args).toContain('--stdio')
  })

  it('falls back to PATH spawn when override script is missing', () => {
    const out = resolveBundledLspSpawn(
      'my-lang-server',
      [],
      undefined,
      { bundledPackage: 'not-here', bundledScript: 'missing.js' },
    )
    expect(out.command).toBe('my-lang-server')
    expect(out.args).toEqual([])
  })

  it('leaves absolute existing paths unchanged (dev-hosted LSP)', () => {
    const abs = path.join(tmpRoot, 'abs-lsp.js')
    fs.writeFileSync(abs, '// mock\n', 'utf-8')
    const out = resolveBundledLspSpawn(abs, ['--stdio'])
    expect(out.command).toBe(abs)
    expect(out.args).toEqual(['--stdio'])
  })

  it('returns unchanged command for unknown, non-overridden command (PATH fallback)', () => {
    const out = resolveBundledLspSpawn('rust-analyzer', [])
    expect(out.command).toBe('rust-analyzer')
  })
})
