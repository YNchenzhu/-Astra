/**
 * Lightweight path filtering for LSP locations (best-effort, not full gitignore spec).
 */

import fs from 'node:fs'
import path from 'node:path'

function readGitignorePatterns(repoRoot: string): string[] {
  const p = path.join(repoRoot, '.gitignore')
  if (!fs.existsSync(p)) return []
  try {
    const text = fs.readFileSync(p, 'utf-8')
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .slice(0, 200)
  } catch {
    return []
  }
}

function simplePatternMatches(relPosix: string, pattern: string): boolean {
  const p = pattern.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!p) return false
  if (p.endsWith('/')) {
    const dir = p.slice(0, -1)
    return (
      relPosix === dir ||
      relPosix.startsWith(`${dir}/`) ||
      relPosix.split('/').includes(dir)
    )
  }
  if (p.includes('*')) {
    const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    try {
      return new RegExp(`^${escaped}$`, 'i').test(relPosix) ||
        relPosix.split('/').some((seg) => new RegExp(`^${escaped}$`, 'i').test(seg))
    } catch {
      return false
    }
  }
  return (
    relPosix === p ||
    relPosix.startsWith(`${p}/`) ||
    relPosix.endsWith(`/${p}`) ||
    relPosix.includes(`/${p}/`)
  )
}

/**
 * Returns true if the absolute file path should be filtered out (gitignored / common noise).
 */
export function createLocationGitignoreFilter(repoRoot: string | undefined): (absPath: string) => boolean {
  const root = repoRoot?.trim()
    ? path.normalize(repoRoot.trim())
    : undefined
  const patterns = root ? readGitignorePatterns(root) : []

  return (absPath: string): boolean => {
    const n = path.normalize(absPath)
    if (n.split(path.sep).includes('node_modules')) return true
    if (n.includes(`${path.sep}.git${path.sep}`)) return true
    if (!root || !n.toLowerCase().startsWith(root.toLowerCase())) {
      return false
    }
    const rel = path.relative(root, n).split(path.sep).join('/')
    if (!rel || rel.startsWith('..')) return false
    for (const pat of patterns) {
      if (simplePatternMatches(rel, pat)) return true
    }
    return false
  }
}
