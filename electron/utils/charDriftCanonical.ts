/**
 * Character canonicalizer + filesystem resolver for LLM token-drift tolerance.
 *
 * LLMs token-by-token generation drifts certain character classes
 * (upstream issues #52482 / #50975 / #31863):
 *   - Curly quotes `""''` → ASCII `"'` straight quotes
 *   - Fullwidth CJK punctuation `，。（）【】《》：；！？` → halfwidth ASCII
 *
 * Two strings have the **same on-screen meaning** iff their canonical forms
 * are byte-equal. This shared canonicalizer is reused by:
 *   - `workspaceState.resolvePathForTool` — to match user-supplied paths
 *     against disk-real directory/file names when characters drifted.
 *   - `workspaceAccess.resolvePathForWorkspaceAccess` — same, for renderer-
 *     side IPC file ops (Open File menu, file tree, …).
 *   - `advancedToolUtils.resolveSearchPath` — same, for glob / grep.
 *   - `fileEditSemantics.resolveOldStringInFile` — to match the model's
 *     `old_string` against the file body when the in-content characters
 *     drifted (the user's edit_file case on Chinese docs).
 *
 * This module deliberately lives under `electron/utils/` so all four
 * resolvers above can import without dragging cross-module dependencies.
 *
 * Conservatively does NOT include:
 *   - Hyphen / underscore / dot — universally used in ASCII form; including
 *     them would falsely match different filenames / strings.
 *   - Variation Selectors (U+FE00..U+FE0F) — required for emoji presentation.
 *
 * All listed drift targets are BMP single-code-unit chars, so the drift
 * substitutions themselves are 1:1 and length-preserving. The trailing
 * `.normalize('NFC')` in {@link canonicalizeForLlmDrift}, however, is NOT
 * length-preserving (it composes `base + combining mark` = 2 code units into
 * 1). That is fine for callers that only compare canonical forms for EQUALITY
 * (path matching, glob/grep), but it is UNSAFE for any caller that uses an
 * index into the canonical string to slice the ORIGINAL string — the NFC
 * length change shifts every later index and the slice lands on the wrong
 * bytes (silent edit corruption). Such callers (`resolveOldStringInFile`)
 * MUST use {@link canonicalizeForLlmDriftLengthPreserving}, which applies ONLY
 * the 1:1 drift substitutions and omits NFC, so canonical-space indices map
 * back onto the original 1:1.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * The 1:1, strictly length-preserving subset of {@link canonicalizeForLlmDrift}:
 * applies ONLY the single-BMP-code-unit drift substitutions (curly→straight
 * quotes, fullwidth→halfwidth punctuation) and does NOT run `.normalize('NFC')`.
 *
 * Because every substitution maps one code unit to one code unit, the output
 * has the SAME length as the input and `output[i]` originates from `input[i]`.
 * Callers that locate a match in canonical space and then slice the ORIGINAL
 * string by that index/length depend on this invariant.
 */
export function canonicalizeForLlmDriftLengthPreserving(s: string): string {
  return s
    .replaceAll('\u201C', '"').replaceAll('\u201D', '"')
    .replaceAll('\u2018', "'").replaceAll('\u2019', "'")
    .replaceAll('\uFF0C', ',')
    .replaceAll('\u3002', '.')
    .replaceAll('\uFF08', '(').replaceAll('\uFF09', ')')
    .replaceAll('\uFF1A', ':').replaceAll('\uFF1B', ';')
    .replaceAll('\uFF01', '!').replaceAll('\uFF1F', '?')
    .replaceAll('\u3010', '[').replaceAll('\u3011', ']')
    .replaceAll('\u300A', '<').replaceAll('\u300B', '>')
}

export function canonicalizeForLlmDrift(s: string): string {
  return canonicalizeForLlmDriftLengthPreserving(s).normalize('NFC')
}

/**
 * Component-wise drift-tolerant path resolution. Walks `absPath` segment by
 * segment; for any non-existing component, scans the parent directory for an
 * entry whose canonicalized form matches the canonicalized target and
 * substitutes the on-disk name. Returns the **disk-real path** on a complete
 * match, `null` when any component has no drift-tolerant sibling.
 *
 * Cost: at most one `readdirSync` per missing component, only on the miss
 * path. Steady-state (path exists literally) overhead is one `existsSync`.
 *
 * Safety: never escapes the original ancestor chain — only substitutes a
 * sibling that already lives in the parent directory we already resolved.
 * Workspace boundary checks downstream therefore still hold against the
 * drift-resolved output.
 */
export function resolveWithDriftFallback(absPath: string): string | null {
  if (fs.existsSync(absPath)) return absPath

  let root: string
  let rest: string
  if (/^[A-Za-z]:[\\/]/.test(absPath)) {
    root = absPath.slice(0, 3)
    rest = absPath.slice(3)
  } else if (absPath.startsWith('\\\\')) {
    return null
  } else if (absPath.startsWith('/') || absPath.startsWith('\\')) {
    root = path.sep
    rest = absPath.slice(1)
  } else {
    return null
  }

  if (!fs.existsSync(root)) return null

  const parts = rest.split(/[\\/]+/).filter(Boolean)
  let prefix = root
  for (const target of parts) {
    const direct = path.join(prefix, target)
    if (fs.existsSync(direct)) {
      prefix = direct
      continue
    }
    let entries: string[]
    try {
      entries = fs.readdirSync(prefix)
    } catch {
      return null
    }
    const targetCanon = canonicalizeForLlmDrift(target)
    const match = entries.find((e) => canonicalizeForLlmDrift(e) === targetCanon)
    if (!match) return null
    prefix = path.join(prefix, match)
  }
  return prefix
}
