/**
 * 2026-07 富文件审计修复回归 —— 编辑器读路径编码检测。
 */

import { describe, it, expect } from 'vitest'
import iconv from 'iconv-lite'
import { decodeEditorBuffer, hasUtf16Bom } from './editorTextDecode'

describe('decodeEditorBuffer', () => {
  it('UTF-8 原样解码', () => {
    const { content, encoding } = decodeEditorBuffer(Buffer.from('hello 世界', 'utf8'))
    expect(content).toBe('hello 世界')
    expect(encoding).toBe('utf-8')
  })

  it('GBK 中文正确解码并报告 legacy 编码', () => {
    const text = '这是一段用于验证编码检测的中文文本。文件格式:正文+空行+标题+正文。'
    const gbk = iconv.encode(text, 'GBK')
    const { content, encoding } = decodeEditorBuffer(gbk)
    expect(content).toBe(text)
    expect(encoding).not.toBe('utf-8')
    expect(iconv.encodingExists(encoding)).toBe(true)
  })

  it('UTF-16LE BOM 解码', () => {
    const buf = Buffer.from('\ufeffpowershell 脚本内容', 'utf16le')
    const { content, encoding } = decodeEditorBuffer(buf)
    expect(content).toContain('powershell 脚本内容')
    expect(encoding).toBe('utf16le')
  })

  it('UTF-16BE BOM 解码(swap16)', () => {
    const le = Buffer.from('\ufeffbig endian text', 'utf16le')
    const be = Buffer.from(le)
    be.swap16()
    const { content, encoding } = decodeEditorBuffer(be)
    expect(content).toContain('big endian text')
    expect(encoding).toBe('UTF-16BE')
  })

  it('空文件 → 空串 utf-8', () => {
    expect(decodeEditorBuffer(Buffer.alloc(0))).toEqual({ content: '', encoding: 'utf-8' })
  })
})

describe('hasUtf16Bom', () => {
  it('识别 LE/BE BOM,不误报 UTF-8', () => {
    expect(hasUtf16Bom(Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toBe(true)
    expect(hasUtf16Bom(Buffer.from([0xfe, 0xff, 0x00, 0x41]))).toBe(true)
    expect(hasUtf16Bom(Buffer.from('plain utf8'))).toBe(false)
  })
})
