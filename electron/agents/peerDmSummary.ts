/**
 * peer DM summary — scan a teammate's recent transcript for the most recent
 * `SendMessage` tool_use whose target is another teammate (not the lead and
 * not a broadcast), then format `"[to <name>] <summary>"`.
 *
 * Surfaced inside `idle_notification.metadata.peerDmSummary` so the team
 * lead can passively see who its members are talking to each round without
 * the full DM body showing up in lead context.
 *
 * Reference implementation: upstream-main
 * `src/utils/teammateMailbox.ts:1149-1182` (`getLastPeerDmSummary`).
 *
 * The function is intentionally tolerant of unknown content shapes — the
 * agentic loop occasionally passes through partial / provider-specific
 * blocks, and a peer DM scrape MUST NOT crash the idle notifier.
 */

const LEAD_NAMES = new Set<string>(['team-lead', 'lead', 'leader'])
const BROADCAST_NAMES = new Set<string>(['*', 'broadcast', 'all'])
const SEND_MESSAGE_TOOL_NAMES = new Set<string>(['SendMessage', 'send_message'])
const MAX_SUMMARY_CHARS = 200

export interface PeerDmTranscriptEntry {
  role: string
  content: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}

function extractTo(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  return pickString(input.to)
}

/**
 * Pull the human-meaningful body out of a SendMessage tool_use input.
 * Prefers `summary` (matches upstream-main's convention), falls back to
 * `message`, then `payload`. Truncates aggressively.
 */
function extractBody(input: unknown): string {
  if (!isRecord(input)) return ''
  const candidates = [input.summary, input.message, input.payload]
  for (const c of candidates) {
    const s = pickString(c)
    if (s) {
      return s.length > MAX_SUMMARY_CHARS ? `${s.slice(0, MAX_SUMMARY_CHARS - 1)}…` : s
    }
  }
  return ''
}

/**
 * @returns `"[to <name>] <summary>"` for the most recent peer DM in the
 * transcript, or `null` when no qualifying SendMessage was found.
 *
 * Selection rules (mirroring `[ref:upstream:src/utils/teammateMailbox.ts:1149-1182]`):
 *
 *   - walk **assistant** messages from newest → oldest
 *   - inside each, walk `content` blocks (skip any provider that delivered
 *     a `content: string`, which never carries tool_use)
 *   - keep only `tool_use` blocks whose `name` is `SendMessage` /
 *     `send_message`
 *   - skip broadcasts (`to === '*'` etc.) and messages addressed to the
 *     lead — those are not peer-to-peer collaboration
 *   - the first match wins
 */
export function getLastPeerDmSummary(
  messages: ReadonlyArray<PeerDmTranscriptEntry>,
): string | null {
  if (!messages || messages.length === 0) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'assistant') continue
    const content = m.content
    if (!Array.isArray(content)) continue
    // Inside the same assistant message we still want the LAST SendMessage
    // (the model may have called multiple in one turn) — walk back-to-front.
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j]
      if (!isRecord(block)) continue
      if (block.type !== 'tool_use') continue
      const name = pickString(block.name)
      if (!name || !SEND_MESSAGE_TOOL_NAMES.has(name)) continue
      const to = extractTo(block.input)
      if (!to) continue
      if (BROADCAST_NAMES.has(to.toLowerCase())) continue
      // Strip `mailbox:` / `bridge:` / `uds:astra:` / `team:` route
      // prefixes so the displayed recipient is just the human name/id.
      const cleanedTo = to
        .replace(/^mailbox:/i, '')
        .replace(/^bridge:/i, '')
        .replace(/^uds:astra:/i, '')
        .replace(/^team:/i, '')
        .trim()
      if (!cleanedTo) continue
      if (LEAD_NAMES.has(cleanedTo.toLowerCase())) continue
      const body = extractBody(block.input)
      return body ? `[to ${cleanedTo}] ${body}` : `[to ${cleanedTo}]`
    }
  }
  return null
}
