/**
 * File-type detection for the attachment ingest pipeline.
 *
 * Strategy: magic-byte sniffing first (robust against misleading extensions),
 * fallback to extension. Returns a coarse `AttachmentKind` used by the
 * ingest dispatcher.
 */

import type { AttachmentKind } from './types'

const IMAGE_EXTS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  svg: 'image/svg+xml',
}

const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'kt', 'scala', 'swift', 'm', 'mm',
  'c', 'cpp', 'cc', 'cxx', 'h', 'hpp',
  'cs', 'php', 'rb', 'lua', 'pl', 'sh', 'bash', 'zsh', 'fish',
  'sql', 'r', 'dart', 'vue', 'svelte',
  'ps1', 'bat', 'cmd',
  'toml', 'ini', 'conf', 'env',
  'dockerfile', 'makefile',
])

export interface DetectResult {
  kind: AttachmentKind
  mimeType: string
}

/** Quick magic-byte sniff. Only covers high-value formats (PDF / Office ZIP / images). */
function sniffMagic(buf: Buffer): DetectResult | null {
  if (buf.length < 4) return null
  // PDF: "%PDF"
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return { kind: 'pdf', mimeType: 'application/pdf' }
  }
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { kind: 'image', mimeType: 'image/png' }
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { kind: 'image', mimeType: 'image/jpeg' }
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { kind: 'image', mimeType: 'image/gif' }
  }
  // WebP: "RIFF....WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { kind: 'image', mimeType: 'image/webp' }
  }
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { kind: 'image', mimeType: 'image/bmp' }
  }
  // TIFF ("II*\0" or "MM\0*")
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  ) {
    return { kind: 'image', mimeType: 'image/tiff' }
  }
  // ZIP-based (docx/xlsx/pptx/ipynb not zip). "PK\x03\x04"
  // We can't distinguish docx vs xlsx vs pptx just from magic, so leave to ext.
  return null
}

export function detectKind(filePath: string, magicHead: Buffer | null): DetectResult {
  const magic = magicHead ? sniffMagic(magicHead) : null
  const extRaw = filePath.split('.').pop()?.toLowerCase() || ''
  const ext = extRaw.replace(/[^a-z0-9]/g, '')

  if (magic && magic.kind === 'pdf') return magic
  if (magic && magic.kind === 'image') {
    // Prefer magic MIME but keep SVG (text-based) as-is when extension says so.
    if (ext === 'svg') return { kind: 'image', mimeType: 'image/svg+xml' }
    return magic
  }

  if (IMAGE_EXTS[ext]) return { kind: 'image', mimeType: IMAGE_EXTS[ext] }

  switch (ext) {
    case 'pdf': return { kind: 'pdf', mimeType: 'application/pdf' }
    case 'docx': return { kind: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    case 'doc':  return { kind: 'doc',  mimeType: 'application/msword' }
    case 'rtf':  return { kind: 'rtf',  mimeType: 'application/rtf' }
    case 'xlsx': return { kind: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    case 'xls':  return { kind: 'xls',  mimeType: 'application/vnd.ms-excel' }
    case 'csv':  return { kind: 'csv',  mimeType: 'text/csv' }
    case 'tsv':  return { kind: 'tsv',  mimeType: 'text/tab-separated-values' }
    case 'pptx': return { kind: 'pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    case 'ppt':  return { kind: 'ppt',  mimeType: 'application/vnd.ms-powerpoint' }
    case 'md':
    case 'markdown':
      return { kind: 'markdown', mimeType: 'text/markdown' }
    case 'json': return { kind: 'json', mimeType: 'application/json' }
    case 'yaml':
    case 'yml':  return { kind: 'yaml', mimeType: 'application/yaml' }
    case 'xml':  return { kind: 'xml',  mimeType: 'application/xml' }
    case 'html':
    case 'htm':  return { kind: 'html', mimeType: 'text/html' }
    case 'ipynb': return { kind: 'ipynb', mimeType: 'application/x-ipynb+json' }
    case 'txt':
    case 'log':
      return { kind: 'text', mimeType: 'text/plain' }
  }

  if (CODE_EXTS.has(ext)) return { kind: 'code', mimeType: 'text/plain' }

  return { kind: 'unknown', mimeType: 'application/octet-stream' }
}
