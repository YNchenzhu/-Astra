/**
 * Alias-consistency audit for tool inputs.
 *
 * Motivation: the AI models in the wild emit tool arguments in different
 * casings and vocabularies — `filePath` vs `file_path` vs `path`, `cwd` vs
 * `path` vs `directory`, etc. We accept multiple aliases in each tool's
 * zod schema so small stylistic slips don't cost a round-trip. This audit
 * verifies — functionally, by running inputs through the schemas — that:
 *
 *   1. Every file-accepting tool (read, write, edit, LSP, …) accepts
 *      `filePath`, `file_path`, and (where unambiguous) `path`.
 *   2. Every directory-accepting tool (list_files, glob) accepts `dirPath`,
 *      `dir_path`, `path`, and (for list_files) natural aliases
 *      `directory` / `dir`.
 *   3. Command-running tools accept at minimum `command`.
 *   4. Semantic aliases converge to ONE canonical output field after
 *      transform — e.g. `filePath` whether you sent `file_path` or `path`.
 *
 * A new tool added without the standard alias set will fail these tests
 * and get the rows it's missing printed out for easy fixing.
 */

import { describe, it, expect } from 'vitest'
import {
  readFileInputZod,
  writeFileInputZod,
  editFileInputZod,
  listFilesInputZod,
  globInputZod,
  grepInputZod,
  bashInputZod,
  powerShellInputZod,
  lspToolInputZod,
} from './toolInputZod'

type Result<T = unknown> = { success: true; data: T } | { success: false; error: unknown }

function parse(schema: typeof readFileInputZod, input: unknown): Result {
  const r = (schema as { safeParse: (i: unknown) => { success: boolean; data?: unknown; error?: unknown } }).safeParse(input)
  if (r.success) return { success: true, data: r.data as unknown }
  return { success: false, error: r.error }
}

function assertAliasAccepts(
  schema: typeof readFileInputZod,
  label: string,
  variants: Array<{ input: Record<string, unknown>; expectFieldValue?: Record<string, unknown> }>,
): void {
  for (const v of variants) {
    const r = parse(schema, v.input)
    expect(r.success, `${label} should accept ${JSON.stringify(v.input)} — got error: ${JSON.stringify(r.success ? null : r.error)}`).toBe(true)
    if (r.success && v.expectFieldValue) {
      const data = r.data as Record<string, unknown>
      for (const [field, expected] of Object.entries(v.expectFieldValue)) {
        expect(data[field], `${label}: after transform, field ${field} should be ${JSON.stringify(expected)}`).toBe(expected)
      }
    }
  }
}

describe('Tool input alias consistency audit', () => {
  describe('file-path aliases converge on `filePath`', () => {
    it('read_file accepts filePath / file_path / path', () => {
      assertAliasAccepts(readFileInputZod, 'read_file', [
        { input: { filePath: '/a.ts' }, expectFieldValue: { filePath: '/a.ts' } },
        { input: { file_path: '/a.ts' }, expectFieldValue: { filePath: '/a.ts' } },
        { input: { path: '/a.ts' }, expectFieldValue: { filePath: '/a.ts' } },
      ])
    })

    it('write_file accepts filePath / file_path / path', () => {
      assertAliasAccepts(writeFileInputZod, 'write_file', [
        { input: { filePath: '/a.ts', content: '' }, expectFieldValue: { filePath: '/a.ts' } },
        { input: { file_path: '/a.ts', content: '' }, expectFieldValue: { filePath: '/a.ts' } },
        { input: { path: '/a.ts', content: '' }, expectFieldValue: { filePath: '/a.ts' } },
      ])
    })

    it('edit_file accepts filePath / file_path / path', () => {
      assertAliasAccepts(editFileInputZod, 'edit_file', [
        { input: { filePath: '/a.ts', oldString: 'a', newString: 'b' }, expectFieldValue: { filePath: '/a.ts' } },
        { input: { file_path: '/a.ts', oldString: 'a', newString: 'b' }, expectFieldValue: { filePath: '/a.ts' } },
        { input: { path: '/a.ts', oldString: 'a', newString: 'b' }, expectFieldValue: { filePath: '/a.ts' } },
      ])
    })

    it('lsp_diagnostics tool accepts filePath / file_path / path', () => {
      // lspToolInputZod also requires `operation`; pass a cheap read-only op.
      const baseOp = { operation: 'documentSymbol' }
      assertAliasAccepts(lspToolInputZod, 'lsp_diagnostics', [
        { input: { ...baseOp, filePath: '/a.ts' } },
        { input: { ...baseOp, file_path: '/a.ts' } },
        { input: { ...baseOp, path: '/a.ts' } },
      ])
    })
  })

  describe('dir-path aliases converge on `dirPath`', () => {
    it('list_files accepts dirPath / dir_path / path / directory / dir', () => {
      assertAliasAccepts(listFilesInputZod, 'list_files', [
        { input: { dirPath: '/a' }, expectFieldValue: { dirPath: '/a' } },
        { input: { dir_path: '/a' }, expectFieldValue: { dirPath: '/a' } },
        { input: { path: '/a' }, expectFieldValue: { dirPath: '/a' } },
        { input: { directory: '/a' }, expectFieldValue: { dirPath: '/a' } },
        { input: { dir: '/a' }, expectFieldValue: { dirPath: '/a' } },
      ])
    })
  })

  describe('search-path aliases: `cwd` vs `path` vs `directory`', () => {
    it('glob accepts cwd / path / directory → all converge on cwd', () => {
      assertAliasAccepts(globInputZod, 'glob', [
        { input: { pattern: '**/*.ts', cwd: '/ws' }, expectFieldValue: { cwd: '/ws' } },
        { input: { pattern: '**/*.ts', path: '/ws' }, expectFieldValue: { cwd: '/ws' } },
        { input: { pattern: '**/*.ts', directory: '/ws' }, expectFieldValue: { cwd: '/ws' } },
      ])
    })

    it('grep accepts cwd / path (single-file or dir) → converges on cwd', () => {
      assertAliasAccepts(grepInputZod, 'grep', [
        { input: { pattern: 'TODO', cwd: '/ws' }, expectFieldValue: { cwd: '/ws' } },
        { input: { pattern: 'TODO', path: '/ws' }, expectFieldValue: { cwd: '/ws' } },
      ])
    })
  })

  describe('pattern / query aliases on grep', () => {
    it('grep accepts pattern AND query (alias) and normalises on pattern', () => {
      assertAliasAccepts(grepInputZod, 'grep', [
        { input: { pattern: 'foo' }, expectFieldValue: { pattern: 'foo' } },
        { input: { query: 'foo' }, expectFieldValue: { pattern: 'foo' } },
      ])
    })
  })

  describe('replace-all aliases on edit_file', () => {
    it('edit_file accepts replaceAll AND replace_all and both normalise correctly', () => {
      const a = parse(editFileInputZod, {
        filePath: '/a.ts', oldString: 'a', newString: 'b', replaceAll: true,
      })
      const b = parse(editFileInputZod, {
        filePath: '/a.ts', oldString: 'a', newString: 'b', replace_all: true,
      })
      expect(a.success).toBe(true)
      expect(b.success).toBe(true)
      // Both shapes survive the schema (registry.ts then ORs them — we just
      // need to verify the schema lets both through).
    })
  })

  describe('shell tools: command is required, other params are optional', () => {
    it('bash rejects missing command, accepts shape with command + cwd + runInBackground + timeoutMs', () => {
      expect(parse(bashInputZod, {}).success).toBe(false)
      expect(parse(bashInputZod, { command: 'ls' }).success).toBe(true)
      expect(
        parse(bashInputZod, {
          command: 'ls',
          cwd: '/ws',
          runInBackground: true,
          timeoutMs: 5000,
        }).success,
      ).toBe(true)
    })

    it('PowerShell rejects missing command, accepts full shape', () => {
      expect(parse(powerShellInputZod, {}).success).toBe(false)
      expect(parse(powerShellInputZod, { command: 'Get-Date' }).success).toBe(true)
      expect(
        parse(powerShellInputZod, {
          command: 'Get-Date',
          cwd: '/ws',
          runInBackground: false,
          timeoutMs: 10000,
        }).success,
      ).toBe(true)
    })
  })

  describe('naming-convention consistency across tools', () => {
    // Cross-tool consistency matrix. This is the test that fires when a
    // NEW tool is added but forgets an alias that every sibling supports.
    it('every file-accepting tool accepts the full {filePath, file_path, path} set', () => {
      const schemas = [
        { name: 'read_file', zod: readFileInputZod, extra: {} as Record<string, unknown> },
        { name: 'write_file', zod: writeFileInputZod, extra: { content: '' } },
        { name: 'edit_file', zod: editFileInputZod, extra: { oldString: 'a', newString: 'b' } },
        {
          name: 'lsp_diagnostics',
          zod: lspToolInputZod,
          // lspTool needs `operation`; the alias test only checks path-alias
          // coverage, not operation coverage.
          extra: { operation: 'documentSymbol' } as Record<string, unknown>,
        },
      ]
      const aliases = ['filePath', 'file_path', 'path']
      for (const { name, zod, extra } of schemas) {
        for (const alias of aliases) {
          const r = parse(zod, { [alias]: '/tmp/x.ts', ...extra })
          expect(r.success, `${name} should accept \`${alias}\` alias`).toBe(true)
        }
      }
    })
  })
})
