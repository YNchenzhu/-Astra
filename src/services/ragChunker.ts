/**
 * Text chunker for RAG indexing.
 *
 * Goal: split long attachment text into ~2k-char chunks with soft boundaries
 * that preserve meaning (Markdown headings, paragraphs, blank-line groups,
 * sentence ends). Guarantees:
 *   - Chunk target ≈ TARGET, never exceeds MAX.
 *   - Consecutive chunks overlap by `OVERLAP` chars so adjacent topics aren't
 *     split mid-sentence when a user's query lands on the boundary.
 *   - Original order preserved via `index`.
 */

export interface ChunkOut {
  index: number
  text: string
  meta: {
    offset: number
    length: number
    headingPath?: string
  }
}

const TARGET = 1800
const MAX = 2400
const OVERLAP = 180

/**
 * Split on paragraph / list boundaries first, then sentence boundaries if a
 * paragraph alone exceeds MAX. Headings are tracked so each chunk's meta
 * carries a cursor-friendly `H1 > H2 > H3` breadcrumb.
 */
export function chunkText(text: string): ChunkOut[] {
  if (!text) return []
  const paras = splitParagraphs(text)
  const out: ChunkOut[] = []
  let buf = ''
  let bufOffset = 0
  let cursorOffset = 0
  const heading: Record<number, string> = {}

  const flush = () => {
    if (!buf.trim()) { buf = ''; return }
    const breadcrumb = formatBreadcrumb(heading)
    // Hard MAX cap: `buf` can transiently exceed MAX when an overlap tail
    // (≤ OVERLAP) is prepended to a near-MAX unit before the next packing
    // check runs (the threshold check compares the pre-reseed buffer). Slice
    // any oversized buffer into ≤ MAX pieces so the documented "never exceeds
    // MAX" contract always holds. In the common case (`buf.length ≤ MAX`) this
    // is a single piece — identical to the previous behavior.
    let pieceOffset = bufOffset
    for (let i = 0; i < buf.length; i += MAX) {
      const piece = buf.slice(i, i + MAX)
      out.push({
        index: out.length,
        text: piece,
        meta: {
          offset: pieceOffset,
          length: piece.length,
          ...(breadcrumb ? { headingPath: breadcrumb } : {}),
        },
      })
      pieceOffset += piece.length
    }
    if (buf.length > OVERLAP) {
      // Start the next chunk with a tail of the current one for continuity.
      buf = buf.slice(-OVERLAP)
      bufOffset = cursorOffset - buf.length
    } else {
      buf = ''
      bufOffset = cursorOffset
    }
  }

  for (const p of paras) {
    // Track heading structure.
    const h = detectHeading(p.text)
    if (h) {
      heading[h.level] = h.title
      for (const k of Object.keys(heading).map(Number)) {
        if (k > h.level) delete heading[k]
      }
    }

    if (p.text.length > MAX) {
      // Break long paragraph into sentences and pack.
      const sents = splitSentences(p.text)
      let subOffset = p.offset
      for (const s of sents) {
        if (buf.length + s.length + 1 > MAX) flush()
        if (buf.length === 0) bufOffset = subOffset
        buf += (buf && !buf.endsWith('\n') ? ' ' : '') + s
        cursorOffset = subOffset + s.length
        subOffset += s.length + 1
      }
      continue
    }

    // Normal paragraph packing.
    if (buf.length + p.text.length + 2 > TARGET && buf.length > 0) {
      flush()
    }
    if (buf.length === 0) bufOffset = p.offset
    buf += (buf ? '\n\n' : '') + p.text
    cursorOffset = p.offset + p.text.length
  }
  flush()
  return out
}

function splitParagraphs(text: string): Array<{ text: string; offset: number }> {
  const re = /([^\n]+(?:\n(?!\n)[^\n]+)*)/g
  const out: Array<{ text: string; offset: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const p = m[0].trim()
    if (!p) continue
    out.push({ text: p, offset: m.index })
  }
  return out
}

function splitSentences(p: string): string[] {
  // Pragmatic CJK+latin sentence split.
  // `"` carries no regex meaning inside a character class; escaping it with
  // `\"` is a valid string escape but an **invalid regex escape** under the
  // `/u` flag (ES2018 strict mode). Use the bare character instead. Same
  // story for `)` — inside `[...]` it's a literal.
  const parts = p.split(/(?<=[。！？!?.]|[。！？!?.]["'」）)])\s+/u).filter(Boolean)
  // Fall back to hard cut if any chunk is still way too long.
  const out: string[] = []
  for (const part of parts) {
    if (part.length <= MAX) { out.push(part); continue }
    for (let i = 0; i < part.length; i += MAX) out.push(part.slice(i, i + MAX))
  }
  return out
}

function detectHeading(p: string): { level: number; title: string } | null {
  const m = /^(#{1,6})\s+(.+?)\s*$/m.exec(p.split('\n', 1)[0] || '')
  if (!m) return null
  return { level: m[1].length, title: m[2] }
}

function formatBreadcrumb(heading: Record<number, string>): string {
  return [1, 2, 3, 4, 5, 6]
    .map((k) => heading[k])
    .filter((s): s is string => !!s)
    .join(' > ')
}
