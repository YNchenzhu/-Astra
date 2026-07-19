/**
 * Compact summary fact-lint — post-summary output-side check
 * (2026-07 deep-loop uplift, item #11).
 *
 * ## Why
 *
 * The compact fact ledger (`compactFactLedger.ts`) hardens the INPUT side:
 * the summarizer receives host-counted tool-execution ground truth and is
 * instructed to mark unverified claims. But nothing checks the OUTPUT — a
 * summarizer that ignores the instruction can still launder an assistant
 * hallucination ("已修复 x.ts") into the authoritative post-compact
 * record. This module closes that half: after the summary text is
 * produced, every file path it mentions is checked against the summarized
 * window's ACTUAL tool activity (tool_use inputs + tool_result bodies).
 * Paths with no trace in either get a deterministic annotation appended
 * to the summary, so the next model reads "statements about these are
 * unverified" alongside the claim itself.
 *
 * ## Conservative by design
 *
 *   - Only ANNOTATES — never rewrites or deletes summary content.
 *   - A path counts as verified if the full normalized path OR its
 *     basename appears anywhere in the window's tool corpus (inputs or
 *     results). Basename fallback absorbs absolute-vs-relative and
 *     separator differences; false accusations are worse than misses.
 *   - Windows with zero tool_use are skipped entirely (pure-prose
 *     conversations have nothing to verify against).
 *   - Same extraction rules as the clamp relevance layer
 *     (`extractPathLikeTerms`), so "what counts as a path" is consistent
 *     across the context subsystem.
 *
 * Kill-switch: `POLE_COMPACT_SUMMARY_LINT=0`.
 */

import { extractPathLikeTerms } from './activeTaskRelevance'

type Msg = Record<string, unknown>
type Block = Record<string, unknown>

export const SUMMARY_FACT_CHECK_OPEN_TAG = '<summary-fact-check>'
export const SUMMARY_FACT_CHECK_CLOSE_TAG = '</summary-fact-check>'

/** Cap listed unverified paths so the annotation stays bounded. */
export const MAX_UNVERIFIED_PATHS_LISTED = 10

export function isCompactSummaryLintEnabled(): boolean {
  const raw = process.env.POLE_COMPACT_SUMMARY_LINT?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

function normalize(text: string): string {
  // Collapse runs of slashes: JSON.stringify escapes `\` as `\\`, which the
  // separator rewrite would otherwise turn into `//` and break matching.
  // Both the corpus AND the claimed terms run through this, so the
  // collapsed form is consistent on the two sides of every comparison.
  return text.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
}

function basenameOf(term: string): string {
  const parts = term.split('/')
  return parts[parts.length - 1] ?? term
}

/**
 * Build the lowercase corpus of everything the window's tools actually
 * touched or reported: tool_use inputs (stringified) + string
 * tool_result bodies. Returns `null` when the window contains no
 * tool_use at all (lint skipped). Exported for tests.
 */
export function buildToolActivityCorpus(
  messages: ReadonlyArray<Msg>,
): string | null {
  const parts: string[] = []
  let sawToolUse = false
  for (const msg of messages) {
    const content = msg.content
    if (!Array.isArray(content)) continue
    for (const block of content as Block[]) {
      if (msg.role === 'assistant' && block.type === 'tool_use') {
        sawToolUse = true
        try {
          parts.push(JSON.stringify(block.input ?? {}))
        } catch {
          /* unserializable input — skip */
        }
      } else if (msg.role === 'user' && block.type === 'tool_result') {
        if (typeof block.content === 'string') parts.push(block.content)
      }
    }
  }
  if (!sawToolUse) return null
  return normalize(parts.join('\n'))
}

/**
 * Lint the summary against the window's tool activity. Returns the
 * annotation block to append, or `''` when there is nothing to flag
 * (no path claims, all claims traceable, no tool activity, or disabled).
 */
export function buildSummaryFactLintAnnotation(
  summary: string,
  messages: ReadonlyArray<Msg>,
): string {
  if (!isCompactSummaryLintEnabled()) return ''
  if (!summary.trim()) return ''

  const corpus = buildToolActivityCorpus(messages)
  if (corpus === null) return ''

  const claimed = extractPathLikeTerms([summary])
  if (claimed.length === 0) return ''

  const unverified: string[] = []
  for (const term of claimed) {
    const t = normalize(term)
    if (corpus.includes(t)) continue
    const base = basenameOf(t)
    // Basename fallback — absolute-vs-relative / separator differences.
    // Require a real basename (with an extension dot) so a bare directory
    // fragment doesn't accidentally match everything.
    if (base && base.includes('.') && corpus.includes(base)) continue
    unverified.push(term)
  }
  if (unverified.length === 0) return ''

  const listed = unverified
    .slice(0, MAX_UNVERIFIED_PATHS_LISTED)
    .map((p) => `- ${p}`)
  const overflow =
    unverified.length > MAX_UNVERIFIED_PATHS_LISTED
      ? `\n- …and ${unverified.length - MAX_UNVERIFIED_PATHS_LISTED} more`
      : ''

  return [
    SUMMARY_FACT_CHECK_OPEN_TAG,
    '[Host fact-check — deterministic] The summary above mentions the following file path(s), but they never appeared in ANY tool call or tool result in the summarized window. Statements about them are UNVERIFIED narrative — do not treat them as completed work or established fact; re-verify with tools before relying on them:',
    ...listed,
    overflow.trim(),
    SUMMARY_FACT_CHECK_CLOSE_TAG,
  ]
    .filter(Boolean)
    .join('\n')
}
