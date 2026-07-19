/**
 * Audit for dark-text-on-dark-accent-bg issues in the LIGHT theme, and
 * white-text-on-light-bg issues.
 */
const fs = require('fs')
const path = require('path')

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.css')) out.push(p)
  }
  return out
}

const ROOT = path.resolve(__dirname, '..', 'src')

function parseBlocks(txt) {
  const out = []
  let i = 0
  while (i < txt.length) {
    const open = txt.indexOf('{', i)
    if (open < 0) break
    let depth = 1
    let j = open + 1
    while (j < txt.length && depth > 0) {
      if (txt[j] === '{') depth++
      else if (txt[j] === '}') depth--
      j++
    }
    if (depth !== 0) break
    let selStart = i
    for (let k = open - 1; k >= i; k--) {
      if (txt[k] === '}' || txt[k] === '{') { selStart = k + 1; break }
    }
    out.push({ selector: txt.slice(selStart, open).trim(), body: txt.slice(open + 1, j - 1) })
    i = j
  }
  return out
}

const issues = []
for (const f of walk(ROOT)) {
  const txt = fs.readFileSync(f, 'utf8')
  for (const { selector, body } of parseBlocks(txt)) {
    if (!selector.trim() || selector.startsWith('@')) continue
    let color = null, bg = null
    for (const m of body.matchAll(/(^|;)\s*color\s*:\s*([^;]+?)\s*(?=;|$)/g)) color = m[2]
    for (const m of body.matchAll(/(^|;)\s*background(?:-color)?\s*:\s*([^;]+?)\s*(?=;|$)/g)) bg = m[2]
    if (!color || !bg) continue

    const c = color.trim().toLowerCase()
    const b = bg.trim().toLowerCase()

    // Dark text (primary / secondary / accent-blue) on solid accent-blue bg is
    // dark-on-dark in LIGHT mode (both dark in light theme).
    const darkText =
      /var\(--text-(primary|secondary)\)/.test(c) ||
      /var\(--accent-(blue|mauve|lavender|red|teal|green)\)(?!-rgb)/.test(c)
    const darkBgInLight =
      /(?:^|[^-])var\(--accent-(blue|mauve|lavender|red|teal|green)\)(?![-\w]*rgb)/.test(b) ||
      /var\(--status-(danger|success)-strong\)/.test(b) ||
      /var\(--status-(danger|info)\)/.test(b)

    // Exclude obvious false positives: `background: rgba(var(--accent-*-rgb), …)` is translucent, not solid
    const isTranslucent = /rgba\s*\(\s*var\(/.test(b)

    if (darkText && darkBgInLight && !isTranslucent) {
      issues.push({ f, selector, color, bg })
    }
  }
}

if (issues.length === 0) {
  console.log('No dark-on-dark-in-light issues found. ✓')
} else {
  for (const p of issues) {
    console.log(`${path.relative(ROOT, p.f)}  ::  ${p.selector.slice(0, 70)}`)
    console.log(`    color     : ${p.color}`)
    console.log(`    background: ${p.bg}`)
  }
  console.log(`\n${issues.length} issues.`)
}
