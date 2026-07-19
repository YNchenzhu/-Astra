import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  UTF8_BOM_CHAR,
  applyLineEndingStyle,
  detectBufferEncoding,
  detectLineEndingStyle,
  readFileSyncWithDetectedEncoding,
  stripUtf8Bom,
} from './lineEndings'

describe('lineEndings', () => {
  it('detectLineEndingStyle', () => {
    expect(detectLineEndingStyle('a\nb')).toBe('lf')
    expect(detectLineEndingStyle('a\r\nb')).toBe('crlf')
  })

  it('applyLineEndingStyle normalizes then applies', () => {
    expect(applyLineEndingStyle('a\nb', 'crlf')).toBe('a\r\nb')
    expect(applyLineEndingStyle('a\r\nb', 'lf')).toBe('a\nb')
  })

  it('stripUtf8Bom', () => {
    expect(stripUtf8Bom('x')).toEqual({ body: 'x', hadBom: false })
    expect(stripUtf8Bom(`${UTF8_BOM_CHAR}x`)).toEqual({ body: 'x', hadBom: true })
  })
})

describe('detectBufferEncoding', () => {
  it('returns utf8 for an empty buffer (not "ascii")', () => {
    expect(detectBufferEncoding(Buffer.alloc(0))).toBe('utf8')
  })

  it('detects UTF-16LE from FF FE prefix', () => {
    expect(
      detectBufferEncoding(Buffer.from([0xff, 0xfe, 0x41, 0x00])),
    ).toBe('utf16le')
  })

  it('keeps utf8 for UTF-8 BOM (EF BB BF) prefix', () => {
    expect(
      detectBufferEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x41])),
    ).toBe('utf8')
  })

  it('returns utf8 for raw ASCII / no BOM', () => {
    expect(detectBufferEncoding(Buffer.from('plain ascii'))).toBe('utf8')
  })

  it('does NOT detect UTF-16BE (FE FF) — documented limitation', () => {
    // Intentional: we fall through to utf-8 default. The docstring on
    // `detectBufferEncoding` explains why. If this test ever flips, the
    // calling tools must also grow utf-16be write support — currently
    // they do not.
    expect(
      detectBufferEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x41])),
    ).toBe('utf8')
  })

  it('does not confuse a single 0xFF byte for UTF-16LE BOM', () => {
    expect(detectBufferEncoding(Buffer.from([0xff]))).toBe('utf8')
  })

  it('does not confuse a 2-byte prefix that happens to match UTF-8 BOM partial', () => {
    // EF BB without BF is NOT a UTF-8 BOM — must remain utf8 default.
    expect(detectBufferEncoding(Buffer.from([0xef, 0xbb, 0x41]))).toBe('utf8')
  })
})

describe('readFileSyncWithDetectedEncoding', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cui-rfsde-'))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('reads a plain UTF-8 file verbatim', () => {
    const f = path.join(tmp, 'a.txt')
    fs.writeFileSync(f, 'hello\n', 'utf-8')
    const { content, encoding } = readFileSyncWithDetectedEncoding(f)
    expect(encoding).toBe('utf8')
    expect(content).toBe('hello\n')
  })

  it('reads a UTF-16LE file (with BOM) and decodes correctly', () => {
    const f = path.join(tmp, 'a.txt')
    fs.writeFileSync(
      f,
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('hello world\n', 'utf16le'),
      ]),
    )
    const { content, encoding } = readFileSyncWithDetectedEncoding(f)
    expect(encoding).toBe('utf16le')
    // BOM survives in JS string as `\uFEFF`; round-trip behaviour
    // depends on `hashFileContent`'s `stripUtf8Bom` normalisation
    // (covered in atomicWriter.test.ts).
    expect(content.replace(/^\uFEFF/, '')).toBe('hello world\n')
  })

  it('preserves a UTF-8 BOM as `\\uFEFF` in the returned string', () => {
    const f = path.join(tmp, 'a.txt')
    fs.writeFileSync(
      f,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\n', 'utf-8')]),
    )
    const { content, encoding } = readFileSyncWithDetectedEncoding(f)
    expect(encoding).toBe('utf8')
    expect(content.charCodeAt(0)).toBe(0xfeff)
    expect(content.slice(1)).toBe('x\n')
  })

  it('propagates ENOENT from fs (no silent empty)', () => {
    const f = path.join(tmp, 'missing.txt')
    expect(() => readFileSyncWithDetectedEncoding(f)).toThrow(/ENOENT/)
  })
})
