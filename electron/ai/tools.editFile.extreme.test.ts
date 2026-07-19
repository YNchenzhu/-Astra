import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { toolEditFile, toolReadFile } from './tools'
import { setWorkspacePath } from '../tools/workspaceState'
import { clearAllReadFileState } from '../tools/readFileState'

describe('toolEditFile extreme/adversarial', () => {
  let tmp: string

  beforeEach(() => {
    clearAllReadFileState()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-edit-extreme-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // ──── Case 1: Unicode emoji old_string + new_string ────
  it('E1: handles Unicode emoji old/new strings correctly', async () => {
    const f = path.join(tmp, 'emoji.txt')
    fs.writeFileSync(f, 'Hello 🌍 World', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, '🌍', '🚀')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('Hello 🚀 World')
  })

  // ──── Case 2: CR+CRLF mixed line endings ────
  it('E2: preserves mixed CR/CRLF/LF line endings in CRLF file', async () => {
    const f = path.join(tmp, 'mixed.txt')
    fs.writeFileSync(f, 'line1\r\nline2\rline3\n', 'utf-8')
    await toolReadFile(f)
    // Edit an LF-style old_string against a CRLF file — should normalize
    const r = await toolEditFile(f, 'line1', 'LINE1')
    expect(r.success).toBe(true)
    // The original \r\n should be preserved for unchanged lines
    const content = fs.readFileSync(f, 'utf-8')
    expect(content).toContain('LINE1')
    expect(content).toContain('line2')
    expect(content).toContain('line3')
  })

  // ──── Case 3: Zero-width characters in old_string ────
  it('E3: matches and replaces zero-width characters', async () => {
    const f = path.join(tmp, 'zwsp.txt')
    fs.writeFileSync(f, 'test\u200Bdata', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, '\u200B', '-')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('test-data')
  })

  // ──── Case 4: Extremely long old_string ────
  it('E4: handles old_string near file size (4000 chars)', async () => {
    const f = path.join(tmp, 'big.txt')
    const xs = 'X'.repeat(5000) + '\n'
    fs.writeFileSync(f, xs, 'utf-8')
    await toolReadFile(f)
    const oldStr = 'X'.repeat(4000)
    const r = await toolEditFile(f, oldStr, 'Y')
    expect(r.success).toBe(true)
    const out = fs.readFileSync(f, 'utf-8')
    expect(out.startsWith('Y')).toBe(true)
    expect(out).toContain('X'.repeat(1000))
    expect(out.length).toBe(1 + 1000 + 1) // 'Y' + 1000 X's + '\n'
  })

  // ──── Case 5: replaceAll on repeated pattern ────
  it('E5: replaceAll replaces every occurrence', async () => {
    const f = path.join(tmp, 'replaceall.txt')
    fs.writeFileSync(f, 'foo foo foo', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, 'foo', 'bar', { replaceAll: true })
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('bar bar bar')
  })

  // ──── Case 6: Consecutive edits without re-read ────
  it('E6: allows consecutive edits after self-mutation (receipt refresh)', async () => {
    const f = path.join(tmp, 'chain.txt')
    fs.writeFileSync(f, 'v1', 'utf-8')
    await toolReadFile(f)
    const e1 = await toolEditFile(f, 'v1', 'v2')
    expect(e1.success).toBe(true)
    // No read_file between edits — self-mutation should refresh receipt
    const e2 = await toolEditFile(f, 'v2', 'v3')
    expect(e2.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('v3')
  })

  // ──── Case 7: Edit creates a new file ────
  it('E7: creates file via edit with empty old_string', async () => {
    const f = path.join(tmp, 'created.txt')
    const r = await toolEditFile(f, '', 'created\n')
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/Created/i)
    expect(fs.readFileSync(f, 'utf-8')).toBe('created\n')
  })

  // ──── Case 8: Whitespace-only old_string on whitespace-only file ────
  it('E8: replaces whitespace-only old_string in whitespace-only file', async () => {
    const f = path.join(tmp, 'ws.txt')
    fs.writeFileSync(f, '   \n\t\n  ', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, '\n\t\n', '\nX\n')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('   \nX\n  ')
  })

  // ──── Case 9: Special regex characters in old_string ────
  it('E9: special regex chars in old_string are literal, not regex', async () => {
    const f = path.join(tmp, 'regexchars.txt')
    fs.writeFileSync(f, 'price: $100 + tax = $110', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, '$100 + tax = $110', '$120 total')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('price: $120 total')
  })

  // ──── Case 10: JSON content with brackets ────
  it('E10: edits JSON content with brackets', async () => {
    const f = path.join(tmp, 'data.json')
    fs.writeFileSync(f, '{"key": "value"}', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, '"key": "value"', '"key": "updated"')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('{"key": "updated"}')
  })

  // ──── Case 11: Trailing whitespace in old_string ────
  it('E11: matches trailing whitespace exactly in old_string', async () => {
    const f = path.join(tmp, 'trailws.txt')
    fs.writeFileSync(f, 'hello   ', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, 'hello   ', 'hi')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('hi')
  })

  // ──── Case 12: File with only UTF-8 BOM ────
  it('E12: empty old_string on BOM-only file replaces content', async () => {
    const f = path.join(tmp, 'bomonly.txt')
    fs.writeFileSync(f, '\uFEFF', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, '', 'real content')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('real content')
  })

  // ──── Case 13: Deep indent preservation ────
  it('E13: preserves deep indent with mixed spaces and tabs', async () => {
    const f = path.join(tmp, 'indent.txt')
    fs.writeFileSync(f, '    \t\tindented', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, 'indented', 'fixed')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('    \t\tfixed')
  })

  // ──── Case 14: Sequential edits on same file with re-reads ────
  it('E14: sequential single-char edits with re-reads', async () => {
    const f = path.join(tmp, 'seq.txt')
    fs.writeFileSync(f, 'ABC', 'utf-8')
    await toolReadFile(f)
    const e1 = await toolEditFile(f, 'A', 'AX')
    expect(e1.success).toBe(true)
    // Re-read after first edit
    await toolReadFile(f)
    const e2 = await toolEditFile(f, 'X', 'Y')
    expect(e2.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('AYBC')
  })

  // ──── Case 15: old_string with/without trailing newline ────
  it('E15: tolerant of missing trailing newline in old_string', async () => {
    const f = path.join(tmp, 'newlines.txt')
    fs.writeFileSync(f, 'line1\nline2\n', 'utf-8')
    await toolReadFile(f)
    // old_string without trailing \n should still match
    const r = await toolEditFile(f, 'line2', 'LINE3')
    expect(r.success).toBe(true)
    const out = fs.readFileSync(f, 'utf-8')
    expect(out).toContain('LINE3')
    expect(out).toContain('line1')
  })

  // ──── Case 16: HTML/XML entity content ────
  it('E16: edits HTML entity content', async () => {
    const f = path.join(tmp, 'entities.txt')
    fs.writeFileSync(f, '&lt;div&gt;test&lt;/div&gt;', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, '&lt;div&gt;', '&lt;section&gt;')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('&lt;section&gt;test&lt;/div&gt;')
  })

  // ──── Case 17: Tab characters as significant content ────
  it('E17: preserves tab-delimited values during edit', async () => {
    const f = path.join(tmp, 'tabs.txt')
    fs.writeFileSync(f, 'col1\tcol2\tcol3', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, '\tcol2\t', '\tNEW\t')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('col1\tNEW\tcol3')
  })

  // ──── Case 18: File content that looks like a file path ────
  it('E18: handles Windows-style file paths with backslashes', async () => {
    const f = path.join(tmp, 'paths.txt')
    fs.writeFileSync(f, 'C:\\path\\to\\file.txt', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, 'C:\\path\\to\\file.txt', 'D:\\other\\file.txt')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('D:\\other\\file.txt')
  })

  // ──── Case 19: Immediately consecutive single-char edits without re-read ────
  it('E19: consecutive single-char edits without intervening read', async () => {
    const f = path.join(tmp, 'singlechar.txt')
    fs.writeFileSync(f, 'abcdef', 'utf-8')
    await toolReadFile(f)
    const e1 = await toolEditFile(f, 'a', 'A')
    expect(e1.success).toBe(true)
    // Self-mutation should refresh receipt, so this should still work
    const e2 = await toolEditFile(f, 'b', 'B')
    expect(e2.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('ABcdef')
  })

  // ──── Case 20: Delete last line (empty new_string with line+newline old_string) ────
  it('E20: deletes last line by matching line+newline', async () => {
    const f = path.join(tmp, 'deleteLast.txt')
    fs.writeFileSync(f, 'line1\nline2\nline3\n', 'utf-8')
    await toolReadFile(f)
    const r = await toolEditFile(f, 'line3\n', '')
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('line1\nline2\n')
  })
})
