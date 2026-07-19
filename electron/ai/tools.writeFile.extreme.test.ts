/**
 * Extreme / adversarial test cases for toolWriteFile — 20 cases.
 * Run: npx vitest run electron/ai/tools.writeFile.extreme.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toolWriteFile, toolEditFile, toolReadFile } from './tools'
import { setWorkspacePath } from '../tools/workspaceState'
import { clearAllReadFileState } from '../tools/readFileState'

describe('toolWriteFile extreme tests', () => {
  let tmp: string

  beforeEach(() => {
    clearAllReadFileState()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-write-extreme-'))
    setWorkspacePath(tmp)
  })

  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // ─── 1. Write file with CRLF content directly ──────────────────────────
  it('01 - writes CRLF content as-is', async () => {
    const f = path.join(tmp, 'crlf.txt')
    const r = await toolWriteFile(f, 'a\r\nb\r\n')
    expect(r.success).toBe(true)
    const raw = fs.readFileSync(f, 'utf-8')
    expect(raw).toBe('a\r\nb\r\n')
  })

  // ─── 2. Write file with mixed Unicode and ASCII ────────────────────────
  it('02 - writes mixed Unicode and ASCII content', async () => {
    const f = path.join(tmp, 'unicode.txt')
    const content = 'Hello 世界! Café résumé 🌟'
    const r = await toolWriteFile(f, content)
    expect(r.success).toBe(true)
    const disk = fs.readFileSync(f, 'utf-8')
    expect(disk).toBe(content)
  })

  // ─── 3. Rejects overwriting a tiny 49-byte file (no soft threshold any more) ──
  it('03 - rejects overwriting existing tiny file (use edit_file)', async () => {
    const f = path.join(tmp, 'tiny.txt')
    const first = await toolWriteFile(f, 'x'.repeat(49))
    expect(first.success).toBe(true)
    await toolReadFile(f)
    const second = await toolWriteFile(f, 'y'.repeat(49))
    expect(second.success).toBe(false)
    if (!second.success) {
      expect(second.error).toMatch(/use edit_file/i)
      expect(second.error).toMatch(/already exists/i)
    }
    // Original content preserved
    expect(fs.readFileSync(f, 'utf-8')).toBe('x'.repeat(49))
  })

  // ─── 4. Rejects overwriting a larger file (symmetric with #03) ──
  it('04 - rejects overwriting existing 51-byte file', async () => {
    const f = path.join(tmp, 'medium.txt')
    const first = await toolWriteFile(f, 'A'.repeat(51))
    expect(first.success).toBe(true)
    await toolReadFile(f)
    const second = await toolWriteFile(f, 'B'.repeat(51))
    expect(second.success).toBe(false)
    expect(second.error).toMatch(/use edit_file/i)
    // Original content preserved
    expect(fs.readFileSync(f, 'utf-8')).toBe('A'.repeat(51))
  })

  // ─── 5. Write empty string to a brand new file ─────────────────────────
  it('05 - creates empty file', async () => {
    const f = path.join(tmp, 'empty.txt')
    const r = await toolWriteFile(f, '')
    expect(r.success).toBe(true)
    expect(fs.existsSync(f)).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('')
  })

  // ─── 6. Write to a path that is an existing directory ──────────────────
  it('06 - rejects writing to a directory path', async () => {
    const dirPath = path.join(tmp, 'adirectory')
    fs.mkdirSync(dirPath)
    const r = await toolWriteFile(dirPath, 'content')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/directory/i)
  })

  // ─── 7. Write with special shell characters in content ─────────────────
  it("07 - writes shell-injection-like content as-is", async () => {
    const f = path.join(tmp, 'shell.txt')
    const content = "'; DROP TABLE users;--"
    const r = await toolWriteFile(f, content)
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe(content)
  })

  // ─── 8. Write to a path containing spaces ──────────────────────────────
  it('08 - writes to path with spaces, creating parent dirs', async () => {
    const f = path.join(tmp, 'my folder', 'file name.txt')
    const r = await toolWriteFile(f, 'data')
    expect(r.success).toBe(true)
    expect(fs.existsSync(f)).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('data')
  })

  // ─── 9. Write to a deeply nested path ──────────────────────────────────
  it('09 - writes to deeply nested path, creating all parent dirs', async () => {
    const f = path.join(tmp, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'deep.txt')
    const r = await toolWriteFile(f, 'deep content')
    expect(r.success).toBe(true)
    expect(fs.existsSync(f)).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe('deep content')
  })

  // ─── 10. Write file with explicit Unicode BOM ──────────────────────────
  it('10 - writes file with explicit UTF-8 BOM', async () => {
    const f = path.join(tmp, 'bommed.txt')
    const r = await toolWriteFile(f, '\uFEFFcontent')
    expect(r.success).toBe(true)
    const raw = fs.readFileSync(f, 'utf-8')
    expect(raw).toBe('\uFEFFcontent')
    expect(raw.length).toBeGreaterThan('content'.length)
  })

  // ─── 11. Write file with only a single newline ─────────────────────────
  it('11 - writes file containing only a newline character', async () => {
    const f = path.join(tmp, 'newline.txt')
    const r = await toolWriteFile(f, '\n')
    expect(r.success).toBe(true)
    const raw = fs.readFileSync(f, 'utf-8')
    expect(raw).toBe('\n')
    expect(Buffer.byteLength(raw, 'utf8')).toBe(1)
  })

  // ─── 12. Write a 100KB file ────────────────────────────────────────────
  it('12 - writes a 100KB file', async () => {
    const f = path.join(tmp, 'big.txt')
    const big = 'X'.repeat(102400)
    const r = await toolWriteFile(f, big)
    expect(r.success).toBe(true)
    const stat = fs.statSync(f)
    expect(stat.size).toBe(Buffer.byteLength(big, 'utf8'))
  })

  // ─── 13. Write file with embedded null bytes ───────────────────────────
  it('13 - writes file containing null bytes', async () => {
    const f = path.join(tmp, 'nulls.txt')
    const content = 'before\u0000after'
    const r = await toolWriteFile(f, content)
    expect(r.success).toBe(true)
    // Node.js writes null bytes as-is in UTF-8
    const disk = fs.readFileSync(f, 'utf-8')
    expect(disk).toContain('\u0000')
    expect(Buffer.byteLength(disk, 'utf8')).toBe(12)
  })

  // ─── 14. A second Write on the same path is rejected ──────────────────
  it('14 - rejects immediate second write — must use edit_file once file exists', async () => {
    const f = path.join(tmp, 'twice.txt')
    const first = await toolWriteFile(f, 'v1\n')
    expect(first.success).toBe(true)
    const second = await toolWriteFile(f, 'v2\n')
    expect(second.success).toBe(false)
    if (!second.success) {
      expect(second.error).toMatch(/edit_file/)
    }
    expect(fs.readFileSync(f, 'utf-8')).toBe('v1\n')
  })

  // ─── 15. Write file with backtick content ──────────────────────────────
  it('15 - writes backtick content as-is', async () => {
    const f = path.join(tmp, 'backticks.txt')
    const content = '`rm -rf /`'
    const r = await toolWriteFile(f, content)
    expect(r.success).toBe(true)
    expect(fs.readFileSync(f, 'utf-8')).toBe(content)
  })

  // ─── 16. Write file with Windows-style double-backslash paths ──────────
  it('16 - preserves double backslashes in content', async () => {
    const f = path.join(tmp, 'winpath.txt')
    const content = '"C:\\\\Users\\\\test\\\\file.txt"'
    const r = await toolWriteFile(f, content)
    expect(r.success).toBe(true)
    const disk = fs.readFileSync(f, 'utf-8')
    // Disk should have literal double backslashes
    expect(disk).toContain('\\\\')
  })

  // ─── 17. Edit rejected after external modification via mtime ──────────
  it('17 - detects external modification and rejects the follow-up mutation (via Edit, the only path that can re-mutate)', async () => {
    // Ported from Write to Edit: Write would now be rejected by the
    // preflight gate before reaching the mtime check, so this regression
    // is exercised through Edit. The self-mutation receipt seeded by the
    // first Write must be defeated by an external mtime bump on the disk.
    const f = path.join(tmp, 'conflict.txt')
    const first = await toolWriteFile(f, 'original\n')
    expect(first.success).toBe(true)
    // Simulate external process writing
    fs.writeFileSync(f, 'external\n', 'utf-8')
    const future = new Date(Date.now() + 5_000)
    fs.utimesSync(f, future, future)
    const second = await toolEditFile(f, 'external', 'attempted')
    expect(second.success).toBe(false)
    if (!second.success) {
      expect(second.error).toMatch(/modified on disk|mtime/i)
    }
    expect(fs.readFileSync(f, 'utf-8')).toBe('external\n')
  })

  // ─── 18. Write file with CR line endings only (old Mac style) ─────────
  it('18 - writes content with old Mac-style CR line endings', async () => {
    const f = path.join(tmp, 'mac.txt')
    const content = 'line1\rline2\r'
    const r = await toolWriteFile(f, content)
    expect(r.success).toBe(true)
    const raw = fs.readFileSync(f, 'utf-8')
    expect(raw).toBe(content)
    expect(raw).toContain('\r')
  })

  // ─── 19. Write file with tab characters ────────────────────────────────
  it('19 - preserves tab characters in content', async () => {
    const f = path.join(tmp, 'tabs.txt')
    const content = 'col1\tcol2\tcol3'
    const r = await toolWriteFile(f, content)
    expect(r.success).toBe(true)
    const disk = fs.readFileSync(f, 'utf-8')
    expect(disk).toBe(content)
    expect(disk).toContain('\t')
  })

  // ─── 20. Write to existing but empty file is rejected ─────────────────
  it('20 - rejects writing into an existing empty file (must use edit_file with empty oldString)', async () => {
    // Documents the firmest edge case of the strengthened contract: even
    // a zero-byte file on disk is a pre-existing path and forces Edit.
    const f = path.join(tmp, 'empty-exist.txt')
    fs.writeFileSync(f, '', 'utf-8')
    await toolReadFile(f)
    const r = await toolWriteFile(f, 'new content')
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toMatch(/edit_file/)
      expect(r.error).toMatch(/already exists/)
    }
    expect(fs.readFileSync(f, 'utf-8')).toBe('')
  })
})
