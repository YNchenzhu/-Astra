/**
 * Shared "Did you mean ...?" fuzzy error formatter for path-taking tools.
 *
 * History: `list_files` (`electron/ai/toolListFiles.ts`) grew a rich
 * "not found, here's the deepest existing parent + closest sibling + the
 * subdirectories that DO exist" formatter that lets the model self-correct
 * in one turn. Other path-taking tools (`excel_*`, `glob`, `write_file`'s
 * missing-parent branch) returned bare "file not found" / "Directory not
 * found" strings, forcing the model to either give up or guess again.
 *
 * This module factors that logic out so every tool produces the same shape
 * of structured error. Drop-in: callers pass `{ inputPath, resolvedPath,
 * workspace, kind }` and get a `formatToolError`-compatible payload.
 *
 * Companion to `workspaceState.ts`'s `resolveWithDriftFallback` (which
 * handles the curly-quote / fullwidth-punctuation drift transparently).
 * The fuzzy formatter here is the LAST-LINE fallback for cases where
 * drift fallback couldn't find a sibling either — e.g. the path really
 * doesn't exist, or the typo is more than a quote substitution away.
 */

import fs from 'node:fs'
import path from 'node:path'

import { buildToolFailure, type ToolFailureFields } from './toolErrorFormat'

/** Walk `start` up the parent chain until a directory that actually exists is found. */
export function findExistingParentDir(start: string): string | undefined {
  let current = path.resolve(start)
  while (true) {
    const parent = path.dirname(current)
    if (parent === current) return undefined
    try {
      if (fs.existsSync(parent) && fs.statSync(parent).isDirectory()) return parent
    } catch {
      /* ignore — keep climbing */
    }
    current = parent
  }
}

/**
 * List entries of `dir` (no recursion). Hidden + node_modules filtered.
 * Directories always carry a trailing `/` regardless of `filter` so callers
 * (and the model reading the rendered error) can distinguish them visually.
 */
export function listDirEntries(
  dir: string,
  filter: 'dirs' | 'files' | 'both' = 'both',
): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => {
        if (e.name.startsWith('.') || e.name === 'node_modules') return false
        if (filter === 'dirs') return e.isDirectory()
        if (filter === 'files') return e.isFile()
        return true
      })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/** Iterative Levenshtein distance. Exported for the edit_file baseReadId path-recovery check. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const prev = new Array<number>(b.length + 1)
  const curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]
  }
  return prev[b.length]
}

/**
 * Find the closest sibling name to `target` among `candidates`. Three tiers:
 *   1. Case-insensitive exact match.
 *   2. Prefix relationship either direction.
 *   3. Levenshtein edit distance ≤ 2.
 *
 * Returns null when nothing rises to the bar — caller falls back to dumping
 * the parent's entry list so the model can pick visually.
 */
export function findClosestName(target: string, candidates: string[]): string | null {
  const lower = target.toLowerCase()
  for (const c of candidates) {
    if (c.toLowerCase() === lower) return c
  }
  for (const c of candidates) {
    const cl = c.toLowerCase()
    if (cl.startsWith(lower) || lower.startsWith(cl)) return c
  }
  let best: { name: string; dist: number } | null = null
  for (const c of candidates) {
    const d = editDistance(c.toLowerCase(), lower)
    if (d <= 2 && (!best || d < best.dist)) best = { name: c, dist: d }
  }
  return best ? best.name : null
}

export interface FuzzyNotFoundArgs {
  /** Tool name to prefix the headline ("excel_read_workbook", "glob", …). */
  toolName: string
  /** What kind of thing was missing — affects the headline + entry filter. */
  kind: 'file' | 'directory'
  /** The user-supplied path verbatim (for the headline). */
  inputPath: string
  /** Absolute resolved path that we actually tried (for `Tried:`). */
  resolvedPath: string
  /** Workspace root (optional — used to render relative paths in suggestions). */
  workspace: string | undefined
  /** Extra "next" instructions to append after the fuzzy suggestions. */
  extraNext?: string[]
}

/**
 * Build a "Did you mean ...?" structured failure payload for a not-found
 * path. Callers should `spread` the result onto a `ToolResult` shape:
 *
 *     return { success: false, ...buildFuzzyNotFoundError({...}) }
 *
 * Audit fix D1: returns the full {@link ToolFailureFields} (carrying
 * `error` + `errorWhat / errorTried / errorContext / errorNext` +
 * `toolErrorClass: 'not_found'`) so the structured-error UI can render
 * the recovery hints as a bulleted list and the post-execution
 * classifier preserves the tool's self-declared class. Previously this
 * helper returned a flat string and every "did you mean" failure
 * surfaced as a raw `<pre>` blob in the renderer.
 */
export function buildFuzzyNotFoundError(args: FuzzyNotFoundArgs): ToolFailureFields {
  const { toolName, kind, inputPath, resolvedPath, workspace, extraNext } = args
  const target = path.basename(resolvedPath)
  const parentDir = findExistingParentDir(resolvedPath)
  // `kind` decides what to surface inside the parent listing — for `file`
  // misses we list both files and dirs (the leaf might have been a dir
  // misnamed as a file or vice versa). For `directory` misses we list only
  // dirs (matches old list_files behavior).
  const filter = kind === 'directory' ? 'dirs' : 'both'
  const entries = parentDir ? listDirEntries(parentDir, filter) : []
  // For closest-name match, strip trailing `/` we appended to directory
  // names so the Levenshtein compare doesn't pay 1 extra distance per dir.
  const entriesBare = entries.map((e) => (e.endsWith('/') ? e.slice(0, -1) : e))
  const closest = findClosestName(target, entriesBare)

  const nextLines: string[] = []

  if (closest) {
    const correctedAbs = path.join(parentDir!, closest)
    const correctedRel = workspace
      ? path.relative(workspace, correctedAbs).replace(/\\/g, '/')
      : correctedAbs
    const trailingSlash = entries.includes(`${closest}/`) ? '/' : ''
    nextLines.push(
      `Did you mean "${correctedRel}${trailingSlash}"? It is the closest existing ${kind} under the same parent. Retry ${toolName} with that path.`,
    )
  }

  if (parentDir && entries.length > 0) {
    const parentRel = workspace
      ? path.relative(workspace, parentDir).replace(/\\/g, '/') || '.'
      : parentDir
    const visible = entries.slice(0, 30)
    const heading = kind === 'directory' ? 'Subdirectories' : 'Entries'
    nextLines.push(
      `${heading} that DO exist under "${parentRel}/" ` +
        `(deepest existing ancestor of your input):` +
        visible.map((n) => `\n    - ${parentRel === '.' ? n : `${parentRel}/${n}`}`).join('') +
        (entries.length > visible.length ? `\n    … and ${entries.length - visible.length} more` : ''),
    )
  } else if (parentDir) {
    const parentRel = workspace
      ? path.relative(workspace, parentDir).replace(/\\/g, '/') || '.'
      : parentDir
    nextLines.push(
      `The deepest existing ancestor "${parentRel}/" has no ${kind === 'directory' ? 'subdirectories' : 'entries'}. ` +
        `Your input may be off by more than one path component.`,
    )
  }

  if (extraNext && extraNext.length > 0) {
    nextLines.push(...extraNext)
  }

  return buildToolFailure(
    {
      what: `${toolName}: ${kind} not found: ${inputPath}`,
      tried: [resolvedPath],
      context: { workspace: workspace ?? '(none)' },
      next: nextLines,
    },
    'not_found',
  )
}
