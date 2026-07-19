/**
 * Regression lock for the `workspace/configuration` handler.
 *
 * Background: Pyright (and many other LSPs) ask the client for settings on
 * every file analysis via the `workspace/configuration` request. Our
 * `LSPServerManager` used to reply `null` for every requested section, which
 * made Pyright ignore our `initializationOptions` at runtime — so the
 * `typeCheckingMode: 'off'` we carefully configured was silently reverted
 * to its built-in `basic` default on every file open, re-enabling
 * `reportArgumentType` / `reportUnusedVariable` noise the user kept
 * reporting as false positives.
 *
 * The fix wired a `resolveConfigSection(root, section)` helper that walks
 * the server's own `initializationOptions` tree. These tests pin the walk
 * semantics so a future refactor doesn't silently regress the lookup.
 */

import { describe, it, expect } from 'vitest'
import { resolveConfigSection } from './LSPServerManager'

describe('resolveConfigSection', () => {
  const tree = {
    python: {
      analysis: {
        typeCheckingMode: 'off',
        diagnosticSeverityOverrides: {
          reportArgumentType: 'none',
        },
        autoSearchPaths: true,
      },
      formatting: { provider: 'black' },
    },
    typescript: {
      preferences: { includePackageJsonAutoImports: 'on' },
    },
  }

  it('returns the full tree when section is null / undefined / empty', () => {
    expect(resolveConfigSection(tree, null)).toBe(tree)
    expect(resolveConfigSection(tree, undefined)).toBe(tree)
    expect(resolveConfigSection(tree, '')).toBe(tree)
    expect(resolveConfigSection(tree, '   ')).toBe(tree)
  })

  it('resolves a top-level section', () => {
    expect(resolveConfigSection(tree, 'python')).toBe(tree.python)
    expect(resolveConfigSection(tree, 'typescript')).toBe(tree.typescript)
  })

  it('resolves a dotted nested section (the common case for LSPs)', () => {
    expect(resolveConfigSection(tree, 'python.analysis')).toBe(tree.python.analysis)
    expect(resolveConfigSection(tree, 'python.formatting')).toBe(tree.python.formatting)
    expect(resolveConfigSection(tree, 'python.analysis.diagnosticSeverityOverrides')).toBe(
      tree.python.analysis.diagnosticSeverityOverrides,
    )
  })

  it('returns the leaf VALUE (not wrapped) when the section points at a scalar', () => {
    // This is the load-bearing semantic for the Pyright fix: when Pyright
    // asks for `python.analysis.typeCheckingMode`, we must answer with the
    // string `"off"`, not `{typeCheckingMode: "off"}`.
    expect(resolveConfigSection(tree, 'python.analysis.typeCheckingMode')).toBe('off')
    expect(resolveConfigSection(tree, 'python.analysis.autoSearchPaths')).toBe(true)
  })

  it('returns null for missing sections (not undefined — matches LSP spec)', () => {
    expect(resolveConfigSection(tree, 'nothing')).toBeNull()
    expect(resolveConfigSection(tree, 'python.missing')).toBeNull()
    expect(resolveConfigSection(tree, 'python.analysis.unknownKey')).toBeNull()
    expect(resolveConfigSection(tree, 'python.analysis.typeCheckingMode.extra')).toBeNull()
  })

  it('returns null when traversing through a non-object value', () => {
    // Pyright asked for `python.analysis.typeCheckingMode.XYZ` → once we hit
    // the string "off", we must not walk past it.
    expect(resolveConfigSection(tree, 'python.analysis.autoSearchPaths.anything')).toBeNull()
  })

  it('returns null when the root is not a plain object', () => {
    expect(resolveConfigSection(null, 'python')).toBeNull()
    expect(resolveConfigSection(undefined, 'python')).toBeNull()
    expect(resolveConfigSection('string', 'python')).toBeNull()
    expect(resolveConfigSection(42, 'python')).toBeNull()
  })

  it('does NOT cross array boundaries (arrays are leaf values)', () => {
    const withArray = { python: { paths: ['/a', '/b'] } }
    expect(resolveConfigSection(withArray, 'python.paths')).toEqual(['/a', '/b'])
    // Arrays are not traversable as objects.
    expect(resolveConfigSection(withArray, 'python.paths.0')).toBeNull()
  })

  it('tolerates empty path segments (trailing dot, double dots)', () => {
    expect(resolveConfigSection(tree, 'python..analysis')).toBe(tree.python.analysis)
    expect(resolveConfigSection(tree, '.python.')).toBe(tree.python)
  })

  it('normalises `undefined` leaf to `null` (LSP-spec-friendly)', () => {
    const withUndef = { python: { analysis: undefined } }
    expect(resolveConfigSection(withUndef, 'python.analysis')).toBeNull()
  })
})

describe('resolveConfigSection — Pyright production scenarios', () => {
  /**
   * Exact shape of what our `addDefaults` in `config.ts` actually ships for
   * the python server. Any refactor that breaks the Pyright-asks-then-gets
   * path re-opens the noisy-false-positive regression.
   */
  const pythonInitOpts = {
    python: {
      analysis: {
        diagnosticMode: 'workspace',
        useLibraryCodeForTypes: true,
        autoSearchPaths: true,
        autoImportCompletions: true,
        typeCheckingMode: 'off',
        diagnosticSeverityOverrides: {
          reportArgumentType: 'none',
          reportUnusedVariable: 'none',
        },
      },
    },
  }

  it('Pyright asking for `python` gets the full python block back', () => {
    expect(resolveConfigSection(pythonInitOpts, 'python')).toBe(pythonInitOpts.python)
  })

  it('Pyright asking for `python.analysis` gets the analysis object (the usual call)', () => {
    expect(resolveConfigSection(pythonInitOpts, 'python.analysis')).toBe(
      pythonInitOpts.python.analysis,
    )
  })

  it('Pyright asking for `python.analysis.typeCheckingMode` gets "off" directly', () => {
    expect(
      resolveConfigSection(pythonInitOpts, 'python.analysis.typeCheckingMode'),
    ).toBe('off')
  })

  it('Pyright asking for an unrelated section gets null (matches pre-fix behavior for irrelevant sections)', () => {
    expect(resolveConfigSection(pythonInitOpts, 'editor.tabSize')).toBeNull()
    expect(resolveConfigSection(pythonInitOpts, 'files.watcherExclude')).toBeNull()
  })
})
