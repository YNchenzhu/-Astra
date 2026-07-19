/**
 * AC-7.4 — SendMessage target routing (broadcast / team / mailbox / in-process bridge vs UDS).
 *
 * External filesystem UDS is not wired in Electron; `uds:astra:<id>` is an in-process alias (same delivery as `bridge:`).
 */

export type SendMessageRouteKind =
  | 'broadcast_all'
  | 'team_broadcast'
  | 'direct_active'
  | 'mailbox_durable'
  | 'bridge_in_process'
  | 'unsupported_uds'

export type ParsedSendMessageTarget =
  | { kind: 'broadcast_all'; raw: '*' }
  | { kind: 'team_broadcast'; teamName: string; raw: string }
  | { kind: 'mailbox_durable'; agentKey: string; raw: string }
  | { kind: 'bridge_in_process'; targetId: string; raw: string }
  | { kind: 'unsupported_uds'; raw: string }
  | { kind: 'direct_active'; raw: string }

const TEAM_PREFIX = 'team:'
const MAILBOX_PREFIX = 'mailbox:'
const BRIDGE_PREFIX = 'bridge:'
const UDS_PREFIX = 'uds:'
/** Product-local UDS path — same delivery as `bridge_in_process`. */
const UDS_ASTRA_PREFIX = 'uds:astra:'

/**
 * Parse `to` after `team:` / `*` have been handled by the caller, or pass full string for non-team routes.
 */
export function parseSendMessageTarget(to: string): ParsedSendMessageTarget {
  const t = (to || '').trim()
  if (t === '*') return { kind: 'broadcast_all', raw: '*' }

  const lower = t.toLowerCase()
  if (lower.startsWith(TEAM_PREFIX)) {
    return { kind: 'team_broadcast', teamName: t.slice(TEAM_PREFIX.length).trim(), raw: t }
  }
  if (lower.startsWith(UDS_ASTRA_PREFIX)) {
    const targetId = t.slice(UDS_ASTRA_PREFIX.length).trim()
    // P1-8: refuse to silently rewrite an empty `uds:astra:` target into a
    // global broadcast. Previously this leaked through as `targetId='*'`,
    // turning a typo into a fan-out to every running agent. The caller must
    // explicitly use `*` if it wants broadcast.
    if (!targetId) return { kind: 'unsupported_uds', raw: t }
    return { kind: 'bridge_in_process', targetId, raw: t }
  }
  if (lower.startsWith(UDS_PREFIX)) {
    return { kind: 'unsupported_uds', raw: t }
  }
  if (lower.startsWith(MAILBOX_PREFIX)) {
    return { kind: 'mailbox_durable', agentKey: t.slice(MAILBOX_PREFIX.length).trim(), raw: t }
  }
  if (lower.startsWith(BRIDGE_PREFIX)) {
    const targetId = t.slice(BRIDGE_PREFIX.length).trim()
    // P1-8: same as above — `bridge:` with no id is not a broadcast shortcut.
    // Return `unsupported_uds` so the caller surfaces a proper error string
    // to the model instead of silently fanning out.
    if (!targetId) return { kind: 'unsupported_uds', raw: t }
    return { kind: 'bridge_in_process', targetId, raw: t }
  }
  return { kind: 'direct_active', raw: t }
}

export function sendMessageRouteDescription(): string {
  return (
    'Routes: `*` = broadcast all running agents; `team:<name>` = team broadcast + TeamFile; ' +
    '`mailbox:<agentId>` = durable TeamFile queue only (needs team_name / context team); ' +
    '`bridge:<id|name>` = in-process bridge (same as direct; OC external bridge analogue); ' +
    '`uds:astra:<id|name>` = same in-process delivery as bridge; other `uds:` paths are not supported.'
  )
}
