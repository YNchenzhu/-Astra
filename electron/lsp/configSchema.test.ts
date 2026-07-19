import { describe, expect, it } from 'vitest'
import { parseLspServerConfig } from './configSchema'

describe('parseLspServerConfig', () => {
  it('accepts minimal valid server', () => {
    const raw = {
      command: 'typescript-language-server',
      args: ['--stdio'],
      extensionToLanguage: { '.ts': 'typescript' },
    }
    const p = parseLspServerConfig(raw, 'test')
    expect(p).not.toBeNull()
    expect(p?.command).toBe('typescript-language-server')
  })

  it('rejects socket transport', () => {
    const raw = {
      command: 'x',
      extensionToLanguage: { '.a': 'a' },
      transport: 'socket' as const,
    }
    expect(parseLspServerConfig(raw, 'test')).toBeNull()
  })

  it('accepts restartOnCrash as a passthrough field', () => {
    // `lspServerConfigSchema` intentionally declares `restartOnCrash` /
    // `shutdownTimeout` as optional passthrough fields (see the rationale
    // comment in configSchema.ts): rejecting them outright caused spurious
    // parse failures for configs copied from other LSP tooling. They are not
    // consumed anywhere — pure tolerance. So the config must parse AND the
    // field must survive in the output.
    const raw = {
      command: 'x',
      extensionToLanguage: { '.a': 'a' },
      restartOnCrash: true,
    }
    const p = parseLspServerConfig(raw, 'test')
    expect(p).not.toBeNull()
    expect(p?.restartOnCrash).toBe(true)
  })

  it('accepts bundledPackage + bundledScript (audit #16)', () => {
    const raw = {
      command: 'my-lang-server',
      extensionToLanguage: { '.xyz': 'xyz' },
      bundledPackage: 'my-lang-server',
      bundledScript: 'dist/server.js',
    }
    const p = parseLspServerConfig(raw, 'test')
    expect(p).not.toBeNull()
    expect(p?.bundledPackage).toBe('my-lang-server')
    expect(p?.bundledScript).toBe('dist/server.js')
  })

  it('rejects bundledPackage without bundledScript', () => {
    const raw = {
      command: 'my-lang-server',
      extensionToLanguage: { '.xyz': 'xyz' },
      bundledPackage: 'my-lang-server',
    }
    expect(parseLspServerConfig(raw, 'test')).toBeNull()
  })

  it('rejects bundledScript without bundledPackage', () => {
    const raw = {
      command: 'my-lang-server',
      extensionToLanguage: { '.xyz': 'xyz' },
      bundledScript: 'dist/server.js',
    }
    expect(parseLspServerConfig(raw, 'test')).toBeNull()
  })
})
