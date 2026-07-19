/**
 * Convert rich HTML clipboard content (from 飞书 / 钉钉 / Notion / Office Online /
 * Google Docs / GitHub / web pages) into GitHub-flavored Markdown.
 *
 * We use this to turn a paste of complex content — especially tables and
 * bulleted outlines — into a Markdown attachment so the model sees the
 * structure, not just the stripped `text/plain` fallback.
 */

import TurndownService from 'turndown'

let svc: TurndownService | null = null

function getService(): TurndownService {
  if (svc) return svc
  const s = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    linkStyle: 'inlined',
  })

  // GitHub-flavored table support (Turndown doesn't ship tables by default).
  s.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const table = node as HTMLTableElement
      const rows = Array.from(table.querySelectorAll('tr'))
      if (rows.length === 0) return ''
      const cellsOf = (row: Element) =>
        Array.from(row.querySelectorAll('th, td')).map((c) =>
          (c.textContent || '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'),
        )
      const header = cellsOf(rows[0])
      const body = rows.slice(1).map(cellsOf)
      const maxCols = Math.max(header.length, ...body.map((r) => r.length))
      const padded = (r: string[]) => {
        while (r.length < maxCols) r.push('')
        return r
      }
      const lines: string[] = []
      lines.push(`| ${padded(header).join(' | ')} |`)
      lines.push(`| ${Array(maxCols).fill('---').join(' | ')} |`)
      for (const r of body) lines.push(`| ${padded(r).join(' | ')} |`)
      return `\n\n${lines.join('\n')}\n\n`
    },
  })

  // Strip Google Docs's <b> wrapper which messes up outline detection.
  s.addRule('gdocsBWrapper', {
    filter: (node) => node.nodeName === 'B' && (node as HTMLElement).id?.startsWith('docs-internal-guid'),
    replacement: (content) => content,
  })

  // Fenced code with language hint (Notion / Feishu embed <pre data-language>).
  s.addRule('codeBlock', {
    filter: (node) => node.nodeName === 'PRE' && !!node.firstChild && node.firstChild.nodeName === 'CODE',
    replacement: (_content, node) => {
      const pre = node as HTMLElement
      const code = pre.querySelector('code')
      const lang =
        (code?.className.match(/language-(\w+)/) || [])[1] ||
        pre.getAttribute('data-language') ||
        ''
      const text = (code?.textContent || '').replace(/\n$/, '')
      return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`
    },
  })

  // Remove clipboard noise (empty <span>, comments, tracking pixels).
  s.remove(['script', 'style', 'meta', 'link', 'iframe', 'noscript'])

  svc = s
  return s
}

export interface RichPasteSummary {
  markdown: string
  hasTable: boolean
  hasStructure: boolean
  originalLength: number
}

/**
 * Heuristic: does this HTML fragment carry structure that plain-text paste
 * would lose? Returns `true` for tables, multi-item lists, heading trees,
 * or code blocks. Simple one-line rich text (e.g. a bold word pasted from
 * a webpage) is deliberately excluded so we don't hijack trivial pastes.
 */
export function isRichStructuredHtml(html: string): boolean {
  if (!html) return false
  // Cheap string-level check first — avoids building a DOM for plain text.
  if (!/<(table|ul|ol|pre|h[1-6]|blockquote)\b/i.test(html)) return false
  const doc = parseHtml(html)
  if (!doc) return false
  if (doc.querySelector('table')) return true
  if (doc.querySelector('pre code')) return true
  const lis = doc.querySelectorAll('li').length
  if (lis >= 3) return true
  const headings = doc.querySelectorAll('h1,h2,h3,h4,h5,h6').length
  if (headings >= 2) return true
  return false
}

export function convertHtmlToMarkdown(html: string): RichPasteSummary {
  const svc = getService()
  const md = svc.turndown(html)
  return {
    markdown: md.replace(/\n{3,}/g, '\n\n').trim(),
    hasTable: /\|.+\|\n\|[\s:|-]+\|/.test(md),
    hasStructure: /^#+\s|\n-\s|\n\d+\.\s|```/.test(md),
    originalLength: html.length,
  }
}

function parseHtml(html: string): Document | null {
  try {
    const parser = new DOMParser()
    return parser.parseFromString(html, 'text/html')
  } catch {
    return null
  }
}
