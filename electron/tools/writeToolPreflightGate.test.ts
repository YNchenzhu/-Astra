/**
 * Unit tests for the centralised Write preflight gate.
 *
 * Contract: write_file is ONLY for creating NEW files. ANY existing regular
 * file at the resolved path — including a zero-byte empty file — is rejected
 * with the canonical "use edit_file" wording.
 *
 * Covers:
 *   - permissive cases: empty / non-string / unresolved / missing file / directory target
 *   - reject cases: existing file of any size returns the canonical
 *     "use edit_file" error wording and the right metadata (0 bytes, 1 byte,
 *     small files that used to pass, and large files)
 *   - {@link preflightWriteToolWithDisk}: same verdict + same wording when
 *     the caller already has the disk contents in hand
 *
 * The streaming-tool-executor integration of this gate is exercised
 * separately by streamingToolExecutor.writePreflight.test.ts.
 */
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { setWorkspacePath } from './workspaceState'
import {
  preflightWriteTool,
  preflightWriteToolWithDisk,
} from './writeToolPreflightGate'

let workspaceDir: string

beforeAll(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-wpg-'))
})

afterAll(() => {
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

beforeEach(() => {
  setWorkspacePath(workspaceDir)
})

afterEach(() => {
  setWorkspacePath(null)
})

describe('preflightWriteTool', () => {
  it('allows empty / non-string filePath (tool itself surfaces the better error)', () => {
    const empty = preflightWriteTool({ filePath: '' })
    expect(empty.ok).toBe(true)

    const whitespace = preflightWriteTool({ filePath: '   ' })
    expect(whitespace.ok).toBe(true)

    const nonString = preflightWriteTool({ filePath: 42 as unknown as string })
    expect(nonString.ok).toBe(true)

    const undef = preflightWriteTool({ filePath: undefined })
    expect(undef.ok).toBe(true)
  })

  it('allows when workspace resolution fails (no workspace open)', () => {
    setWorkspacePath(null)
    const result = preflightWriteTool({ filePath: 'src/new.ts' })
    expect(result.ok).toBe(true)
  })

  it('allows when target file does not exist (new-file create — the only legitimate Write target)', () => {
    const result = preflightWriteTool({ filePath: 'src/brand-new.ts' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.existingFileSize).toBeNull()
    }
  })

  it('allows when resolved target is a directory (tool itself rejects with clearer message)', () => {
    fs.mkdirSync(path.join(workspaceDir, 'a-dir'))
    const result = preflightWriteTool({ filePath: 'a-dir' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.existingFileSize).toBeNull()
    }
  })

  it('rejects when target is a zero-byte empty file (any existing file → use edit_file)', () => {
    const p = path.join(workspaceDir, 'empty.txt')
    fs.writeFileSync(p, '')
    const result = preflightWriteTool({ filePath: 'empty.txt' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.existingFileSize).toBe(0)
      expect(result.error).toMatch(/write_file refused/)
      expect(result.error).toMatch(/already exists/)
      expect(result.error).toMatch(/edit_file/)
    }
  })

  it('rejects when target is a 1-byte file (no soft threshold any more)', () => {
    const p = path.join(workspaceDir, 'tiny.txt')
    fs.writeFileSync(p, 'a')
    const result = preflightWriteTool({ filePath: 'tiny.txt' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.existingFileSize).toBe(1)
      expect(result.error).toMatch(/edit_file/)
    }
  })

  it('rejects when target is a large existing file', () => {
    const body = 'a'.repeat(4096)
    const p = path.join(workspaceDir, 'big.txt')
    fs.writeFileSync(p, body)
    const result = preflightWriteTool({ filePath: 'big.txt' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.existingFileSize).toBe(4096)
      expect(result.error).toMatch(/write_file refused/)
      expect(result.error).toMatch(/already exists/)
      expect(result.error).toMatch(/edit_file/)
    }
  })

  it('rejects on a clearly-existing file with substantial content (Write→Edit pivot path)', () => {
    const body = '// existing module with real code\n'.repeat(20)
    const p = path.join(workspaceDir, 'real.ts')
    fs.writeFileSync(p, body)
    const result = preflightWriteTool({ filePath: 'real.ts' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('real.ts')
      expect(result.error).toMatch(/oldString|newString|edit_file/)
    }
  })

  it('rejects identically for absolute and relative forms of the same file', () => {
    const body = 'x'.repeat(200)
    const p = path.join(workspaceDir, 'abs-vs-rel.txt')
    fs.writeFileSync(p, body)

    const rel = preflightWriteTool({ filePath: 'abs-vs-rel.txt' })
    const abs = preflightWriteTool({ filePath: p })
    expect(rel.ok).toBe(false)
    expect(abs.ok).toBe(false)
    if (!rel.ok && !abs.ok) {
      expect(rel.existingFileSize).toBe(abs.existingFileSize)
      // Error wording uses the model-supplied display path verbatim,
      // so they differ — but the structural fields match.
      expect(rel.error).toMatch(/write_file refused/)
      expect(abs.error).toMatch(/write_file refused/)
    }
  })
})

describe('preflightWriteToolWithDisk', () => {
  it('rejects even a zero-byte disk payload (caller only invokes this for existing files)', () => {
    const result = preflightWriteToolWithDisk({
      displayPath: 'empty.txt',
      diskContent: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.existingFileSize).toBe(0)
      expect(result.error).toMatch(/edit_file/)
    }
  })

  it('rejects small disk payloads (no soft threshold any more)', () => {
    const result = preflightWriteToolWithDisk({
      displayPath: 'small.txt',
      diskContent: 'a'.repeat(8),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.existingFileSize).toBe(8)
    }
  })

  it('rejects when disk content is large', () => {
    const result = preflightWriteToolWithDisk({
      displayPath: 'big.txt',
      diskContent: 'a'.repeat(4096),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.existingFileSize).toBe(4096)
      expect(result.error).toContain('big.txt')
      expect(result.error).toMatch(/edit_file/)
    }
  })

  it('counts UTF-8 byte length, not code-point length (multi-byte chars)', () => {
    // 25 × '我' = 75 UTF-8 bytes.
    const result = preflightWriteToolWithDisk({
      displayPath: 'cjk.txt',
      diskContent: '我'.repeat(25),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.existingFileSize).toBe(75)
    }
  })

  it('matches preflightWriteTool wording byte-for-byte on the same-sized payload', () => {
    const size = 67
    const body = 'a'.repeat(size)
    const p = path.join(workspaceDir, 'wording-match.txt')
    fs.writeFileSync(p, body)

    const fromDisk = preflightWriteTool({ filePath: 'wording-match.txt' })
    const inMemory = preflightWriteToolWithDisk({
      displayPath: 'wording-match.txt',
      diskContent: body,
    })

    expect(fromDisk.ok).toBe(false)
    expect(inMemory.ok).toBe(false)
    if (!fromDisk.ok && !inMemory.ok) {
      // Same error text — only-one-source-of-truth invariant.
      expect(inMemory.error).toBe(fromDisk.error)
    }
  })
})
