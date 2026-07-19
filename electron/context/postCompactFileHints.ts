/**
 * upstream §4.3 / §17.4 — lightweight post-compact hints from prior tool outputs (not full file re-read).
 *
 * Path-extraction strategy (layered so we don't miss paths that only appear in
 * one form):
 *   1. JSON-shaped properties (Read / Edit / write_file tool_use inputs):
 *      `"path": "src/foo.ts"`, `"file_path": "..."`, etc.
 *   2. Code-reference style (`src/foo.ts:42`, `src/foo.ts:10-20`) — common in
 *      Grep output, stack traces, and linter diagnostics.
 *   3. Bare quoted / backticked paths (`` `src/foo.ts` ``, `'src/foo.ts'`) —
 *      common in Bash / tool result prose.
 *   4. Line-leading paths from `ls` / `find` output.
 *
 * Each layer feeds into a shared de-dup set so the cheapest / most
 * authoritative signal (JSON property) wins the display slot when the same
 * file appears multiple ways.
 */

import { POST_COMPACT_MAX_FILES_TO_RESTORE } from './openClaudeParityConstants'

const JSON_PATH_PROP_RE =
  /"(?:path|file_path|target_file|absolutePath|filePath|filepath|notebook_path)"\s*:\s*"((?:[^"\\]|\\.){1,800})"/gi

/**
 * Code reference style: `path/to/file.ext:line` or `path/to/file.ext:line-line`.
 * Recognizes Unix-style separators, Windows drive letters, dotted extensions.
 */
const CODE_REF_RE =
  /(?:(?<=^|[\s(`'"<>[])|(?<=[:=]))((?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|[A-Za-z0-9_\-.]+[\\/])[^\s:'"`<>[\]()]+\.[A-Za-z0-9]{1,6})(?::(\d+)(?:-\d+)?)?/g

/**
 * Quoted/backticked bare path: `` `src/foo.ts` `` or `'src/foo.ts'` or
 * `"src/foo.ts"` (without `:path` JSON key).
 */
const QUOTED_PATH_RE = /[`'"]((?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|[A-Za-z0-9_\-.]+[\\/])[A-Za-z0-9_\-./\\]*\.[A-Za-z0-9]{1,6})[`'"]/g

function decodeJsonPath(s: string): string {
  try {
    return JSON.parse(`"${s.replace(/\\"/g, '"')}"`) as string
  } catch {
    return s.replace(/\\"/g, '"')
  }
}

/**
 * Best-effort sanity check: reject path-like strings that are obviously not
 * filesystem paths (URLs, pure numbers, tokens that start with `--flag`, etc.).
 */
function isPlausibleFilePath(p: string): boolean {
  if (p.length < 2 || p.length > 1024) return false
  // Must contain at least one path separator or a file extension indicator.
  if (!/[./\\]/.test(p)) return false
  // Reject URLs.
  if (/^(?:https?|ftp|ws|file):\/\//i.test(p)) return false
  // Reject CLI flags.
  if (p.startsWith('--')) return false
  // Reject strings made of only punctuation or whitespace.
  if (!/[A-Za-z0-9]/.test(p)) return false
  return true
}

function pushIfNew(seen: Set<string>, out: string[], max: number, raw: string): boolean {
  const p = raw.trim()
  if (!isPlausibleFilePath(p)) return false
  if (seen.has(p)) return false
  seen.add(p)
  out.push(p)
  return out.length >= max
}

/**
 * Heuristic: pull unique file-like paths from serialized tool results.
 *
 * Covers:
 *   - Read / Edit / Write tool_use JSON inputs (`"file_path": "…"`)
 *   - Code-reference prose (`src/foo.ts:42`)
 *   - Quoted / backticked paths in tool_result text
 */
export function extractLikelyFilePathsFromMessages(
  messages: ReadonlyArray<Record<string, unknown>>,
  maxPaths: number = POST_COMPACT_MAX_FILES_TO_RESTORE,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of messages) {
    if (out.length >= maxPaths) break
    const c = m.content
    const blobs: string[] = []
    if (typeof c === 'string') {
      blobs.push(c)
    } else if (Array.isArray(c)) {
      for (const b of c) {
        const block = b as {
          type?: string
          content?: unknown
          text?: unknown
          input?: unknown
          name?: unknown
        }
        // tool_result strings
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          blobs.push(block.content)
        }
        // tool_result structured array-of-blocks
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const sub of block.content as Array<Record<string, unknown>>) {
            if (sub.type === 'text' && typeof sub.text === 'string') {
              blobs.push(sub.text)
            }
          }
        }
        // tool_use JSON input — capture as stringified so JSON regex works.
        if (block.type === 'tool_use' && block.input && typeof block.input === 'object') {
          try {
            blobs.push(JSON.stringify(block.input))
          } catch {
            /* ignore */
          }
        }
        // plain text blocks (rare but possible)
        if (block.type === 'text' && typeof block.text === 'string') {
          blobs.push(block.text)
        }
      }
      if (blobs.length === 0) {
        try {
          blobs.push(JSON.stringify(c))
        } catch {
          /* ignore unserialisable content */
        }
      }
    } else {
      blobs.push(String(c ?? ''))
    }
    const blob = blobs.join('\n')

    // Layer 1 — JSON property matches (highest confidence).
    let jm: RegExpExecArray | null
    JSON_PATH_PROP_RE.lastIndex = 0
    while ((jm = JSON_PATH_PROP_RE.exec(blob))) {
      if (pushIfNew(seen, out, maxPaths, decodeJsonPath(jm[1]))) break
    }
    if (out.length >= maxPaths) break

    // Layer 2 — code reference style.
    let cr: RegExpExecArray | null
    CODE_REF_RE.lastIndex = 0
    while ((cr = CODE_REF_RE.exec(blob))) {
      if (pushIfNew(seen, out, maxPaths, cr[1])) break
    }
    if (out.length >= maxPaths) break

    // Layer 3 — quoted / backticked bare paths.
    let qm: RegExpExecArray | null
    QUOTED_PATH_RE.lastIndex = 0
    while ((qm = QUOTED_PATH_RE.exec(blob))) {
      if (pushIfNew(seen, out, maxPaths, qm[1])) break
    }
    if (out.length >= maxPaths) break
  }
  return out
}

export function buildPostCompactFileHintUserMessage(paths: string[]): string | null {
  if (!paths.length) return null
  const lines = paths.map((p) => `- \`${p}\``).join('\n')
  return `[Post-compact context — paths recently seen in tool output before compaction. Re-read with Read if still relevant:]\n${lines}`
}
