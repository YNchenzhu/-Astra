/**
 * upstream report Phase 2 Step 5 — getMessagesAfterCompactBoundary.
 *
 * Extracts messages after the most recent compaction boundary marker,
 * avoiding re-processing of already-compacted history.
 *
 * A "compact boundary" is identified by a message containing the compact summary
 * marker (e.g. "[Previous conversation was compacted...") or a specific _type field.
 */

import { SIDE_CHANNEL_KIND } from '../constants/sideChannelKinds'

const COMPACT_BOUNDARY_MARKERS = [
  '[Previous conversation was compacted',
  '[Context compacted',
  '[Conversation summary',
] as const

/**
 * Find the index of the last compaction boundary in the message array.
 * Returns -1 if no boundary is found (i.e., no compaction has occurred).
 */
export function findLastCompactBoundaryIndex(
  messages: Array<Record<string, unknown>>,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]

    if (
      msg._type === 'compact_boundary' ||
      msg._compactBoundary === true ||
      msg._sideChannelKind === SIDE_CHANNEL_KIND.compactSummary
    ) {
      return i
    }

    // Marker text used to live at the very start of `content`, so `startsWith`
    // worked. Once autoCompact began wrapping the marker in
    // `<system-reminder>...</system-reminder>` (compact.ts), the marker moved
    // off byte 0 and `startsWith` stopped matching. We use `includes` here as
    // a tolerant substring check; the metadata-flag path above
    // (`_type === 'compact_boundary'`) is the canonical detector for new
    // compactions, this string check only exists as a defensive fallback for
    // legacy / non-canonical compact emissions.
    const content = msg.content
    if (typeof content === 'string') {
      if (COMPACT_BOUNDARY_MARKERS.some((marker) => content.includes(marker))) {
        return i
      }
    }

    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (COMPACT_BOUNDARY_MARKERS.some((marker) => (block.text as string).includes(marker))) {
            return i
          }
        }
      }
    }
  }

  return -1
}

/**
 * Get messages after the most recent compact boundary.
 * If no boundary exists, returns all messages (no compaction has occurred).
 * The boundary message itself is included in the result.
 */
export function getMessagesAfterCompactBoundary(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const idx = findLastCompactBoundaryIndex(messages)
  if (idx < 0) return messages
  return messages.slice(idx)
}

/**
 * Check whether any compaction has occurred in the message history.
 */
export function hasCompactBoundary(
  messages: Array<Record<string, unknown>>,
): boolean {
  return findLastCompactBoundaryIndex(messages) >= 0
}

/**
 * Create a compact boundary marker message.
 * Inserted by the compaction system after generating a summary.
 *
 * When `transcriptPath` is supplied, an extra hint is appended telling
 * the model it may `Read` the pre-compact transcript JSON to recover
 * details the lossy summary didn't preserve. Mirrors the same hint
 * `autoCompact` splices into its boundary user message (compact.ts).
 */
export function createCompactBoundaryMarker(
  summary: string,
  transcriptPath?: string,
): Record<string, unknown> {
  const transcriptHint = transcriptPath
    ? `\n\nIf you need exact details not preserved above (verbatim code snippets, error messages, generator output, etc.), Read the full pre-compact transcript at: ${transcriptPath}`
    : ''
  return {
    role: 'user',
    content: `[Previous conversation was compacted to save context. Summary:\n${summary}]${transcriptHint}`,
    _type: 'compact_boundary',
    _compactBoundary: true,
    _compactedAt: Date.now(),
  }
}
