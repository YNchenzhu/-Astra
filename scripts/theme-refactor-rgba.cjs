/**
 * Second pass: rewrite `rgba(R, G, B, A)` accent overlays to use the
 * `--*-rgb` CSS variables so translucent accents (hover glows, focus
 * rings, selection fills, badges) follow the active theme instead of
 * staying blue-ish in light mode.
 *
 * Only the Catppuccin Mocha accent triplets are rewritten — other ad-hoc
 * rgba() calls (e.g. drop shadows with 0,0,0) are preserved as-is.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', 'src')
const SKIP = new Set([path.resolve(ROOT, 'styles', 'global.css')])

// Accent name -> its dark-theme RGB channels.
const ACCENT_RGB = {
  blue:     [137, 180, 250],
  green:    [166, 227, 161],
  red:      [243, 139, 168],
  yellow:   [249, 226, 175],
  peach:    [250, 179, 135],
  mauve:    [203, 166, 247],
  teal:     [148, 226, 213],
  pink:     [245, 194, 231],
  lavender: [180, 190, 254],
}

// Helper — matches any whitespace in between tokens so rgba( 137 ,180,  250 ,0.3) still hits.
function buildRe(rgb) {
  const [r, g, b] = rgb
  return new RegExp(
    `rgba\\(\\s*${r}\\s*,\\s*${g}\\s*,\\s*${b}\\s*,\\s*([0-9.]+)\\s*\\)`,
    'gi',
  )
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.css')) out.push(p)
  }
  return out
}

// Ensure global.css declares the -rgb variables for every accent used below.
const GLOBAL = path.resolve(ROOT, 'styles', 'global.css')
const globalTxt = fs.readFileSync(GLOBAL, 'utf8')
for (const name of Object.keys(ACCENT_RGB)) {
  if (!globalTxt.includes(`--accent-${name}-rgb:`)) {
    console.warn(`[warn] global.css is missing --accent-${name}-rgb; rewrite will still reference it.`)
  }
}

let totalReplacements = 0
const filesTouched = []
for (const file of walk(ROOT)) {
  if (SKIP.has(path.resolve(file))) continue
  const original = fs.readFileSync(file, 'utf8')
  let updated = original
  let replacementsInFile = 0
  for (const [name, rgb] of Object.entries(ACCENT_RGB)) {
    const re = buildRe(rgb)
    updated = updated.replace(re, (_m, alpha) => {
      replacementsInFile++
      return `rgba(var(--accent-${name}-rgb), ${alpha})`
    })
  }
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
console.log(`\nTotal: ${totalReplacements} rgba replacements across ${filesTouched.length} files.`)
