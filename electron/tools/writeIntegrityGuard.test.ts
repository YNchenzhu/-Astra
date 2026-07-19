import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertPreWriteIntegrity,
  verifyPostWriteIntegrity,
  WriteIntegrityCode,
} from './writeIntegrityGuard'

describe('assertPreWriteIntegrity', () => {
  // ── Create branch ───────────────────────────────────────────────────────
  it('allows any content when the file does not yet exist', () => {
    const r = assertPreWriteIntegrity({
      resolvedPath: '/tmp/new.txt',
      displayPath: 'new.txt',
      previousContent: '',
      nextContent: '',
      fileExisted: false,
      intent: 'write',
    })
    expect(r.ok).toBe(true)
  })

  it('allows empty next content when the existing file is already empty', () => {
    const r = assertPreWriteIntegrity({
      resolvedPath: '/tmp/already-empty.txt',
      displayPath: 'already-empty.txt',
      previousContent: '',
      nextContent: '',
      fileExisted: true,
      intent: 'write',
    })
    expect(r.ok).toBe(true)
  })

  // ── Strict-empty rejection ──────────────────────────────────────────────
  it('rejects strictly empty next content against a non-empty file (write intent)', () => {
    const r = assertPreWriteIntegrity({
      resolvedPath: '/tmp/keep.txt',
      displayPath: 'keep.txt',
      previousContent: 'keep me',
      nextContent: '',
      fileExisted: true,
      intent: 'write',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe(WriteIntegrityCode.DestructiveEmptyWrite)
      expect(r.error).toMatch(/empty|clear/i)
    }
  })

  it('uses the edit-flavoured message when intent is edit', () => {
    const r = assertPreWriteIntegrity({
      resolvedPath: '/tmp/keep.txt',
      displayPath: 'keep.txt',
      previousContent: 'keep me',
      nextContent: '',
      fileExisted: true,
      intent: 'edit',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // Edit-specific wording guides the model to narrow its old/new_string
      // rather than pointing them at Delete.
      expect(r.error).toMatch(/narrower|old_string|new_string/i)
    }
  })

  // ── Post-BOM-strip empty-body rejection ─────────────────────────────────
  it('rejects BOM-only next content that would clear a real file', () => {
    const r = assertPreWriteIntegrity({
      resolvedPath: '/tmp/bom.txt',
      displayPath: 'bom.txt',
      previousContent: 'real data',
      nextContent: '\uFEFF',
      fileExisted: true,
      intent: 'write',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe(WriteIntegrityCode.DestructiveWhitespaceLikeWrite)
    }
  })

  it('allows a benign BOM-only payload when the file only held a BOM before', () => {
    // Previous body is empty after BOM stripping, so nothing is destroyed.
    const r = assertPreWriteIntegrity({
      resolvedPath: '/tmp/bom-bom.txt',
      displayPath: 'bom-bom.txt',
      previousContent: '\uFEFF',
      nextContent: '\uFEFF',
      fileExisted: true,
      intent: 'write',
    })
    expect(r.ok).toBe(true)
  })

  it('allows substantive replacement of a non-empty file', () => {
    const r = assertPreWriteIntegrity({
      resolvedPath: '/tmp/updated.txt',
      displayPath: 'updated.txt',
      previousContent: 'original body',
      nextContent: 'replacement body',
      fileExisted: true,
      intent: 'write',
    })
    expect(r.ok).toBe(true)
  })
})

describe('verifyPostWriteIntegrity', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-wig-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('returns ok with the actual content when disk matches expected', () => {
    const f = path.join(tmp, 'match.txt')
    fs.writeFileSync(f, 'abc', 'utf-8')
    const r = verifyPostWriteIntegrity({
      resolvedPath: f,
      displayPath: f,
      expectedContent: 'abc',
      intent: 'write',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.actualContent).toBe('abc')
    }
  })

  it('flags a mismatch when disk bytes differ from expected bytes', () => {
    const f = path.join(tmp, 'mismatch.txt')
    fs.writeFileSync(f, 'actual', 'utf-8')
    const r = verifyPostWriteIntegrity({
      resolvedPath: f,
      displayPath: f,
      expectedContent: 'intended',
      intent: 'write',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe(WriteIntegrityCode.PostWriteMismatch)
      expect(r.error).toMatch(/do not match/i)
    }
  })

  it('returns a read-failure when the file was removed between write and verify', () => {
    const f = path.join(tmp, 'gone.txt')
    const r = verifyPostWriteIntegrity({
      resolvedPath: f,
      displayPath: f,
      expectedContent: 'anything',
      intent: 'write',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe(WriteIntegrityCode.PostWriteReadFailed)
    }
  })
})
