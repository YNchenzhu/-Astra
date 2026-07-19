/**
 * One-shot refactor: replace hard-coded Catppuccin / Tailwind colour literals
 * across all component CSS files with CSS variables defined in
 * `src/styles/global.css`. This makes the `light` theme actually cover the
 * whole UI (previously many components used the hex values directly, so the
 * theme toggle only recoloured ~20% of the app).
 *
 * Safe to re-run — matches are idempotent (once replaced, the hex is gone
 * and the replacement uses `var(...)` syntax which won't match again).
 *
 * Scope: walks `src/**\/*.css` but skips `src/styles/global.css` so that the
 * theme definitions themselves remain intact. Also skips lines that already
 * define a CSS custom property.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', 'src')
const SKIP = new Set([path.resolve(ROOT, 'styles', 'global.css')])

// Literal hex colour → var replacement. Order matters only within same prefix.
// Colour names follow Catppuccin Mocha; a handful of status colours map to
// tailwind-ish equivalents that were used inconsistently across panels.
const MAPPINGS = [
  // Text scale
  ['#cdd6f4', 'var(--text-primary)'],
  ['#a6adc8', 'var(--text-secondary)'],
  ['#bac2de', 'var(--text-secondary)'],
  ['#6c7086', 'var(--text-muted)'],
  ['#7f849c', 'var(--text-muted)'],
  ['#585b70', 'var(--text-subtext)'],
  ['#9399b2', 'var(--text-overlay)'],
  // Surfaces
  ['#1e1e2e', 'var(--bg-base)'],
  ['#181825', 'var(--bg-surface)'],
  ['#11111b', 'var(--bg-overlay)'],
  ['#313244', 'var(--bg-surface0)'],
  ['#45475a', 'var(--bg-surface1)'],
  // Borders / states already had vars
  ['#383b50', 'var(--border-color)'],
  ['#35384c', 'var(--hover-bg)'],
  ['#4a4d66', 'var(--active-bg)'],
  ['#4d506a', 'var(--selection-bg)'],
  // Catppuccin accents
  ['#89b4fa', 'var(--accent-blue)'],
  ['#a6e3a1', 'var(--accent-green)'],
  ['#f38ba8', 'var(--accent-red)'],
  ['#f9e2af', 'var(--accent-yellow)'],
  ['#fab387', 'var(--accent-peach)'],
  ['#cba6f7', 'var(--accent-mauve)'],
  ['#94e2d5', 'var(--accent-teal)'],
  ['#f5c2e7', 'var(--accent-pink)'],
  ['#b4befe', 'var(--accent-lavender)'],
  ['#89dceb', 'var(--text-info)'],
  // Tailwind-ish status colours used in places
  ['#22c55e', 'var(--status-success)'],
  ['#16a34a', 'var(--status-success-strong)'],
  ['#4ade80', 'var(--status-success)'],
  ['#ef4444', 'var(--status-danger)'],
  ['#f87171', 'var(--status-danger)'],
  ['#c62828', 'var(--status-danger-strong)'],
  ['#f59e0b', 'var(--status-warning)'],
  ['#eab308', 'var(--status-warning)'],
  ['#3b82f6', 'var(--status-info)'],
  ['#2563eb', 'var(--status-info)'],
  ['#60a5fa', 'var(--accent-blue)'],
  ['#93c5fd', 'var(--accent-blue)'],
]

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.css')) out.push(p)
  }
  return out
}

let totalReplacements = 0
const filesTouched = []

for (const file of walk(ROOT)) {
  if (SKIP.has(path.resolve(file))) continue
  const original = fs.readFileSync(file, 'utf8')
  let updated = ''
  let replacementsInFile = 0

  for (const rawLine of original.split(/\r?\n/)) {
    // Don't rewrite CSS custom-property *declarations* — those intentionally
    // carry literal colour values. Matches `--foo: ...` (after trim).
    if (/^\s*--[a-zA-Z0-9_-]+\s*:/.test(rawLine)) {
      updated += rawLine + '\n'
      continue
    }
    let line = rawLine
    for (const [hex, varRef] of MAPPINGS) {
      // Match hex followed by a non-hex-word boundary (so #89b4fa doesn't
      // partial-match against #89b4fabc if that ever appears).
      const re = new RegExp(hex.replace('#', '#') + '(?![0-9a-fA-F])', 'gi')
      line = line.replace(re, (match) => {
        replacementsInFile++
        return varRef
      })
    }
    updated += line + '\n'
  }

  // Normalise trailing newline to match original (avoid spurious diffs on
  // files that didn't end with \n before).
  if (!original.endsWith('\n')) updated = updated.replace(/\n$/, '')

  if (replacementsInFile > 0 && updated !== original) {
    fs.writeFileSync(file, updated, 'utf8')
    totalReplacements += replacementsInFile
    filesTouched.push({ file: path.relative(ROOT, file), n: replacementsInFile })
  }
}

filesTouched.sort((a, b) => b.n - a.n)
for (const { file, n } of filesTouched) {
  console.log(`${String(n).padStart(4)}  ${file}`)
}
console.log(`\nTotal: ${totalReplacements} replacements across ${filesTouched.length} files.`)
