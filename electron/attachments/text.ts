/**
 * Text / code / CSV reader with encoding auto-detection.
 *
 * Uses `chardet` to detect, `iconv-lite` to decode. Falls back to UTF-8
 * when detection is unsure. Strips UTF-8 BOM.
 */

import { readFile } from 'fs/promises'
import chardet from 'chardet'
import iconv from 'iconv-lite'
import { LIMITS, type AttachmentKind } from './types'

function decodeBuffer(buf: Buffer): string {
  // Fast path: empty
  if (buf.length === 0) return ''

  const detected = chardet.detect(buf) || 'UTF-8'
  const enc = String(detected).toUpperCase()

  // Normalize common variants.
  const normalized = enc === 'ASCII' ? 'UTF-8' : enc

  try {
    if (iconv.encodingExists(normalized)) {
      return iconv.decode(buf, normalized)
    }
  } catch {
    // fall through
  }
  return buf.toString('utf8')
}

function stripBom(s: string): string {
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1)
  return s
}

function truncate(content: string): { content: string; truncated: boolean; originalChars: number } {
  const originalChars = content.length
  if (originalChars <= LIMITS.MAX_TEXT_CHARS) {
    return { content, truncated: false, originalChars }
  }
  const keepHead = Math.floor(LIMITS.MAX_TEXT_CHARS * 0.8)
  const keepTail = LIMITS.MAX_TEXT_CHARS - keepHead - 64
  const head = content.slice(0, keepHead)
  const tail = keepTail > 0 ? content.slice(-keepTail) : ''
  const omitted = originalChars - keepHead - (keepTail > 0 ? keepTail : 0)
  const marker = `\n\n... [${omitted.toLocaleString()} chars truncated, original ${originalChars.toLocaleString()} chars] ...\n\n`
  return { content: head + marker + tail, truncated: true, originalChars }
}

/** Read any text-like file to a UTF-8 string with auto-decoded encoding. */
export async function readTextFile(filePath: string): Promise<{
  content: string
  truncated: boolean
  originalChars: number
}> {
  const buf = await readFile(filePath)
  const decoded = stripBom(decodeBuffer(buf))
  return truncate(decoded)
}

/**
 * Very light-weight CSV → Markdown table converter. Not trying to be bulletproof;
 * handles simple quoted-with-comma cells and auto-detects tab/semicolon/comma.
 */
export async function readTableFile(filePath: string, kind: AttachmentKind): Promise<{
  content: string
  truncated: boolean
  originalChars: number
}> {
  const { content: raw } = await readTextFile(filePath)
  const delimiter = kind === 'tsv' ? '\t' : detectDelimiter(raw)
  const rows = parseCsv(raw, delimiter)
  if (rows.length === 0) {
    return { content: '[empty table]', truncated: false, originalChars: 0 }
  }
  const MAX_ROWS = 500
  const MAX_COLS = 40
  const truncatedRows = rows.length > MAX_ROWS
  const truncatedCols = rows.some((r) => r.length > MAX_COLS)
  const limited = rows.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS))

  const header = limited[0]
  const body = limited.slice(1)
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

  const lines: string[] = []
  lines.push(`| ${header.map(esc).join(' | ')} |`)
  lines.push(`| ${header.map(() => '---').join(' | ')} |`)
  for (const r of body) {
    const padded = [...r]
    while (padded.length < header.length) padded.push('')
    lines.push(`| ${padded.map(esc).join(' | ')} |`)
  }
  if (truncatedRows) {
    lines.push(`\n_Showing first ${MAX_ROWS} of ${rows.length} rows._`)
  }
  if (truncatedCols) {
    lines.push(`_Showing first ${MAX_COLS} columns per row._`)
  }
  const content = lines.join('\n')
  return {
    content,
    truncated: truncatedRows || truncatedCols,
    originalChars: raw.length,
  }
}

function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/, 1)[0] || ''
  const counts: Record<string, number> = {
    ',': (firstLine.match(/,/g) || []).length,
    ';': (firstLine.match(/;/g) || []).length,
    '\t': (firstLine.match(/\t/g) || []).length,
  }
  let best = ','
  let bestN = counts[',']
  for (const k of [';', '\t']) {
    if (counts[k] > bestN) { best = k; bestN = counts[k] }
  }
  return best
}

function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let cur: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') { inQuotes = true; continue }
    if (ch === delimiter) { cur.push(field); field = ''; continue }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      cur.push(field); field = ''
      rows.push(cur); cur = []
      continue
    }
    field += ch
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur) }
  return rows.filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ''))
}

/** Summarize .ipynb notebook to a flat markdown-like text. */
export async function readIpynbFile(filePath: string): Promise<{
  content: string
  truncated: boolean
  originalChars: number
}> {
  const { content: raw } = await readTextFile(filePath)
  try {
    const nb = JSON.parse(raw) as { cells?: Array<{ cell_type?: string; source?: string | string[] }> }
    const parts: string[] = []
    for (const cell of nb.cells || []) {
      const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '')
      if (!src.trim()) continue
      if (cell.cell_type === 'code') {
        parts.push('```python\n' + src.replace(/\n+$/, '') + '\n```')
      } else {
        parts.push(src.replace(/\n+$/, ''))
      }
    }
    const joined = parts.join('\n\n')
    return truncate(joined)
  } catch {
    return truncate(raw)
  }
}
