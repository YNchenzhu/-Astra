/**
 * Lightweight Office file text extraction (docx, xlsx, pptx).
 *
 * These formats are ZIP archives containing XML. We use Node's built-in
 * zlib to decompress and extract text without external dependencies.
 */

import { readFile } from 'fs/promises'
import type { ToolResult } from '../ai/tools'

const OFFICE_EXTENSIONS = new Set([
  'docx', 'xlsx', 'xls', 'pptx', 'doc', 'ppt',
])

const MAX_OFFICE_SIZE = 20 * 1024 * 1024 // 20 MB

export function isOfficeExtension(ext: string): boolean {
  return OFFICE_EXTENSIONS.has(ext.toLowerCase())
}

interface ZipEntry {
  filename: string
  data: Buffer
}

async function extractZipEntries(
  filePath: string,
  filter: (filename: string) => boolean,
): Promise<ZipEntry[]> {
  const buffer = await readFile(filePath)

  const entries: ZipEntry[] = []
  let offset = 0

  while (offset < buffer.length - 4) {
    const sig = buffer.readUInt32LE(offset)
    if (sig !== 0x04034b50) break // PK\x03\x04

    const compressionMethod = buffer.readUInt16LE(offset + 8)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const filename = buffer.toString('utf8', offset + 30, offset + 30 + nameLength)
    const dataStart = offset + 30 + nameLength + extraLength
    const dataEnd = dataStart + compressedSize

    if (filter(filename)) {
      const rawData = buffer.subarray(dataStart, dataEnd)

      if (compressionMethod === 0) {
        entries.push({ filename, data: rawData })
      } else if (compressionMethod === 8) {
        try {
          const { inflateRawSync } = await import('node:zlib')
          const inflated = inflateRawSync(rawData)
          entries.push({ filename, data: inflated })
        } catch {
          // Skip corrupt entries
        }
      }
    }

    offset = dataEnd
  }

  return entries
}

async function extractDocxText(filePath: string): Promise<string> {
  const entries = await extractZipEntries(filePath, (name) =>
    name === 'word/document.xml' ||
    name.startsWith('word/header') ||
    name.startsWith('word/footer'),
  )

  const parts: string[] = []
  const docEntry = entries.find((e) => e.filename === 'word/document.xml')
  if (docEntry) {
    const xml = docEntry.data.toString('utf8')
    const paragraphs = xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) || []
    for (const p of paragraphs) {
      const texts = p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []
      const line = texts.map((t) => t.replace(/<[^>]+>/g, '')).join('')
      if (line.trim()) parts.push(line)
    }
  }

  return parts.join('\n') || '[No text content extracted from docx]'
}

async function extractXlsxText(filePath: string): Promise<string> {
  const entries = await extractZipEntries(filePath, (name) =>
    name === 'xl/sharedStrings.xml' || name.startsWith('xl/worksheets/'),
  )

  // Build shared strings table
  const ssEntry = entries.find((e) => e.filename === 'xl/sharedStrings.xml')
  const sharedStrings: string[] = []
  if (ssEntry) {
    const xml = ssEntry.data.toString('utf8')
    const items = xml.match(/<si>[\s\S]*?<\/si>/g) || []
    for (const item of items) {
      const texts = item.match(/<t[^>]*>([^<]*)<\/t>/g) || []
      sharedStrings.push(texts.map((t) => t.replace(/<[^>]+>/g, '')).join(''))
    }
  }

  // Extract worksheet data
  const sheetEntries = entries
    .filter((e) => e.filename.startsWith('xl/worksheets/'))
    .sort((a, b) => a.filename.localeCompare(b.filename))

  const parts: string[] = []
  for (const sheet of sheetEntries) {
    const sheetName = sheet.filename.replace('xl/worksheets/', '').replace('.xml', '')
    parts.push(`[Sheet: ${sheetName}]`)

    const xml = sheet.data.toString('utf8')
    const rows = xml.match(/<row[\s>][\s\S]*?<\/row>/g) || []

    for (const row of rows) {
      const cells = row.match(/<c[\s>][\s\S]*?<\/c>/g) || []
      const values: string[] = []

      for (const cell of cells) {
        const typeMatch = cell.match(/t="([^"]*)"/)
        const valueMatch = cell.match(/<v>([^<]*)<\/v>/)
        if (!valueMatch) {
          values.push('')
          continue
        }
        const rawValue = valueMatch[1]
        if (typeMatch && typeMatch[1] === 's') {
          const idx = parseInt(rawValue, 10)
          values.push(sharedStrings[idx] ?? rawValue)
        } else {
          values.push(rawValue)
        }
      }

      if (values.some((v) => v.trim())) {
        parts.push(values.join('\t'))
      }
    }
    parts.push('')
  }

  return parts.join('\n').trim() || '[No text content extracted from xlsx]'
}

async function extractPptxText(filePath: string): Promise<string> {
  const entries = await extractZipEntries(filePath, (name) =>
    name.startsWith('ppt/slides/slide') && name.endsWith('.xml'),
  )

  const parts: string[] = []
  const sorted = entries.sort((a, b) => a.filename.localeCompare(b.filename))

  for (const entry of sorted) {
    const slideNum = entry.filename.match(/slide(\d+)\.xml/)?.[1] || '?'
    parts.push(`[Slide ${slideNum}]`)
    const xml = entry.data.toString('utf8')
    const texts = xml.match(/<a:t>([^<]*)<\/a:t>/g) || []
    const slideText = texts.map((t) => t.replace(/<[^>]+>/g, '')).join(' ')
    if (slideText.trim()) parts.push(slideText)
    parts.push('')
  }

  return parts.join('\n').trim() || '[No text content extracted from pptx]'
}

export async function readOfficeFile(filePath: string): Promise<ToolResult> {
  try {
    const { stat } = await import('fs/promises')
    const stats = await stat(filePath)

    if (stats.size > MAX_OFFICE_SIZE) {
      return {
        success: false,
        error: `Office file too large (${Math.ceil(stats.size / 1_000_000)}MB > 20MB limit). Consider splitting or converting to text first.`,
      }
    }

    const ext = filePath.split('.').pop()?.toLowerCase() || ''

    if (ext === 'doc' || ext === 'xls' || ext === 'ppt') {
      return {
        success: false,
        error: `Legacy Office format (.${ext}) is not supported. Please convert to .${ext}x format first.`,
      }
    }

    let text: string
    if (ext === 'docx') {
      text = await extractDocxText(filePath)
    } else if (ext === 'xlsx') {
      text = await extractXlsxText(filePath)
    } else if (ext === 'pptx') {
      text = await extractPptxText(filePath)
    } else {
      return { success: false, error: `Unsupported Office format: .${ext}` }
    }

    const MAX_TEXT_CHARS = 80_000
    if (text.length > MAX_TEXT_CHARS) {
      text = `${text.slice(0, MAX_TEXT_CHARS)}\n\n... [content truncated at ${MAX_TEXT_CHARS} chars, total ${text.length} chars]`
    }

    return {
      success: true,
      output: `[Office document: ${filePath.split(/[\\/]/).pop()}]\n\n${text}`,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { success: false, error: `Failed to read Office file: ${msg}` }
  }
}
