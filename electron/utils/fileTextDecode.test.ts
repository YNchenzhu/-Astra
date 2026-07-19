import { describe, expect, it } from 'vitest'
import { decodeTextFileBuffer, fileStartsWithUtf16Bom } from './fileTextDecode'

describe('fileTextDecode', () => {
  it('decodes UTF-8 with BOM', () => {
    const buf = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('hi', 'utf8')])
    expect(decodeTextFileBuffer(buf)).toBe('hi')
  })

  it('decodes UTF-16 LE BOM', () => {
    const core = Buffer.from('a\nb', 'utf16le')
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), core])
    expect(decodeTextFileBuffer(buf)).toBe('a\nb')
  })

  it('detects UTF-16 BOM prefix', () => {
    expect(fileStartsWithUtf16Bom(Buffer.from([0xff, 0xfe]))).toBe(true)
    expect(fileStartsWithUtf16Bom(Buffer.from([0xfe, 0xff]))).toBe(true)
    expect(fileStartsWithUtf16Bom(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false)
  })
})
