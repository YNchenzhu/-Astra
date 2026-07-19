/**
 * Memory age utilities — adapted from upstream for cursor-ui-clone.
 *
 * Provides staleness reasoning helpers. Models are poor at date arithmetic —
 * a raw ISO timestamp doesn't trigger staleness reasoning the way "47 days ago" does.
 */

import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'

/** Days elapsed since mtime, floor-rounded. Negative inputs clamp to 0. */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000))
}

/** Human-readable age string for memory freshness display. */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  return `${d} days ago`
}

/**
 * Plain-text staleness caveat for memories >1 day old.
 * Returns '' for fresh memories.
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return ''
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  )
}

/**
 * Per-memory staleness note wrapped in `<system-reminder>` (kind
 * {@link SIDE_CHANNEL_KIND.memoryAgeNote}). Returns '' for fresh memories.
 * Trailing newline preserves the original spacing contract for embedders.
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs)
  if (!text) return ''
  return `${wrapSideChannelBody(SIDE_CHANNEL_KIND.memoryAgeNote, text)}\n`
}
