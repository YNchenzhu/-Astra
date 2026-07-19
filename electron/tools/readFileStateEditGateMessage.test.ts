/**
 * The "partial-read window does not cover the edit region" error must
 * give the AI a **copy-pasteable** next-call shape (concrete `offset`/`limit`
 * numbers, plus an explicit "or just read the whole file" escape hatch).
 *
 * Without this, smaller / faster models routinely re-call read_file with
 * the SAME offset/limit they used before — converting "lines 380–420" in
 * prose into `read_file(offset=N, limit=M)` requires arithmetic they skip.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { statSync, utimesSync } from 'node:fs'
import {
  assertReadBeforeEdit,
  assertReadBeforeEditByReadId,
  assertReadBeforeWrite,
  recordSuccessfulRead,
  clearAllReadFileState,
} from './readFileState'

describe('assertReadBeforeEdit — actionable recovery message', () => {
  let dir: string
  let filePath: string
  let bodyLines: string[]

  beforeEach(() => {
    clearAllReadFileState()
    dir = mkdtempSync(join(tmpdir(), 'editgate-msg-'))
    filePath = join(dir, 'big.txt')
    // 600 lines — large enough that a tiny window doesn't cover an edit at line 500.
    bodyLines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}: lorem ipsum line content`)
    writeFileSync(filePath, bodyLines.join('\n'), 'utf8')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns concrete read_file(offset=…, limit=…) AND a full-read escape hatch when partial window misses the edit', () => {
    // Simulate: the agent read lines 0..99 only (offset=0, limit=100).
    const partialBody = bodyLines.slice(0, 100).join('\n')
    const mtimeMs = statSync(filePath).mtimeMs
    recordSuccessfulRead(filePath, {
      mtimeMs,
      isPartialView: true,
      viewedContent: partialBody,
      readOffset: 0,
      readLimit: 100,
    })

    // Edit target lives at line 500 — far outside the partial window.
    const oldString = 'line 500: lorem ipsum line content'
    const newString = 'line 500: EDITED'
    const gate = assertReadBeforeEdit(
      filePath,
      filePath,
      bodyLines.join('\n'),
      oldString,
      newString,
    )

    expect(gate.ok).toBe(false)
    if (gate.ok) return
    const msg = String(gate.error)
    // Concrete next-call values (the AI can copy these verbatim).
    expect(msg).toMatch(/offset=\d+/)
    expect(msg).toMatch(/limit=\d+/)
    // Explicit "or read the whole file" escape hatch.
    expect(msg.toLowerCase()).toContain('whole file')
  })

  it('returns no-receipt message with both options when the path was never read', () => {
    const gate = assertReadBeforeEdit(
      filePath,
      filePath,
      bodyLines.join('\n'),
      'line 500: lorem ipsum line content',
      'line 500: EDITED',
    )
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    const msg = String(gate.error).toLowerCase()
    expect(msg).toContain('full read')
    expect(msg).toContain('margin')
  })
})

describe('stale-receipt rejections — self-script clarification note', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    clearAllReadFileState()
    dir = mkdtempSync(join(tmpdir(), 'stale-msg-'))
    filePath = join(dir, 'doc.txt')
    writeFileSync(filePath, 'original content\n', 'utf8')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Simulate the AI's own python script rewriting the file after the read. */
  function readThenScriptRewrites(): void {
    const mtimeMs = statSync(filePath).mtimeMs
    recordSuccessfulRead(filePath, {
      mtimeMs,
      isPartialView: false,
      fullFileContent: 'original content\n',
      viewedContent: 'original content\n',
    })
    writeFileSync(filePath, 'content rewritten by script\n', 'utf8')
    // Force an mtime delta even on coarse-resolution filesystems.
    const t = new Date(Date.now() + 5_000)
    utimesSync(filePath, t, t)
  }

  it('assertReadBeforeWrite explains that the agent\'s own shell/python commands count as the modification', () => {
    readThenScriptRewrites()
    const gate = assertReadBeforeWrite(filePath, 'content rewritten by script\n')
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.error).toMatch(/shell\/python/i)
    expect(gate.error).toMatch(/scripts do not/i)
  })

  it('assertReadBeforeEditByReadId (hash mismatch) carries the same clarification', () => {
    const mtimeMs = statSync(filePath).mtimeMs
    const receipt = recordSuccessfulRead(filePath, {
      mtimeMs,
      isPartialView: false,
      fullFileContent: 'original content\n',
      viewedContent: 'original content\n',
    })
    const readId = receipt?.readId
    expect(readId).toBeTruthy()
    writeFileSync(filePath, 'content rewritten by script\n', 'utf8')

    const gate = assertReadBeforeEditByReadId(
      filePath,
      readId!,
      'content rewritten by script\n',
      'original content',
      'edited content',
    )
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.code).toBe('HASH_MISMATCH')
    expect(gate.error).toMatch(/shell\/python/i)
  })

  it('mtime-only touch with UNCHANGED bytes still passes (no false positive)', () => {
    const mtimeMs = statSync(filePath).mtimeMs
    recordSuccessfulRead(filePath, {
      mtimeMs,
      isPartialView: false,
      fullFileContent: 'original content\n',
      viewedContent: 'original content\n',
    })
    const t = new Date(Date.now() + 5_000)
    utimesSync(filePath, t, t)
    const gate = assertReadBeforeWrite(filePath, 'original content\n')
    expect(gate.ok).toBe(true)
  })
})

describe('readId gate — exact recovery and snapshot boundaries', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    clearAllReadFileState()
    dir = mkdtempSync(join(tmpdir(), 'readid-recovery-'))
    filePath = join(dir, 'target.txt')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts a redundant JSON-escaped quote payload against the visible content', () => {
    const content = '| 世界 | "不在天道之内"的真正含义 | 3 | 28 |\n'
    writeFileSync(filePath, content, 'utf8')
    const receipt = recordSuccessfulRead(filePath, {
      mtimeMs: statSync(filePath).mtimeMs,
      isPartialView: false,
      fullFileContent: content,
      viewedContent: content,
    })

    const gate = assertReadBeforeEditByReadId(
      filePath,
      receipt.readId,
      content,
      '| 世界 | \\"不在天道之内\\"的真正含义 | 3 | 28 |',
      '| 世界 | \\"不在天道之外\\"的真正含义 | 3 | 28 |',
    )
    expect(gate.ok).toBe(true)
  })

  it('keeps a full-read readId valid and diagnoses an extra blank line', () => {
    const content = '- **解锁层级**：三级\n- **限制**：不可越级\n'
    writeFileSync(filePath, content, 'utf8')
    const receipt = recordSuccessfulRead(filePath, {
      mtimeMs: statSync(filePath).mtimeMs,
      isPartialView: false,
      fullFileContent: content,
      viewedContent: content,
    })

    const gate = assertReadBeforeEditByReadId(
      filePath,
      receipt.readId,
      content,
      '- **解锁层级**：三级\n\n- **限制**：不可越级',
      '- **解锁层级**：四级\n\n- **限制**：不可越级',
    )
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.code).toBe('OLD_STRING_NOT_IN_READ')
    expect(gate.error).toMatch(/readId is still valid/i)
    expect(gate.error).toMatch(/do not re-read the same unchanged file/i)
    expect(gate.error).toMatch(/extra blank line/i)
  })

  it('checks full-read targets beyond the 512 KB cached snapshot prefix', () => {
    const content = `${'a'.repeat(512 * 1024 + 64)}TAIL_TARGET\n`
    writeFileSync(filePath, content, 'utf8')
    const receipt = recordSuccessfulRead(filePath, {
      mtimeMs: statSync(filePath).mtimeMs,
      isPartialView: false,
      fullFileContent: content,
      viewedContent: content,
    })

    const gate = assertReadBeforeEditByReadId(
      filePath,
      receipt.readId,
      content,
      'TAIL_TARGET',
      'TAIL_FIXED',
    )
    expect(gate.ok).toBe(true)
  })

  it('reconstructs an oversized partial window instead of trusting its truncated prefix', () => {
    const firstLine = `${'a'.repeat(512 * 1024 + 64)}PARTIAL_TAIL_TARGET`
    const content = `${firstLine}\nsecond line\n`
    writeFileSync(filePath, content, 'utf8')
    const receipt = recordSuccessfulRead(filePath, {
      mtimeMs: statSync(filePath).mtimeMs,
      isPartialView: true,
      viewedContent: firstLine,
      readOffset: 0,
      readLimit: 1,
    })

    const gate = assertReadBeforeEditByReadId(
      filePath,
      receipt.readId,
      content,
      'PARTIAL_TAIL_TARGET',
      'PARTIAL_TAIL_FIXED',
    )
    expect(gate.ok).toBe(true)
  })
})
