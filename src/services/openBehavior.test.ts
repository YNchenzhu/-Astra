/**
 * 2026-07 富文件审计修复回归 —— 统一打开行为表。
 */

import { describe, it, expect } from 'vitest'
import {
  DOC_PREVIEW_EXTS,
  IMAGE_VIEW_EXTS,
  getFileExt,
  getOpenBehavior,
  isImageViewExt,
} from './openBehavior'

describe('getOpenBehavior', () => {
  it('图片 → image(含大写扩展名)', () => {
    expect(getOpenBehavior('photo.png')).toBe('image')
    expect(getOpenBehavior('Photo.JPG')).toBe('image')
    expect(getOpenBehavior('anim.webp')).toBe('image')
    expect(getOpenBehavior('icon.ico')).toBe('image')
    expect(getOpenBehavior('scan.tiff')).toBe('image')
    expect(isImageViewExt('a.avif')).toBe(true)
  })

  it('文档预览类 → preview(与 FilePreview 白名单同源,含 ipynb)', () => {
    for (const ext of ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'ipynb', 'rtf']) {
      expect(getOpenBehavior(`file.${ext}`)).toBe('preview')
      expect(DOC_PREVIEW_EXTS.has(ext)).toBe(true)
    }
  })

  it('svg 是文本(Monaco + 分屏预览),不进图片查看器', () => {
    expect(getOpenBehavior('logo.svg')).toBe('text')
    expect(IMAGE_VIEW_EXTS.has('svg')).toBe(false)
  })

  it('代码/文本/无扩展名 → text', () => {
    expect(getOpenBehavior('main.ts')).toBe('text')
    expect(getOpenBehavior('README.md')).toBe('text')
    expect(getOpenBehavior('data.csv')).toBe('text')
    expect(getOpenBehavior('Makefile')).toBe('text')
    expect(getOpenBehavior('.gitignore')).toBe('text')
  })

  it('getFileExt 边界', () => {
    expect(getFileExt('a.b.PNG')).toBe('png')
    expect(getFileExt('noext')).toBe('')
  })
})
