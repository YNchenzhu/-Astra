/**
 * Tests for the workspace tsconfig loader. The critical regression these
 * guard against is the "Project References solution dispatcher" case where
 * the root tsconfig.json has `"files": []` + `"references"` and NO
 * compilerOptions. Without Project-References support Monaco's TS worker
 * ends up with a near-empty config and floods the Problems panel with
 * bogus import/export errors.
 */

import { describe, it, expect } from 'vitest'
import { __test__ } from './monacoWorkspaceTsConfig'

const {
  parseTsconfigLike,
  aggregateWorkspaceCompilerOptions,
  scoreTsconfigForUiPrimary,
  resolveReferenceToConfigFile,
  resolveExtendsToConfigFile,
  joinAndNormalize,
  dirname,
} = __test__

/** Build an in-memory ReadFile over a plain map. */
function makeReadFile(fs: Record<string, string>) {
  return async (p: string) => {
    const normalized = p.replace(/\\/g, '/')
    if (Object.prototype.hasOwnProperty.call(fs, normalized)) {
      return { success: true, content: fs[normalized] }
    }
    return { success: false, error: 'ENOENT' }
  }
}

describe('monacoWorkspaceTsConfig — path helpers', () => {
  it('joinAndNormalize resolves .. and .', () => {
    expect(joinAndNormalize('/a/b', './c.json')).toBe('/a/b/c.json')
    expect(joinAndNormalize('/a/b', '../c.json')).toBe('/a/c.json')
    expect(joinAndNormalize('/a/b', '../../c.json')).toBe('/c.json')
    expect(joinAndNormalize('C:/proj/src', './types/d.json')).toBe('C:/proj/src/types/d.json')
  })

  it('dirname strips the last segment (posix + windows)', () => {
    expect(dirname('/a/b/c')).toBe('/a/b')
    expect(dirname('C:\\proj\\tsconfig.json')).toBe('C:/proj')
  })

  it('resolveReferenceToConfigFile appends tsconfig.json to directory paths', () => {
    expect(resolveReferenceToConfigFile('/p', './sub')).toBe('/p/sub/tsconfig.json')
    expect(resolveReferenceToConfigFile('/p', './sub.json')).toBe('/p/sub.json')
    expect(resolveReferenceToConfigFile('/p', './tsconfig.app.json')).toBe('/p/tsconfig.app.json')
  })

  it('resolveExtendsToConfigFile handles relative paths and skips package names', () => {
    expect(resolveExtendsToConfigFile('/p', './base')).toBe('/p/base.json')
    expect(resolveExtendsToConfigFile('/p', './base.json')).toBe('/p/base.json')
    // Package-style extends require node_modules resolution; we don't support
    // that from the renderer and silently skip.
    expect(resolveExtendsToConfigFile('/p', '@tsconfig/strictest')).toBeNull()
  })
})

describe('monacoWorkspaceTsConfig — parser resilience', () => {
  it('tolerates // and /* */ comments', () => {
    const raw = `{
      // leading comment
      "compilerOptions": {
        "target": "ES2023" /* inline */ ,
        "jsx": "react-jsx" // trailing
      },
      "include": ["src"]
    }`
    const parsed = parseTsconfigLike(raw)
    expect(parsed?.compilerOptions?.target).toBe('ES2023')
    expect(parsed?.compilerOptions?.jsx).toBe('react-jsx')
  })

  it('tolerates trailing commas', () => {
    const parsed = parseTsconfigLike('{"compilerOptions": {"target": "ES2020",},}')
    expect(parsed?.compilerOptions?.target).toBe('ES2020')
  })

  it('returns null for malformed JSON', () => {
    expect(parseTsconfigLike('{ bad')).toBeNull()
  })
})

describe('monacoWorkspaceTsConfig — Project References aggregation', () => {
  it('picks up compilerOptions from the root when not a solution', () => {
    const fs = {
      '/proj/tsconfig.json': JSON.stringify({
        compilerOptions: { target: 'ES2020', jsx: 'react-jsx' },
        include: ['src'],
      }),
    }
    return aggregateWorkspaceCompilerOptions('/proj', makeReadFile(fs)).then((out) => {
      expect(out.compilerOptions).not.toBeNull()
      expect(out.compilerOptions!.target).toBe('ES2020')
      expect(out.compilerOptions!.jsx).toBe('react-jsx')
      expect(out.primaryPath).toBe('/proj/tsconfig.json')
    })
  })

  it('walks Project References and prefers the src-covering project (the real repo layout)', async () => {
    // Exact shape of this repo: root is solution, app covers `src`, electron
    // covers `electron/`. Historically Monaco loaded ONLY the root and got
    // nothing — leading to every .tsx file flashing import/export errors.
    const fs = {
      '/proj/tsconfig.json': JSON.stringify({
        files: [],
        references: [
          { path: './tsconfig.app.json' },
          { path: './tsconfig.node.json' },
          { path: './tsconfig.electron.json' },
        ],
      }),
      '/proj/tsconfig.app.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          lib: ['ES2023', 'DOM', 'DOM.Iterable'],
          jsx: 'react-jsx',
          module: 'ESNext',
          moduleResolution: 'bundler',
          allowImportingTsExtensions: true,
          strict: true,
        },
        include: ['src'],
      }),
      '/proj/tsconfig.node.json': JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true },
        include: ['vite.config.ts'],
      }),
      '/proj/tsconfig.electron.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'CommonJS',
          moduleResolution: 'node',
          lib: ['ES2022'],
          strict: true,
        },
        include: ['electron'],
      }),
    }

    const out = await aggregateWorkspaceCompilerOptions('/proj', makeReadFile(fs))
    expect(out.compilerOptions).not.toBeNull()
    const co = out.compilerOptions!

    // The app project wins the merge, so UI-critical options like
    // DOM lib + jsx react-jsx + bundler resolution are preserved.
    expect(co.target).toBe('ES2023')
    expect(co.jsx).toBe('react-jsx')
    expect(co.lib).toEqual(['ES2023', 'DOM', 'DOM.Iterable'])
    expect(co.moduleResolution).toBe('bundler')
    expect(co.allowImportingTsExtensions).toBe(true)

    expect(out.primaryPath).toBe('/proj/tsconfig.app.json')
  })

  it('applies the extends chain on referenced projects', async () => {
    const fs = {
      '/proj/tsconfig.json': JSON.stringify({
        files: [],
        references: [{ path: './tsconfig.app.json' }],
      }),
      '/proj/tsconfig.base.json': JSON.stringify({
        compilerOptions: { strict: true, skipLibCheck: true, target: 'ES2015' },
      }),
      '/proj/tsconfig.app.json': JSON.stringify({
        extends: './tsconfig.base.json',
        compilerOptions: { target: 'ES2023', jsx: 'react-jsx' },
        include: ['src'],
      }),
    }

    const out = await aggregateWorkspaceCompilerOptions('/proj', makeReadFile(fs))
    const co = out.compilerOptions!
    expect(co.strict).toBe(true) // inherited from base
    expect(co.skipLibCheck).toBe(true) // inherited from base
    expect(co.target).toBe('ES2023') // overridden by app
    expect(co.jsx).toBe('react-jsx') // from app only
  })

  it('falls back to jsconfig.json when tsconfig.json is absent', async () => {
    const fs = {
      '/proj/jsconfig.json': JSON.stringify({
        compilerOptions: { allowJs: true, checkJs: false, target: 'ES2020' },
        include: ['src'],
      }),
    }
    const out = await aggregateWorkspaceCompilerOptions('/proj', makeReadFile(fs))
    expect(out.compilerOptions?.target).toBe('ES2020')
    expect(out.compilerOptions?.allowJs).toBe(true)
    expect(out.primaryPath).toBe('/proj/jsconfig.json')
  })

  it('returns empty compilerOptions when workspace has no tsconfig at all', async () => {
    const out = await aggregateWorkspaceCompilerOptions('/empty', makeReadFile({}))
    expect(out.compilerOptions).toBeNull()
    expect(out.primaryPath).toBeNull()
  })

  it('survives reference cycles (self-extends loop)', async () => {
    const fs = {
      '/p/tsconfig.json': JSON.stringify({
        extends: './tsconfig.json',
        compilerOptions: { target: 'ES2020' },
      }),
    }
    const out = await aggregateWorkspaceCompilerOptions('/p', makeReadFile(fs))
    expect(out.compilerOptions?.target).toBe('ES2020')
  })

  it('skips package-style extends without crashing', async () => {
    const fs = {
      '/p/tsconfig.json': JSON.stringify({
        extends: '@tsconfig/strictest/tsconfig.json',
        compilerOptions: { jsx: 'react-jsx' },
      }),
    }
    const out = await aggregateWorkspaceCompilerOptions('/p', makeReadFile(fs))
    expect(out.compilerOptions?.jsx).toBe('react-jsx')
  })
})

describe('monacoWorkspaceTsConfig — scoring', () => {
  it('prefers configs whose include globs cover src/', () => {
    const src = {
      path: '/proj/tsconfig.app.json',
      compilerOptions: {},
      references: [],
      include: ['src'],
      files: [],
    }
    const electron = {
      path: '/proj/tsconfig.electron.json',
      compilerOptions: {},
      references: [],
      include: ['electron'],
      files: [],
    }
    expect(scoreTsconfigForUiPrimary(src)).toBeGreaterThan(scoreTsconfigForUiPrimary(electron))
  })
})
