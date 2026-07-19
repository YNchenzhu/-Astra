/**
 * openBehavior —— 编辑器"打开文件"行为的唯一决策表。
 *
 * 2026-07 富文件审计修复:此前每个打开入口(Sidebar / TitleBar /
 * CommandPalette / SearchPanel / ProblemsPanel / chat 链接)各自维护
 * (或根本没有)预览扩展名清单,导致:
 *   - 图片被 `fs:read-file` 以 UTF-8 读成乱码塞进 Monaco(大图卡死);
 *   - Sidebar 的 PREVIEW_ONLY 与 FilePreview 的 PREVIEW_EXTS 不同步
 *     (ipynb 会被多读一次全文);
 *   - 非 Sidebar 入口对 pdf/docx 也做了无意义的全文 UTF-8 读取。
 *
 * 所有入口统一走 {@link readTabContent}:只有 'text' 行为才真正读盘,
 * 'image' / 'preview' 的标签页内容置空,由 EditorArea 路由到对应查看器
 * (ImageLivePreview / OfficeLivePreview / PdfLivePreview / FilePreview),
 * 查看器自己经二进制通道取字节。
 */

import { readFile } from './fileSystem'

export type OpenBehavior = 'text' | 'image' | 'preview'

/** 走 ImageLivePreview 的图片扩展名(svg 是文本,走 Monaco + 分屏预览)。 */
export const IMAGE_VIEW_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif',
])

/**
 * 走文档预览(Office/Pdf/FilePreview)的扩展名。
 * 与 `FilePreview.shouldPreviewInsteadOfEdit` 共享此集合 —— 单一来源。
 */
export const DOC_PREVIEW_EXTS = new Set([
  'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'ipynb', 'rtf',
])

export function getFileExt(fileName: string): string {
  const i = fileName.lastIndexOf('.')
  return i < 0 ? '' : fileName.slice(i + 1).toLowerCase()
}

export function getOpenBehavior(fileName: string): OpenBehavior {
  const ext = getFileExt(fileName)
  if (IMAGE_VIEW_EXTS.has(ext)) return 'image'
  if (DOC_PREVIEW_EXTS.has(ext)) return 'preview'
  return 'text'
}

export function isImageViewExt(fileName: string): boolean {
  return getOpenBehavior(fileName) === 'image'
}

/**
 * 为标签页读取内容:文本文件读盘,图片/文档预览类返回空字符串
 * (查看器组件懒加载自己的二进制载荷,避免 UTF-8 乱码与大文件卡死)。
 */
export async function readTabContent(fullPath: string, fileName: string): Promise<string> {
  return getOpenBehavior(fileName) === 'text' ? readFile(fullPath) : ''
}
