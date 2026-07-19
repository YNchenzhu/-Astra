/**
 * Placeholder-ellipsis detection + safe auto-expansion.
 *
 * The #1 failure pattern for agentic Edit calls is `old_string` containing a
 * literal `...` / `…` ellipsis: the model abbreviates a long code span with a
 * placeholder expecting the tool to pattern-match. We deliberately do NOT —
 * a partial-match Edit would silently clobber unrelated code. Instead we:
 *
 *   1. Detect placeholder ellipses (boundary-aware: legitimate JS/TS spread
 *      `(...args)`, `[...arr]`, `{ ...obj }` and Python stubs `def f(): ...`
 *      must pass through untouched).
 *   2. When a placeholder is present, *try* to open the target file and
 *      auto-expand using globally-unique prefix/suffix anchors. If the
 *      expansion is unambiguous, surface it to the agent as a ready-to-paste
 *      `SUGGESTED old_string`. Otherwise fall back to a plain "read_file
 *      first" instruction.
 *
 * This module is the single source of truth for that gate so the single-edit
 * tool ({@link toolEditFile}) and the multi-edit tool
 * ({@link toolMultiEditFile}) apply identical rules — drift between the two
 * would let the model bypass the placeholder gate by switching tools.
 *
 * Pure functions only. No state, no module-level side effects.
 */

import fs from 'node:fs'
import { resolvePathForTool } from '../tools/workspaceState'
import { stripUtf8Bom } from '../utils/lineEndings'

/**
 * Matches `...` only when it looks like a placeholder, NOT when it is part of
 * legitimate syntax:
 *
 *   matches:    ` ... `, `\n...\n`, `// ...`, `# ...`, `/* ...`, `<!-- ...`
 *   does NOT:   `(...args)`, `[...arr]`, `{ ...obj }`, `foo(...x)`,
 *               `function f(...rest)`, `Array(3).fill(...)`
 *
 * The leading boundary consumes the flanker (whitespace or comment marker);
 * the trailing boundary is a lookahead so it doesn't shift the match index.
 */
const PLACEHOLDER_ASCII_ELLIPSIS_RE = /(?:^|\s|\/\/\s*|#\s*|\/\*\s*|<!--\s*)\.{3}(?=\s|$|\*\/|-->)/
// upstream alignment Part 1: UNICODE_ELLIPSIS_RE removed — detectPlaceholderEllipsis
// no longer reads it (it now always returns null). countPlaceholderEllipses
// still uses an inline `/…/g` regex when called from tryReadAndExpand, which
// is now unreachable from the hot paths but kept for source compatibility.

export interface DetectedEllipsis {
  /** Display kind for the error message. */
  kind: '...' | '…'
  /** Index into the input string where the ellipsis itself (not its boundary) starts. */
  index: number
  /** 3 for ASCII, 1 for Unicode. */
  length: number
}

/**
 * upstream alignment stage 0 / Part 1:
 *
 * upstream's FileEditTool has NO placeholder-ellipsis detection — it relies on
 * exact byte matching alone. The original gate here was too eager (the unicode
 * branch in particular rejected legitimate Chinese `……` ellipses common in
 * legal / policy documents, forcing the agent into shell-based workarounds).
 *
 * Aligning to upstream: this detector now always returns null. The exact-byte
 * match in `findActualString` is the single source of truth for whether an
 * `old_string` resolves; placeholders that don't resolve simply fail with a
 * "exact match not found" error, exactly as in upstream.
 *
 * The ASCII boundary regex and the unicode regex stay declared (above) so
 * existing tests that import / reference them keep their imports valid, and
 * so future maintainers can re-enable the gate by reverting this function
 * to the previous body if needed.
 *
 * Note: `tryReadAndExpand` and `buildEllipsisError` remain exported because
 * call sites still reference them — they are now unreachable from the
 * single-edit / multi-edit hot paths (the `if (detected) { ... }` branches
 * dead-code-eliminate when `detected` is always null).
 */
export function detectPlaceholderEllipsis(_text: string): DetectedEllipsis | null {
  return null
}

function countPlaceholderEllipses(text: string): number {
  const ascii = text.match(new RegExp(PLACEHOLDER_ASCII_ELLIPSIS_RE.source, 'g'))
  const unicode = text.match(/…/g)
  return (ascii?.length ?? 0) + (unicode?.length ?? 0)
}

const MIN_ANCHOR_NONWS_LEN = 5
const MAX_SUGGESTED_OLD_STRING_LEN = 5000

/**
 * Best-effort: open the target file (if it exists) and use the prefix-before-
 * ellipsis / suffix-after-ellipsis as **globally unique** anchors to extract
 * the intervening bytes. Returns the expanded `old_string` candidate, or null
 * when expansion is unsafe (file missing, anchors non-unique, multiple
 * placeholders, replaceAll mode, expansion too large).
 *
 * "Globally unique" means each anchor occurs exactly once in the file, and
 * the suffix occurs exactly once *after* the prefix's match. Without both
 * uniqueness conditions the expansion would be ambiguous and we MUST NOT
 * suggest it — silently clobbering an unrelated span is exactly the
 * failure mode this gate is designed to prevent.
 */
export function tryReadAndExpand(
  filePath: string,
  oldString: string,
  detected: DetectedEllipsis,
  replaceAll: boolean,
): string | null {
  // replaceAll + placeholder is fundamentally ambiguous — the AI is asking
  // "replace many spans, each with different middles" which is regex-style,
  // not byte-exact. Refuse to suggest.
  if (replaceAll) return null

  // Multiple placeholders → no single anchor pair, can't expand safely.
  if (countPlaceholderEllipses(oldString) > 1) return null

  const prefix = oldString.slice(0, detected.index)
  const suffix = oldString.slice(detected.index + detected.length)
  // Each anchor needs enough non-whitespace mass to be specific. Pure
  // whitespace anchors match too many places.
  if (prefix.replace(/\s+/g, '').length < MIN_ANCHOR_NONWS_LEN) return null
  if (suffix.replace(/\s+/g, '').length < MIN_ANCHOR_NONWS_LEN) return null

  const resolveResult = resolvePathForTool(filePath)
  if (!resolveResult.ok) return null
  const resolvedPath = resolveResult.resolved
  if (!fs.existsSync(resolvedPath)) return null
  let disk: string
  try {
    disk = fs.readFileSync(resolvedPath, 'utf-8')
  } catch {
    return null
  }
  const { body } = stripUtf8Bom(disk)

  // Prefix must occur exactly once in the file.
  const prefixStart = body.indexOf(prefix)
  if (prefixStart === -1) return null
  if (body.indexOf(prefix, prefixStart + 1) !== -1) return null

  // Suffix must occur exactly once in the slice AFTER the prefix.
  const tail = body.slice(prefixStart + prefix.length)
  const suffixStart = tail.indexOf(suffix)
  if (suffixStart === -1) return null
  if (tail.indexOf(suffix, suffixStart + 1) !== -1) return null

  const between = tail.slice(0, suffixStart)
  const expanded = prefix + between + suffix
  if (expanded.length > MAX_SUGGESTED_OLD_STRING_LEN) return null
  // Sanity: the expanded result must of course no longer contain the
  // placeholder itself (otherwise the agent retries, hits the gate again).
  if (detectPlaceholderEllipsis(expanded)) return null
  return expanded
}

export function buildEllipsisError(detected: DetectedEllipsis, expanded: string | null): string {
  const head =
    `old_string contains "${detected.kind}" — Edit does exact byte matching, ` +
    `it does NOT expand placeholders.`
  if (!expanded) {
    return (
      head +
      ' Replace the ellipsis with the exact intervening file content ' +
      '(use read_file first to copy it verbatim).'
    )
  }
  return [
    head,
    '',
    'Auto-extracted a globally-unique prefix-and-suffix span from the target ' +
      'file. Retry with this exact old_string, copied verbatim from disk ' +
      '(read_file is not required — the bytes below are authoritative):',
    '----- BEGIN SUGGESTED old_string -----',
    expanded,
    '----- END SUGGESTED old_string -----',
  ].join('\n')
}
