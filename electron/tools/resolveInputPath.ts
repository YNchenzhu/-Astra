/**
 * Shared path-argument resolver for file-accepting tools (read_file,
 * write_file, edit_file, list_files, glob, grep, …).
 *
 * Motivation: every tool used to re-implement "resolve this path string to
 * a real on-disk location" differently:
 *   - Some used `path.resolve(cwd)` which resolves against the main
 *     process's cwd (the Electron install dir — almost never what the AI
 *     means).
 *   - Some used `getWorkspacePath()` as a fallback only when no arg was
 *     passed.
 *   - Some swallowed errors, some returned "Directory not found" even
 *     when the real cause was "wrong workspace".
 *
 * This helper centralizes the policy:
 *
 *   1. Absolute paths → used verbatim.
 *   2. Relative paths → resolved against the workspace root FIRST, then
 *      against `process.cwd()` as a legacy fallback. Whichever exists wins.
 *   3. Accept directories, files, or either (depending on caller's intent).
 *   4. On failure, return a {@link formatToolError}-shaped error that tells
 *      the model exactly which candidates we tried and what the workspace
 *      root is — so the next-turn fix is "change the path", not "guess".
 */

import fs from 'node:fs'
import path from 'node:path'
import { getWorkspacePath } from './workspaceState'
import { buildToolFailure, type ToolFailureFields } from './toolErrorFormat'

export type PathKind = 'file' | 'directory'

export interface ResolveInputPathOptions {
  /**
   * What kind of target the caller expects. When specified, mismatch becomes
   * an actionable error pointing to the right tool.
   *   - 'file': read_file, edit_file, web_fetch (file URLs), …
   *   - 'directory': list_files, glob base, …
   *   - omitted ("either"): grep, path normalization helpers, …
   */
  expect?: PathKind
  /**
   * When `expect: 'directory'` but a file is passed, cite this alternative
   * tool name in the error message so the model knows where to go next.
   * Example: expect='directory', altForFile='read_file'.
   */
  altForFile?: string
  /**
   * When `expect: 'file'` but a directory is passed, cite this alternative
   * tool name in the error message.
   * Example: expect='file', altForDirectory='list_files'.
   */
  altForDirectory?: string
  /**
   * Name of the tool calling the resolver — used in error headlines.
   * Defaults to 'tool'.
   */
  toolName?: string
  /**
   * Name of the argument in question (e.g. 'filePath', 'dirPath', 'path',
   * 'cwd'). Used in error messages so the model knows which field to
   * adjust on retry. Defaults to 'path'.
   */
  argName?: string
}

export interface ResolvedInputPath {
  ok: true
  /** Absolute, normalized on-disk path. */
  resolved: string
  /** Detected file/dir kind. */
  kind: PathKind
}

/**
 * Audit fix D1: extends {@link ToolFailureFields} so callers can spread
 * the rejection directly onto a `ToolResult` and get the structured
 * "Tried / Next" sections rendered as styled regions instead of grep-ing
 * the flat `error` string. Legacy callers that only read `r.error`
 * continue to work — that field is inherited from `ToolFailureFields`.
 */
export interface ResolveInputPathError extends ToolFailureFields {
  ok: false
}

export type ResolveInputPathResult = ResolvedInputPath | ResolveInputPathError

/**
 * Resolve a caller-supplied path argument.
 *
 * On success: returns `{ ok: true, resolved, kind }`.
 * On failure: returns `{ ok: false, error }` where `error` is a multi-line
 * actionable message suitable for returning directly to the model.
 */
export function resolveInputPath(
  rawPath: string | null | undefined,
  options: ResolveInputPathOptions = {},
): ResolveInputPathResult {
  const argName = options.argName ?? 'path'
  const toolName = options.toolName ?? 'tool'

  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return {
      ok: false,
      ...buildToolFailure(
        {
          what: `${toolName}: \`${argName}\` is missing or empty.`,
          next: `Supply a file ${options.expect === 'directory' ? 'or directory ' : ''}path.`,
        },
        'validation',
      ),
    }
  }

  const trimmed = rawPath.trim()
  const workspace = getWorkspacePath()
  const tried: string[] = []

  // Build the candidate list in the order we'll probe on disk.
  const candidates: string[] = []
  if (path.isAbsolute(trimmed)) {
    candidates.push(trimmed)
  } else {
    if (workspace) candidates.push(path.resolve(workspace, trimmed))
    candidates.push(path.resolve(trimmed))
  }

  // Dedupe — when workspace == process.cwd() (common in tests) both
  // candidates collapse into one.
  const seen = new Set<string>()
  const uniqCandidates = candidates.filter((c) => {
    const key = c.replace(/\\/g, '/').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  for (const cand of uniqCandidates) {
    tried.push(cand)
    if (!fs.existsSync(cand)) continue
    let st: fs.Stats
    try {
      st = fs.statSync(cand)
    } catch {
      continue
    }

    const kind: PathKind = st.isDirectory() ? 'directory' : 'file'

    if (options.expect && kind !== options.expect) {
      const alt =
        options.expect === 'file' ? options.altForDirectory : options.altForFile
      const wasDir = kind === 'directory'
      return {
        ok: false,
        ...buildToolFailure(
          {
            what:
              wasDir
                ? `${toolName}: \`${argName}\` is a directory, but this tool reads files.`
                : `${toolName}: \`${argName}\` is a file, but this tool expects a directory.`,
            tried: [cand],
            next: alt
              ? `Use the \`${alt}\` tool instead, or pass a ${options.expect} path.`
              : `Pass a ${options.expect} path.`,
          },
          'validation',
        ),
      }
    }

    return { ok: true, resolved: cand, kind }
  }

  return {
    ok: false,
    ...buildToolFailure(
      {
        what: `${toolName}: \`${argName}\` not found: ${trimmed}`,
        tried,
        context: {
          workspace: workspace ?? '(none)',
          platform: process.platform,
        },
        next: workspace
          ? 'Use a path relative to the workspace root, an absolute path, or omit to search the whole workspace.'
          : 'No workspace is open; pass an absolute path.',
      },
      'not_found',
    ),
  }
}
