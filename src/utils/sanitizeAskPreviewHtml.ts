/**
 * Strip risky tags/attributes from AskUserQuestion HTML previews before `dangerouslySetInnerHTML`.
 * Complements main-process `validateHtmlPreview` in `electron/tools/AskUserQuestionTool.ts`.
 */
const DISALLOWED_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
])

export function sanitizeAskUserPreviewHtml(html: string): string {
  if (!html.trim()) return ''
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') return ''

  try {
    const doc = new DOMParser().parseFromString(`<div id="ask-preview-root">${html}</div>`, 'text/html')
    const root = doc.getElementById('ask-preview-root')
    if (!root) return ''

    function cleanElement(el: Element): void {
      const tag = el.tagName.toLowerCase()
      if (DISALLOWED_TAGS.has(tag)) {
        el.remove()
        return
      }
      const attrs = [...el.attributes]
      for (const attr of attrs) {
        const n = attr.name.toLowerCase()
        if (n.startsWith('on')) {
          el.removeAttribute(attr.name)
          continue
        }
        if ((n === 'href' || n === 'src' || n === 'xlink:href') && /^\s*javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name)
        }
      }
      for (const child of [...el.children]) {
        cleanElement(child)
      }
    }

    for (const child of [...root.children]) {
      cleanElement(child)
    }
    return root.innerHTML
  } catch {
    return ''
  }
}
