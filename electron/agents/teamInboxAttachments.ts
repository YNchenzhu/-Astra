/**
 * teamInboxAttachments — lead-side reader for the team mailbox.
 *
 * Takes raw mailbox lines (as produced by `appendTeamMailbox` /
 * `formatTeamMailboxEnvelopeLine`), parses them via the inter-agent
 * protocol, folds same-agent idle notifications down to the latest, and
 * renders a `<team-inbox>` XML block that the lead's agentic loop
 * injects as a `team_inbox` side-channel user message.
 *
 * Reference implementation: upstream-main
 * `src/utils/teammateMailbox.ts:3611-3660` (merge + dedup + same-agent
 * fold) and the rendering style established by
 * `electron/agents/coordinatorSystemPrompt.ts:88-137`.
 *
 * The two halves are split intentionally: the renderer is a pure
 * function so unit tests don't need disk; the runtime helper
 * `readAndRenderTeamInbox` adds the IO boundary (mailbox read +
 * consume).
 */

import {
  parseTeamInterAgentLineWithRecord,
  stripMailboxLineTimestamp,
} from './teamInterAgentProtocol'
import type { TeamInterAgentKind, TeamInterAgentMessage } from './teamInterAgentProtocol'
import { readAndClearTeamMailbox } from '../tools/teamMailbox'
import { consumeShutdownResponses } from './teamShutdownResponseHandler'

export interface ParsedInboxItem {
  /** The protocol message (kind + detail + from + …). */
  readonly message: TeamInterAgentMessage
  /** Outer envelope `from` field — typically equal to message.from.agentId. */
  readonly envelopeFrom?: string
  /** Outer envelope `metadata` block (e.g. peerDmSummary, completedTaskIds). */
  readonly envelopeMetadata?: Record<string, unknown>
  /**
   * Inner protocol object's own `metadata` (task_assignment /
   * task_completion put their structured payload here per the Zod
   * schema in `teamInterAgentProtocol.ts`).
   */
  readonly innerMetadata?: Record<string, unknown>
  /** Receive timestamp from the envelope's leading `[ISO]` prefix, when present. */
  readonly receivedAt?: number
}

const SUPPORTED_KINDS: ReadonlySet<TeamInterAgentKind> = new Set<TeamInterAgentKind>([
  'idle_notification',
  'task_assignment',
  'task_completion',
])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseLeadingTimestamp(line: string): number | undefined {
  const m = /^\[([^\]]+)]\s+/.exec(line.trim())
  if (!m) return undefined
  const t = Date.parse(m[1])
  return Number.isFinite(t) ? t : undefined
}

/**
 * Audit 2026-06 (lead-side mailbox data loss) — non-protocol mailbox
 * line preserved for rendering instead of being consumed-and-dropped.
 *
 * The mailbox read in {@link readAndRenderTeamInbox} is CONSUMPTIVE
 * (`readAndClearTeamMailbox`): any line we fail to render is deleted
 * from disk forever. The old `parseInboxLines` silently dropped
 *   1. free-form `SendMessage` envelopes — the very lines a teammate
 *      writes when reporting its final result to the lead (`fallback.
 *      kind === 'lead'` in `sendMessageTool.ts` promises "the lead
 *      reads it through the next <team-inbox> digest"), and
 *   2. protocol kinds outside {@link SUPPORTED_KINDS} (e.g.
 *      `plan_approval_request`, rejected `shutdown_response`s),
 * which broke the team → main-agent result path outright: the member's
 * report was erased from disk and never reached the lead's context.
 */
export interface FreeformInboxItem {
  /** Envelope `from` (or protocol sender) — `undefined` for bare lines. */
  readonly from?: string
  /** Envelope `type` (e.g. `result`) or the unsupported protocol `kind`. */
  readonly envType?: string
  /** Message body (payload / detail / raw line), capped at {@link FREEFORM_BODY_MAX_CHARS}. */
  readonly body: string
  readonly receivedAt?: number
}

/** Hard cap per free-form body so one giant payload can't flood the lead's turn. */
const FREEFORM_BODY_MAX_CHARS = 4000

function capFreeformBody(body: string): string {
  if (body.length <= FREEFORM_BODY_MAX_CHARS) return body
  return `${body.slice(0, FREEFORM_BODY_MAX_CHARS)}\n…[truncated ${body.length - FREEFORM_BODY_MAX_CHARS} chars]`
}

export interface ParsedInboxLines {
  items: ParsedInboxItem[]
  freeform: FreeformInboxItem[]
}

/**
 * Parse a batch of mailbox lines. Protocol lines with a supported kind
 * land in `items`; everything else that carries content (free-form
 * SendMessage envelopes, plain lines, unsupported protocol kinds) lands
 * in `freeform` so the consumptive reader can still surface it.
 *
 * Pure: no IO, no `getWorkspacePath()` lookups. Safe to call from
 * tests with hand-built mailbox lines.
 */
export function parseInboxLinesDetailed(lines: ReadonlyArray<string>): ParsedInboxLines {
  const items: ParsedInboxItem[] = []
  const freeform: FreeformInboxItem[] = []
  for (const line of lines) {
    if (typeof line !== 'string' || !line.trim()) continue
    const receivedAt = parseLeadingTimestamp(line)

    // The outer envelope record (timestamp + from + to + metadata wrap)
    // lives in the line itself, NOT in `parsed.record` — that record is
    // the inner protocol object. Re-parse the line's outer envelope.
    const stripped = stripMailboxLineTimestamp(line)
    let envelopeFrom: string | undefined
    let envelopeMetadata: Record<string, unknown> | undefined
    let envelopeType: string | undefined
    let envelopePayload: string | undefined
    let outerIsJson = false
    try {
      if (stripped.startsWith('{')) {
        const outer = JSON.parse(stripped) as unknown
        if (isRecord(outer)) {
          outerIsJson = true
          if (typeof outer.from === 'string') envelopeFrom = outer.from
          if (isRecord(outer.metadata)) envelopeMetadata = outer.metadata
          if (typeof outer.type === 'string') envelopeType = outer.type
          if (typeof outer.payload === 'string') envelopePayload = outer.payload
        }
      }
    } catch {
      /* outer parse failure is benign — handled by the freeform branch */
    }

    const parsed = parseTeamInterAgentLineWithRecord(line)
    if (parsed && SUPPORTED_KINDS.has(parsed.message.kind)) {
      const innerMetadata = isRecord(parsed.record.metadata)
        ? parsed.record.metadata
        : undefined
      items.push({
        message: parsed.message,
        ...(envelopeFrom ? { envelopeFrom } : {}),
        ...(envelopeMetadata ? { envelopeMetadata } : {}),
        ...(innerMetadata ? { innerMetadata } : {}),
        ...(receivedAt !== undefined ? { receivedAt } : {}),
      })
      continue
    }

    if (parsed) {
      // Protocol line of a kind this digest doesn't model (e.g.
      // plan_approval_request, rejected shutdown_response). Surface it
      // generically — the consumptive read means dropping it here would
      // lose it forever.
      const from = envelopeFrom ?? parsed.message.from?.agentId
      const body =
        (parsed.message.detail ?? '').trim() || JSON.stringify(parsed.record)
      freeform.push({
        ...(from ? { from } : {}),
        envType: parsed.message.kind,
        body: capFreeformBody(body),
        ...(receivedAt !== undefined ? { receivedAt } : {}),
      })
      continue
    }

    // Non-protocol line: a free-form SendMessage envelope (payload is
    // plain text) or a bare `[ts] text` line written via `plain: true`.
    const body = (envelopePayload ?? (outerIsJson ? '' : stripped)).trim()
    if (!body) continue
    freeform.push({
      ...(envelopeFrom ? { from: envelopeFrom } : {}),
      ...(envelopeType ? { envType: envelopeType } : {}),
      body: capFreeformBody(body),
      ...(receivedAt !== undefined ? { receivedAt } : {}),
    })
  }
  return { items, freeform }
}

/**
 * Back-compat view of {@link parseInboxLinesDetailed} — returns only the
 * supported protocol items (the original contract). Prefer the detailed
 * variant anywhere the input lines come from a consumptive read.
 */
export function parseInboxLines(lines: ReadonlyArray<string>): ParsedInboxItem[] {
  return parseInboxLinesDetailed(lines).items
}

function senderKey(item: ParsedInboxItem): string {
  return (item.envelopeFrom?.trim() || item.message.from?.agentId?.trim() || '').toLowerCase()
}

/**
 * Cap on rendered events — guards against a runaway mailbox dumping a
 * thousand entries into the lead's next turn. The newest items win;
 * older items are dropped with an explicit `<dropped count="N"/>` line
 * so the model knows the digest is partial.
 */
const MAX_RENDERED_ITEMS = 20

/**
 * Fold: keep ALL task_assignment / task_completion entries (they are
 * discrete state changes the lead cares about), but among
 * `idle_notification`s collapse same-sender duplicates to the most
 * recent. Same-sender ordering is preserved by input order — assume
 * the caller passed mailbox lines in mailbox-write order.
 */
export function foldInboxItems(
  items: ReadonlyArray<ParsedInboxItem>,
): ParsedInboxItem[] {
  const idleBySender = new Map<string, ParsedInboxItem>()
  const out: ParsedInboxItem[] = []
  for (const item of items) {
    if (item.message.kind === 'idle_notification') {
      const key = senderKey(item) || `_anon_${out.length}`
      idleBySender.set(key, item)
      continue
    }
    out.push(item)
  }
  for (const idle of idleBySender.values()) {
    out.push(idle)
  }
  return out
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function pickStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}

function pickStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}

function renderIdle(item: ParsedInboxItem): string {
  const fromAttr = pickStr(item.envelopeFrom) ?? pickStr(item.message.from?.agentId) ?? 'unknown'
  const reason = pickStr(item.message.detail) ?? 'turn_complete'
  const peerDm = pickStr(item.envelopeMetadata?.peerDmSummary)
  // Audit fix F-01: render the honest `<claimed-tasks>` element; the
  // legacy `completedTaskIds` field is also accepted on read for
  // back-compat with envelopes already in mailbox files (no migration
  // needed — they'll drain on next read).
  const claimed = pickStrArray(
    item.envelopeMetadata?.claimedTaskIds ?? item.envelopeMetadata?.completedTaskIds,
  )
  const lines = [
    `  <message from="${escapeXml(fromAttr)}" kind="idle_notification">`,
    `    <reason>${escapeXml(reason)}</reason>`,
  ]
  if (peerDm) lines.push(`    <peer-dm-summary>${escapeXml(peerDm)}</peer-dm-summary>`)
  if (claimed.length > 0) {
    lines.push(`    <claimed-tasks>${escapeXml(claimed.join(','))}</claimed-tasks>`)
  }
  lines.push(`  </message>`)
  return lines.join('\n')
}

function renderAssignment(item: ParsedInboxItem): string {
  const fromAttr =
    pickStr(item.envelopeFrom) ?? pickStr(item.message.from?.agentId) ?? 'unknown'
  const taskId =
    pickStr(item.innerMetadata?.taskId) ?? pickStr(item.message.detail) ?? 'unknown'
  const taskSubject = pickStr(item.innerMetadata?.taskSubject)
  const assignedBy = pickStr(item.innerMetadata?.assignedBy)
  const lines = [
    `  <message from="${escapeXml(fromAttr)}" kind="task_assignment">`,
    `    <task-id>${escapeXml(taskId)}</task-id>`,
  ]
  if (taskSubject) lines.push(`    <subject>${escapeXml(taskSubject)}</subject>`)
  if (assignedBy) lines.push(`    <assigned-by>${escapeXml(assignedBy)}</assigned-by>`)
  lines.push(`  </message>`)
  return lines.join('\n')
}

function renderCompletion(item: ParsedInboxItem): string {
  const fromAttr =
    pickStr(item.envelopeFrom) ?? pickStr(item.message.from?.agentId) ?? 'unknown'
  const taskId =
    pickStr(item.innerMetadata?.taskId) ?? pickStr(item.message.detail) ?? 'unknown'
  const status = pickStr(item.innerMetadata?.status) ?? 'completed'
  const finalSummary = pickStr(item.innerMetadata?.finalSummary)
  const lines = [
    `  <message from="${escapeXml(fromAttr)}" kind="task_completion">`,
    `    <task-id>${escapeXml(taskId)}</task-id>`,
    `    <status>${escapeXml(status)}</status>`,
  ]
  if (finalSummary) lines.push(`    <summary>${escapeXml(finalSummary)}</summary>`)
  lines.push(`  </message>`)
  return lines.join('\n')
}

function renderFreeform(f: FreeformInboxItem): string {
  const typeAttr = f.envType ? ` type="${escapeXml(f.envType)}"` : ''
  return [
    `  <message from="${escapeXml(f.from ?? 'unknown')}" kind="message"${typeAttr}>`,
    `    <body>${escapeXml(f.body)}</body>`,
    `  </message>`,
  ].join('\n')
}

/**
 * Render a list of parsed items into a `<team-inbox>` XML block.
 * Returns `null` when there is nothing to render (empty input, or all
 * entries dropped after folding).
 *
 * `freeform` entries (free-form member messages / unsupported protocol
 * kinds — see {@link FreeformInboxItem}) are rendered after the protocol
 * digest and share the same {@link MAX_RENDERED_ITEMS} cap.
 */
export function renderTeamInboxXml(
  items: ReadonlyArray<ParsedInboxItem>,
  freeform: ReadonlyArray<FreeformInboxItem> = [],
): string | null {
  const folded = foldInboxItems(items)
  if (folded.length === 0 && freeform.length === 0) return null

  const renderedAll: string[] = []
  for (const item of folded) {
    switch (item.message.kind) {
      case 'idle_notification':
        renderedAll.push(renderIdle(item))
        break
      case 'task_assignment':
        renderedAll.push(renderAssignment(item))
        break
      case 'task_completion':
        renderedAll.push(renderCompletion(item))
        break
      default:
        break
    }
  }
  for (const f of freeform) {
    renderedAll.push(renderFreeform(f))
  }

  const droppedCount = Math.max(0, renderedAll.length - MAX_RENDERED_ITEMS)
  const inner = renderedAll.slice(-MAX_RENDERED_ITEMS)

  if (inner.length === 0) return null

  const head = '<team-inbox>'
  const tail = '</team-inbox>'
  const droppedNote =
    droppedCount > 0 ? `  <dropped count="${droppedCount}"/>\n` : ''
  return `${head}\n${droppedNote}${inner.join('\n')}\n${tail}`
}

/**
 * Runtime helper — pop the lead's mailbox and render. Consumptive:
 * uses {@link readAndClearTeamMailbox} so the same items are not
 * surfaced twice. Returns `null` when nothing was queued or rendering
 * produced no XML (kinds we don't display).
 */
export async function readAndRenderTeamInbox(args: {
  workspaceRoot: string
  teamName: string
  leadAgentId: string
}): Promise<string | null> {
  if (!args.workspaceRoot || !args.teamName?.trim() || !args.leadAgentId?.trim()) {
    return null
  }
  let lines: string[]
  try {
    lines = await readAndClearTeamMailbox(
      args.workspaceRoot,
      args.teamName.trim(),
      args.leadAgentId.trim(),
    )
  } catch (err) {
    console.warn(
      `[teamInboxAttachments] mailbox read failed for "${args.leadAgentId}" on "${args.teamName}":`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
  if (lines.length === 0) return null

  // S5: consume `shutdown_response{approve:true}` envelopes BEFORE
  // rendering. Approved shutdowns are a control-plane signal — abort
  // the worker + drop from the roster, then suppress them from the
  // digest (the lead doesn't need to see "I approved my own shutdown
  // request" verbatim). Other lines (idle / assignment / completion /
  // rejected shutdowns / unknown kinds) flow through unchanged.
  let postLines = lines
  try {
    const consumed = await consumeShutdownResponses({
      teamName: args.teamName.trim(),
      lines,
    })
    postLines = consumed.remaining
  } catch (err) {
    console.warn(
      `[teamInboxAttachments] shutdown_response consumption failed on "${args.teamName}":`,
      err instanceof Error ? err.message : err,
    )
    postLines = lines
  }

  if (postLines.length === 0) return null
  // Detailed parse — the read above was consumptive, so free-form member
  // messages (e.g. a teammate's final result sent via SendMessage) and
  // unsupported protocol kinds MUST be rendered here or they are lost.
  const { items, freeform } = parseInboxLinesDetailed(postLines)
  return renderTeamInboxXml(items, freeform)
}
