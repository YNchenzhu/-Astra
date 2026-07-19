/**
 * E2E regressions for the two "consecutive model failure" fixes from the
 * 昆明市晋宁区 trace analysis:
 *
 *   1. Path self-healing — filePath has a near-miss typo (classic long-CJK
 *      char drop: "中等专业学校" typed as "等专业学校") but baseReadId resolves
 *      to a receipt whose file exists → the edit redirects to the receipt
 *      path instead of bouncing a "Did you mean" back for another turn.
 *
 *   2. Literal `\uXXXX` auto-decode through the FULL tool path, including
 *      the hash-anchored read-before-edit gate (`OLD_STRING_NOT_IN_READ`
 *      must not fire first when the decoded form is in the snapshot).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toolEditFile, toolReadFile } from './tools'
import { setWorkspacePath } from '../tools/workspaceState'
import { clearAllReadFileState } from '../tools/readFileState'

function extractReadId(output: string): string {
  const match = output.match(/\[readId: ([a-zA-Z][\w-]+)\]/)
  if (!match) throw new Error(`Could not find readId in output:\n${output}`)
  return match[1]!
}

describe('edit_file — baseReadId path-typo recovery', () => {
  let dir: string
  beforeEach(() => {
    clearAllReadFileState()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-typo-'))
    setWorkspacePath(dir)
  })
  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('redirects a dropped-CJK-char filename to the receipt path and applies the edit', async () => {
    const realPath = path.join(dir, '昆明市晋宁区中等专业学校-解决方案.txt')
    fs.writeFileSync(realPath, '第一章 项目概述\n第二章 建设内容\n', 'utf-8')
    const read = await toolReadFile(realPath)
    expect(read.success).toBe(true)
    const readId = extractReadId(read.output ?? '')

    // Same char-drop shape as the real trace: "中等" → "等".
    const typoPath = path.join(dir, '昆明市晋宁区等专业学校-解决方案.txt')
    const r = await toolEditFile(typoPath, '第一章 项目概述', '第一章 项目总述', {
      baseReadId: readId,
    })
    expect(r.success).toBe(true)
    expect(r.output).toContain('recovered from baseReadId')
    expect(fs.readFileSync(realPath, 'utf-8')).toContain('第一章 项目总述')
    // Nothing created at the typo path.
    expect(fs.existsSync(typoPath)).toBe(false)
  })

  it('does NOT redirect when the basenames differ by more than 2 edits', async () => {
    const realPath = path.join(dir, 'report-final.txt')
    fs.writeFileSync(realPath, 'hello world\n', 'utf-8')
    const read = await toolReadFile(realPath)
    const readId = extractReadId(read.output ?? '')

    const r = await toolEditFile(path.join(dir, 'summary.txt'), 'hello world', 'hi world', {
      baseReadId: readId,
    })
    expect(r.success).toBe(false)
    expect(fs.readFileSync(realPath, 'utf-8')).toContain('hello world')
  })

  it('does NOT redirect a create-via-edit (empty old_string) — the typo path is created as asked', async () => {
    const realPath = path.join(dir, 'notes-v1.txt')
    fs.writeFileSync(realPath, 'existing\n', 'utf-8')
    const read = await toolReadFile(realPath)
    const readId = extractReadId(read.output ?? '')

    const newPath = path.join(dir, 'notes-v2.txt')
    const r = await toolEditFile(newPath, '', 'brand new file\n', { baseReadId: readId })
    // Whatever the gate decides about baseReadId on a create, the edit must
    // NOT be silently rerouted onto notes-v1.txt.
    expect(fs.readFileSync(realPath, 'utf-8')).toBe('existing\n')
    if (r.success) {
      expect(fs.readFileSync(newPath, 'utf-8')).toBe('brand new file\n')
    }
  })

  it('without baseReadId the fuzzy "Did you mean" error is unchanged', async () => {
    const realPath = path.join(dir, 'plan-2026.txt')
    fs.writeFileSync(realPath, 'alpha\n', 'utf-8')
    await toolReadFile(realPath)

    const r = await toolEditFile(path.join(dir, 'plan-206.txt'), 'alpha', 'beta', {})
    expect(r.success).toBe(false)
    expect(String(r.error)).toMatch(/not found/i)
    expect(fs.readFileSync(realPath, 'utf-8')).toBe('alpha\n')
  })
})

describe('edit_file — literal \\uXXXX auto-decode end-to-end (with hash-anchored gate)', () => {
  let dir: string
  beforeEach(() => {
    clearAllReadFileState()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-escape-'))
    setWorkspacePath(dir)
  })
  afterEach(() => {
    setWorkspacePath(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('applies an edit whose old_string arrived as literal escape text, via baseReadId', async () => {
    const fp = path.join(dir, 'doc.txt')
    fs.writeFileSync(fp, '他说：\u201c你好\u201d。\n', 'utf-8')
    const read = await toolReadFile(fp)
    const readId = extractReadId(read.output ?? '')

    // Model sent the 6-char escape text instead of the glyph (double-escaped
    // JSON). The gate must not reject with OLD_STRING_NOT_IN_READ, and the
    // edit must decode both sides.
    const r = await toolEditFile(fp, '\\u201d\u3002', '\\u201d\uff01', { baseReadId: readId })
    expect(r.success).toBe(true)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('他说：\u201c你好\u201d\uff01\n')
  })
})
