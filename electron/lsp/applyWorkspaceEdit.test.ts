/**
 * applyWorkspaceEdit correctness — end-to-end against a real temp workspace.
 *
 * These tests drive the atomic path (via real fs + the workspaceState
 * resolver) rather than the `__internal` helpers alone because the
 * coordinate math, overlap detection, multi-file flush, and safety gate
 * must all stay aligned. Subsections:
 *
 *   - applyTextEditsToContent: pure helper, covers position math + overlaps
 *   - applyWorkspaceEdit:      full path, checks refuses to write outside ws
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyWorkspaceEdit, __internal } from './applyWorkspaceEdit'
import { setWorkspacePath } from '../tools/workspaceState'

describe('applyTextEditsToContent', () => {
  const { applyTextEditsToContent } = __internal

  it('applies a single insertion correctly', () => {
    // Insertion at column 11 = just after the '1' (LSP column is a gap index).
    const res = applyTextEditsToContent('const x = 1\n', [
      {
        range: { start: { line: 0, character: 11 }, end: { line: 0, character: 11 } },
        newText: '2',
      },
    ])
    expect(res.ok).toBe(true)
    expect(res.content).toBe('const x = 12\n')
  })

  it('applies multiple non-overlapping edits in the correct order', () => {
    const res = applyTextEditsToContent('ab\ncd\nef\n', [
      {
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
        newText: 'B',
      },
      {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } },
        newText: 'EF',
      },
    ])
    expect(res.ok).toBe(true)
    expect(res.content).toBe('aB\ncd\nEF\n')
  })

  it('rejects overlapping edits', () => {
    const res = applyTextEditsToContent('hello world', [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        newText: 'HELLO',
      },
      {
        range: { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } },
        newText: 'X',
      },
    ])
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('Overlapping')
  })

  it('clamps columns past the end of line', () => {
    const res = applyTextEditsToContent('a\n', [
      {
        range: { start: { line: 0, character: 99 }, end: { line: 0, character: 99 } },
        newText: 'b',
      },
    ])
    expect(res.ok).toBe(true)
    expect(res.content).toBe('ab\n')
  })

  it('handles multi-line replace', () => {
    const res = applyTextEditsToContent('line1\nline2\nline3\n', [
      {
        range: { start: { line: 0, character: 5 }, end: { line: 2, character: 0 } },
        newText: '_',
      },
    ])
    expect(res.ok).toBe(true)
    expect(res.content).toBe('line1_line3\n')
  })
})

describe('collectPerFileEdits', () => {
  const { collectPerFileEdits } = __internal

  it('flattens the `changes` shape', () => {
    const edit = {
      changes: {
        'file:///a': [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'a' },
        ],
        'file:///b': [],
      },
    }
    const { perUri, fileOps, skipped } = collectPerFileEdits(edit)
    expect(perUri.size).toBe(1)
    expect(perUri.get('file:///a')?.length).toBe(1)
    expect(fileOps).toHaveLength(0)
    expect(skipped).toHaveLength(0)
  })

  it('separates text edits from known file ops', () => {
    const edit = {
      documentChanges: [
        {
          textDocument: { uri: 'file:///a.ts', version: 1 },
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: 'x',
            },
          ],
        },
        { kind: 'rename', oldUri: 'file:///old.ts', newUri: 'file:///new.ts' },
        { kind: 'delete', uri: 'file:///tmp.ts' },
        { kind: 'create', uri: 'file:///fresh.ts' },
      ],
    }
    const { perUri, fileOps, skipped } = collectPerFileEdits(edit as never)
    expect(perUri.size).toBe(1)
    expect(fileOps).toHaveLength(3)
    expect(fileOps.map((o) => o.kind).sort()).toEqual(['create', 'delete', 'rename'])
    expect(skipped).toHaveLength(0)
  })

  it('reports unknown operation kinds as skipped', () => {
    const edit = {
      documentChanges: [
        { kind: 'moonwalk', uri: 'file:///whatever' },
      ],
    }
    const { skipped } = collectPerFileEdits(edit as never)
    expect(skipped).toHaveLength(1)
    expect(skipped[0].kind).toBe('moonwalk')
  })
})

describe('applyWorkspaceEdit', () => {
  let tmp: string
  const files: string[] = []

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-applyws-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    files.length = 0
  })

  function makeFile(rel: string, content: string): string {
    const abs = path.join(tmp, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
    files.push(abs)
    return abs
  }

  it('applies a single-file edit and touches only that file', async () => {
    const abs = makeFile('src/a.ts', 'const foo = 1\n')
    const res = await applyWorkspaceEdit({
      changes: {
        [pathToFileURL(abs).href]: [
          {
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
            newText: 'bar',
          },
        ],
      },
    })
    expect(res.applied).toBe(true)
    expect(res.filesChanged).toHaveLength(1)
    expect(res.filesChanged[0]).toBe(path.resolve(abs))
    expect(fs.readFileSync(abs, 'utf8')).toBe('const bar = 1\n')
    expect(res.failedPaths).toEqual([])
  })

  it('refuses to write outside the workspace', async () => {
    const outside = path.join(os.tmpdir(), `astra-outside-${Date.now()}.ts`)
    fs.writeFileSync(outside, 'x\n', 'utf8')
    files.push(outside)
    const res = await applyWorkspaceEdit({
      changes: {
        [pathToFileURL(outside).href]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            newText: 'Y',
          },
        ],
      },
    })
    expect(res.applied).toBe(false)
    expect(res.failedPaths).toHaveLength(1)
    expect(res.failedPaths[0].reason).toContain('outside')
    expect(fs.readFileSync(outside, 'utf8')).toBe('x\n')
  })

  it('reports overlap rejection per file without aborting the batch', async () => {
    const a = makeFile('src/a.ts', 'abcd\n')
    const b = makeFile('src/b.ts', 'hello\n')
    const res = await applyWorkspaceEdit({
      changes: {
        [pathToFileURL(a).href]: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: 'AB' },
          { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, newText: 'X' },
        ],
        [pathToFileURL(b).href]: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            newText: 'HELLO',
          },
        ],
      },
    })
    expect(res.applied).toBe(true)
    expect(res.failedPaths).toHaveLength(1)
    expect(res.filesChanged).toHaveLength(1)
    expect(fs.readFileSync(a, 'utf8')).toBe('abcd\n') // unchanged
    expect(fs.readFileSync(b, 'utf8')).toBe('HELLO\n')
  })

  it('rejects rename/create/delete operations outside the workspace', async () => {
    const abs = makeFile('src/a.ts', 'x\n')
    const res = await applyWorkspaceEdit({
      documentChanges: [
        {
          textDocument: { uri: pathToFileURL(abs).href, version: 1 },
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              newText: 'y',
            },
          ],
        },
        { kind: 'rename', oldUri: 'file:///old', newUri: 'file:///new' },
      ],
    } as never)
    expect(res.applied).toBe(true)
    // outside-workspace → skipped with explicit reason
    expect(res.skippedFileOps.length).toBe(1)
    expect(res.skippedFileOps[0].kind).toBe('rename')
    expect(res.skippedFileOps[0].reason).toMatch(/outside/i)
    expect(fs.readFileSync(abs, 'utf8')).toBe('y\n')
  })

  it('executes a create→edit sequence (Move to new file pattern)', async () => {
    // LSP "Move symbol to new file" emits: create newFile → edit newFile.
    const newAbs = path.join(tmp, 'src/new.ts')
    files.push(newAbs)
    const newUri = pathToFileURL(newAbs).href
    const res = await applyWorkspaceEdit({
      documentChanges: [
        { kind: 'create', uri: newUri },
        {
          textDocument: { uri: newUri, version: 1 },
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: 'export const moved = 1\n',
            },
          ],
        },
      ],
    } as never)
    expect(res.applied).toBe(true)
    expect(res.filesCreated).toHaveLength(1)
    expect(res.filesCreated[0]).toBe(path.resolve(newAbs))
    expect(fs.existsSync(newAbs)).toBe(true)
    expect(fs.readFileSync(newAbs, 'utf8')).toBe('export const moved = 1\n')
  })

  it('renames a file within the workspace', async () => {
    const oldAbs = makeFile('src/old.ts', 'hello\n')
    const newAbs = path.join(tmp, 'src/renamed.ts')
    files.push(newAbs)
    const res = await applyWorkspaceEdit({
      documentChanges: [
        {
          kind: 'rename',
          oldUri: pathToFileURL(oldAbs).href,
          newUri: pathToFileURL(newAbs).href,
        },
      ],
    } as never)
    expect(res.applied).toBe(true)
    expect(res.filesRenamed).toHaveLength(1)
    expect(res.filesRenamed[0].from).toBe(path.resolve(oldAbs))
    expect(res.filesRenamed[0].to).toBe(path.resolve(newAbs))
    expect(fs.existsSync(oldAbs)).toBe(false)
    expect(fs.readFileSync(newAbs, 'utf8')).toBe('hello\n')
  })

  it('deletes a file within the workspace', async () => {
    const abs = makeFile('src/gone.ts', 'goodbye\n')
    const res = await applyWorkspaceEdit({
      documentChanges: [
        { kind: 'delete', uri: pathToFileURL(abs).href },
      ],
    } as never)
    expect(res.applied).toBe(true)
    expect(res.filesDeleted).toHaveLength(1)
    expect(res.filesDeleted[0]).toBe(path.resolve(abs))
    expect(fs.existsSync(abs)).toBe(false)
  })

  it('refuses to overwrite on create when overwrite=false', async () => {
    const abs = makeFile('src/exists.ts', 'keep\n')
    const res = await applyWorkspaceEdit({
      documentChanges: [{ kind: 'create', uri: pathToFileURL(abs).href }],
    } as never)
    expect(res.applied).toBe(false)
    expect(res.skippedFileOps).toHaveLength(1)
    expect(res.skippedFileOps[0].reason).toMatch(/exists/i)
    expect(fs.readFileSync(abs, 'utf8')).toBe('keep\n')
  })

  it('supports ignoreIfExists on create', async () => {
    const abs = makeFile('src/noop.ts', 'keep\n')
    const res = await applyWorkspaceEdit({
      documentChanges: [
        {
          kind: 'create',
          uri: pathToFileURL(abs).href,
          options: { ignoreIfExists: true },
        },
      ],
    } as never)
    expect(res.applied).toBe(false)
    expect(res.skippedFileOps).toHaveLength(0)
    expect(fs.readFileSync(abs, 'utf8')).toBe('keep\n')
  })

  it('is a no-op on empty input', async () => {
    const res = await applyWorkspaceEdit({ changes: {} })
    expect(res.applied).toBe(false)
    expect(res.filesChanged).toEqual([])
    expect(res.failedPaths).toEqual([])
  })
})
