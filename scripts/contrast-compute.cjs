/**
 * Compute precise WCAG contrast ratios for (fg, bg) pairs declared in the
 * theme variables so we can verify AA compliance programmatically.
 */

function srgbToLinear(c) {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
function luminance(hex) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b)
  const hi = Math.max(la, lb), lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}
function verdict(ratio) {
  if (ratio >= 7) return '✓ AAA'
  if (ratio >= 4.5) return '✓ AA'
  if (ratio >= 3) return '~ AA-large'
  return '✗ fail'
}

const themes = {
  dark: {
    'bg-base':     '#1e1e2e',
    'bg-surface':  '#181825',
    'text-primary':'#cdd6f4',
    'text-muted':  '#6c7086',
    'text-on-accent':'#11111b',
    'accent-blue': '#89b4fa',
    'accent-red':  '#f38ba8',
    'accent-green':'#a6e3a1',
    'status-success':'#22c55e',
    'status-warning':'#f59e0b',
    'status-danger': '#ef4444',
  },
  light: {
    'bg-base':     '#f6f7fb',
    'bg-surface':  '#ffffff',
    'text-primary':'#1d2433',
    'text-muted':  '#5a6578',
    'text-on-accent':'#ffffff',
    'accent-blue': '#3b5fe0',
    'accent-red':  '#c53030',
    'accent-green':'#16a34a',
    'status-success':'#16a34a',
    'status-warning':'#d97706',
    'status-danger': '#dc2626',
  },
  cursor: {
    'bg-base':     '#1e1e1e',
    'bg-surface':  '#181818',
    'text-primary':'#e4e4e4',
    'text-muted':  '#858585',
    'text-on-accent':'#0e0e0e',
    'accent-blue': '#4a9eff',
    'accent-red':  '#f48771',
    'accent-green':'#89d185',
    'status-success':'#4caf50',
    'status-warning':'#cca700',
    'status-danger': '#f44747',
  },
}

const pairs = [
  // Buttons using the adaptive --text-on-accent foreground
  ['on-accent-fg-on-accent-blue',  'text-on-accent', 'accent-blue'],
  // Raw white text on solid accent (used by some components before refactor)
  ['white-text-on-accent-blue',    '#ffffff',        'accent-blue'],
  ['white-text-on-status-danger',  '#ffffff',        'status-danger'],
  ['white-text-on-status-success', '#ffffff',        'status-success'],
  ['white-text-on-status-warning', '#ffffff',        'status-warning'],
  // Primary body text on base
  ['text-primary-on-base',         'text-primary',   'bg-base'],
  ['text-primary-on-surface',      'text-primary',   'bg-surface'],
  ['text-muted-on-base',           'text-muted',     'bg-base'],
  // Accent as text (link/icon) on base
  ['accent-blue-on-base',          'accent-blue',    'bg-base'],
  ['accent-red-on-base',           'accent-red',     'bg-base'],
  ['accent-green-on-base',         'accent-green',   'bg-base'],
]

for (const [name, vars] of Object.entries(themes)) {
  console.log(`\n=== theme: ${name} ===`)
  for (const [label, fg, bg] of pairs) {
    const fgHex = fg.startsWith('#') ? fg : vars[fg]
    const bgHex = bg.startsWith('#') ? bg : vars[bg]
    if (!fgHex || !bgHex) { console.log(`  ${label}: SKIP (missing)`); continue }
    const r = contrast(fgHex, bgHex)
    console.log(`  ${label.padEnd(35)} ${fgHex} on ${bgHex}  =>  ${r.toFixed(2)}:1  ${verdict(r)}`)
  }
}
