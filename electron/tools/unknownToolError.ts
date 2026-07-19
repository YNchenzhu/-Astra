/**
 * Unified formatter for "Unknown tool" dispatch failures.
 *
 * When a model emits a tool_use whose `name` does not exist in the registry
 * (typo like `globb` → `glob`, hallucinated name like `read_filee`,
 * legacy/snake_case the alias table doesn't cover), the agentic loop must
 * return an error message that lets the model self-correct on the NEXT turn
 * without re-prompting the user.
 *
 * Three callers historically produced subtly different strings:
 *   - `electron/tools/registry.ts`             — appended a comma-joined
 *                                                full list of available tools
 *   - `electron/ai/runAgenticToolUseBody.ts`   — bare `Unknown tool: <name>`
 *                                                (NO list, NO suggestion)
 *   - `src/stores/useToolRegistry.ts`          — bare `Unknown tool: <name>`
 *
 * The middle one is on the production hot-path (`runAgenticLoop`), so by
 * default the model saw the WORST-quality variant and had nothing to base
 * a correction on.
 *
 * This module is the single source of truth for that error. It produces the
 * structured `formatToolError({ what, tried, next })` shape the rest of the
 * codebase already uses for tool failures.
 */

import { buildToolFailure, type ToolFailureFields } from './toolErrorFormat'

/**
 * Suggestions are emitted only when the typo is "obviously close" — a small
 * Levenshtein distance. The threshold scales with attempt length so a
 * 4-letter name (`Read`) doesn't get matched against an unrelated 4-letter
 * name (`Edit`) just because their distances happen to be ≤ 2. The cap
 * matches the heuristic GitHub CLI / Cargo / Rustup use for "did you mean?".
 */
const ABSOLUTE_DISTANCE_CAP = 3

/**
 * The fully-rendered list of available tools is too long to embed in every
 * error (sub-agents alone can hit 60+ tool names with MCP servers attached).
 * We cap the inline preview and tell the model to call `ToolSearch` for the
 * full surface — the same fallback the other error formatters point at.
 */
const INLINE_LIST_LIMIT = 40

/**
 * Pure Levenshtein distance (iterative, two-row buffer). Case-insensitive —
 * the input is lower-cased by the caller before calling. Kept tiny on
 * purpose: this runs on every Unknown-tool error and once per candidate.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let prev = new Array<number>(b.length + 1)
  let next = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    next[0] = i
    const ai = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1
      next[j] = Math.min(
        next[j - 1]! + 1, // insertion
        prev[j]! + 1, // deletion
        prev[j - 1]! + cost, // substitution
      )
    }
    const tmp = prev
    prev = next
    next = tmp
  }
  return prev[b.length]!
}

/** Distance threshold tightens for short names — 1-edit max for ≤4 chars. */
function maxDistanceFor(attemptLen: number): number {
  if (attemptLen <= 4) return 1
  if (attemptLen <= 7) return 2
  return ABSOLUTE_DISTANCE_CAP
}

/**
 * Find the candidate tool name closest to `attempted` (case-insensitive).
 * Returns `null` when nothing is close enough to be a confident suggestion.
 *
 * Ties are broken by:
 *   1. shorter Levenshtein distance
 *   2. exact case-insensitive prefix match (`globb` should prefer `glob`
 *      over `grep` when both are distance-1 — but only `glob` is a prefix)
 *   3. sort order, for deterministic output
 */
export function findClosestToolName(
  attempted: string,
  candidates: readonly string[],
): string | null {
  const trimmed = attempted.trim()
  if (!trimmed) return null
  const attemptLower = trimmed.toLowerCase()
  const limit = maxDistanceFor(attemptLower.length)

  let best: { name: string; distance: number; isPrefix: boolean } | null = null
  for (const candidate of candidates) {
    if (!candidate) continue
    const candLower = candidate.toLowerCase()
    const d = levenshtein(attemptLower, candLower)
    if (d > limit) continue
    const isPrefix =
      candLower.startsWith(attemptLower) || attemptLower.startsWith(candLower)
    if (
      !best ||
      d < best.distance ||
      (d === best.distance && isPrefix && !best.isPrefix) ||
      (d === best.distance &&
        isPrefix === best.isPrefix &&
        candidate < best.name)
    ) {
      best = { name: candidate, distance: d, isPrefix }
    }
  }
  return best ? best.name : null
}

/**
 * Build the structured Unknown-tool error string fed back to the model.
 *
 * @param attempted — the raw `tool_use.name` the model emitted (do NOT
 *                    pre-canonicalise; we want the error to surface the
 *                    exact spelling that failed).
 * @param available — the registry's currently-registered primary tool names
 *                    (e.g. `toolRegistry.list()`). MUST include MCP-bridged
 *                    names so cross-server typos are still suggested.
 */
export function formatUnknownToolError(
  attempted: string,
  available: readonly string[],
): ToolFailureFields {
  const suggestion = findClosestToolName(attempted, available)

  // Stable sort for the inline preview so the same registry shape always
  // produces the same error string — easier to test, easier to diff in logs.
  const sorted = [...available].sort((a, b) => a.localeCompare(b))
  const preview = sorted.slice(0, INLINE_LIST_LIMIT)
  const overflow = sorted.length - preview.length

  const next: string[] = []
  if (suggestion) {
    next.push(
      `Did you mean "${suggestion}"? (closest registered tool to "${attempted}")`,
    )
  }
  next.push(
    overflow > 0
      ? `Available tools (${sorted.length} total, first ${preview.length} shown): ${preview.join(', ')}, … call ToolSearch for the full list.`
      : `Available tools (${sorted.length}): ${preview.join(', ')}`,
  )
  next.push(
    'Re-emit the tool_use with the correct `name` from the list above; do not invent tool names.',
  )

  return buildToolFailure(
    {
      what: `Unknown tool: ${attempted}`,
      tried: [`tool_use.name="${attempted}"`],
      next,
    },
    'not_found',
  )
}
