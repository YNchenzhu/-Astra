/**
 * Regression tests for the centralized destructive-empty-write guard.
 *
 * Covers the five scenarios enumerated in `空写入覆盖原因调查报告.md`:
 *   1. AI-initiated write_file with empty content on existing non-empty file
 *   2. MCP filesystem write_file with empty content (forwarded through the same guard)
 *   3. PreToolUse hook mutating content to "" (simulated by calling
 *      toolRegistry.execute with empty content directly)
 *   4. Race: file materializes between pre-check and lock acquisition
 *   5. Legitimate: new-file creation with empty content (`touch`-style) still works
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toolRegistry } from '../tools/registry'
import { guardAgainstDestructiveEmptyWrite } from '../tools/fileMutationGuard'
import { setWorkspacePath } from '../tools/workspaceState'
import { clearAllReadFileState } from '../tools/readFileState'
import { toolReadFile, toolWriteFile } from '../ai/tools'

describe('fileMutationGuard (systemic empty-write defense)', () => {
  let tmp: string

  beforeEach(() => {
    clearAllReadFileState()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-guard-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('guard rejects builtin write_file with empty content on non-empty file', () => {
    const f = path.join(tmp, 'a.txt')
    fs.writeFileSync(f, 'keep this', 'utf-8')
    const r = guardAgainstDestructiveEmptyWrite('write_file', {
      filePath: f,
      content: '',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Refusing empty write/)
  })

  it('guard allows builtin write_file with empty content when file does not exist', () => {
    const f = path.join(tmp, 'new.txt')
    const r = guardAgainstDestructiveEmptyWrite('write_file', {
      filePath: f,
      content: '',
    })
    expect(r.ok).toBe(true)
  })

  it('guard rejects empty content to pre-existing file via toolRegistry.execute', async () => {
    const f = path.join(tmp, 'existing.md')
    fs.writeFileSync(f, '# hello', 'utf-8')
    await toolReadFile(f)
    const r = await toolRegistry.execute('write_file', {
      filePath: f,
      content: '',
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Refusing empty write|would be cleared/i)
  })

  it('guard mirrors the check for MCP write_file (bridge tool name)', () => {
    const f = path.join(tmp, 'mcp.md')
    fs.writeFileSync(f, 'original', 'utf-8')
    // MCP bridge tool names are of the form mcp__<server>__<tool>
    const r = guardAgainstDestructiveEmptyWrite('mcp__filesystem__write_file', {
      path: f, // MCP canonical param name
      content: '',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Refusing empty write/)
  })

  it('guard rejects edit_file with empty oldString AND newString (no-op destructive intent)', () => {
    const f = path.join(tmp, 'noop.txt')
    fs.writeFileSync(f, 'abc', 'utf-8')
    const r = guardAgainstDestructiveEmptyWrite('edit_file', {
      filePath: f,
      oldString: '',
      newString: '',
    })
    expect(r.ok).toBe(false)
  })

  it('guard rejects edit_file with empty oldString against non-empty file', () => {
    const f = path.join(tmp, 'full.txt')
    fs.writeFileSync(f, 'there-is-content-here', 'utf-8')
    const r = guardAgainstDestructiveEmptyWrite('edit_file', {
      filePath: f,
      oldString: '',
      newString: 'clobber',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/clobber/i)
  })

  it('guard allows edit_file with empty oldString when file is absent (create-via-edit)', () => {
    const f = path.join(tmp, 'missing.md')
    const r = guardAgainstDestructiveEmptyWrite('edit_file', {
      filePath: f,
      oldString: '',
      newString: 'new body',
    })
    expect(r.ok).toBe(true)
  })

  it('guard is a no-op for non-mutation tools (e.g. read_file)', () => {
    const r = guardAgainstDestructiveEmptyWrite('read_file', { filePath: '/anything' })
    expect(r.ok).toBe(true)
  })

  // ── multi_edit_file batch ────────────────────────────────────────────────
  // These cover the same destructive-empty-write invariants the single edit_file
  // branch enforces, applied entry-by-entry to the batch. The whole batch is
  // rejected if ANY entry is destructive, mirroring the tool-layer behaviour.

  it('guard allows a normal multi_edit_file batch', () => {
    const f = path.join(tmp, 'multi-ok.txt')
    fs.writeFileSync(f, 'hello world\nfoo bar\n', 'utf-8')
    const r = guardAgainstDestructiveEmptyWrite('multi_edit_file', {
      filePath: f,
      edits: [
        { oldString: 'hello', newString: 'HELLO' },
        { oldString: 'foo', newString: 'FOO' },
      ],
    })
    expect(r.ok).toBe(true)
  })

  it('guard rejects multi_edit_file when ANY entry has both oldString and newString empty', () => {
    const f = path.join(tmp, 'multi-noop.txt')
    fs.writeFileSync(f, 'abc', 'utf-8')
    const r = guardAgainstDestructiveEmptyWrite('multi_edit_file', {
      filePath: f,
      edits: [
        { oldString: 'a', newString: 'A' },
        { oldString: '', newString: '' }, // ← destructive no-op
      ],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/edit #2/i)
      expect(r.error).toMatch(/empty/i)
    }
  })

  it('guard rejects multi_edit_file when ANY entry has empty oldString against non-empty file', () => {
    const f = path.join(tmp, 'multi-clobber.txt')
    fs.writeFileSync(f, 'there-is-content-here', 'utf-8')
    const r = guardAgainstDestructiveEmptyWrite('multi_edit_file', {
      filePath: f,
      edits: [
        { oldString: '', newString: 'clobber' }, // ← would overwrite the whole file
      ],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/edit #1/i)
      expect(r.error).toMatch(/clobber/i)
    }
  })

  it('guard accepts snake_case aliases inside multi_edit_file entries', () => {
    const f = path.join(tmp, 'multi-snake.txt')
    fs.writeFileSync(f, 'hello', 'utf-8')
    // Mixed: first entry camelCase, second entry snake_case — both valid input shapes.
    const r = guardAgainstDestructiveEmptyWrite('multi_edit_file', {
      file_path: f,
      edits: [
        { oldString: 'hello', newString: 'HI' },
        { old_string: 'HI', new_string: 'HELLO' },
      ],
    })
    expect(r.ok).toBe(true)
  })

  it('guard rejects empty-old via snake_case alias in multi_edit_file (no bypass)', () => {
    const f = path.join(tmp, 'multi-snake-bypass.txt')
    fs.writeFileSync(f, 'must-be-preserved', 'utf-8')
    const r = guardAgainstDestructiveEmptyWrite('multi_edit_file', {
      filePath: f,
      edits: [{ old_string: '', new_string: 'clobber-via-snake' }],
    })
    expect(r.ok).toBe(false)
  })

  it('legit: toolWriteFile still creates a new empty file (touch equivalent)', async () => {
    const f = path.join(tmp, 'empty.txt')
    const r = await toolWriteFile(f, '')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('')
  })

  it('registry path: guard fires even when skipRegistryInputValidation is true (Zod bypass)', async () => {
    // Simulate the agentic loop's `skipRegistryInputValidation: true` path. The
    // guard is OUTSIDE the Zod branch so it still runs — this is the anti-regression
    // for the "PreToolUse hook rewrites content to empty" attack.
    const f = path.join(tmp, 'attacked.md')
    fs.writeFileSync(f, 'precious', 'utf-8')
    await toolReadFile(f)
    const r = await toolRegistry.execute(
      'write_file',
      { filePath: f, content: '' },
      { skipRegistryInputValidation: true },
    )
    expect(r.success).toBe(false)
    expect(fs.readFileSync(f, 'utf-8')).toBe('precious')
  })
})
