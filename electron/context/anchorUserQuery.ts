/**
 * `<user-query>` anchor — wire-time structural marker for the user's
 * current-turn instruction.
 *
 * Problem this solves (intent-dilution audit, 2026-06): by the time the
 * model reads the user's one-line instruction, the payload also carries
 * ~20-30K tokens of host scaffolding — system prompt, tool definitions,
 * the `messages[0]` user-meta `<system-reminder>` block, retrieval
 * snippets, transcript pool deltas. The ONLY signal marking which text is
 * the live instruction used to be a prose sentence in the user-meta
 * disclaimer ("the user's actual current turn is whichever ordinary user
 * message comes LAST"), i.e. a positional heuristic the model had to
 * re-derive every turn. Quantifier-level misreads ("测试30种工具" read as
 * "测试30次工具调用") correlate with that weak anchoring.
 *
 * This module gives the current turn a STRUCTURAL anchor instead: the
 * last user message carrying ordinary text (not a `<system-reminder>`
 * envelope, not a tool_result carrier) gets that text wrapped in
 * `<user-query>` … `</user-query>` tags at wire-build time. The host
 * runtime contract and the user-meta disclaimer both document the tag.
 *
 * Envelope-aware span detection (self-audit fix, same day): the wire
 * pipeline runs `mergeConsecutiveUserMessages` BEFORE this module, and on
 * the FIRST turn the renderer's context-reminder message and the user's
 * actual text arrive as adjacent user messages that get merged into ONE
 * string: `"<system-reminder>…</system-reminder>\n\n<user text>"`. A
 * naive "starts with <system-reminder → not ordinary" prefix test
 * therefore skipped exactly the most important turn. We instead locate
 * the ordinary span — the non-whitespace text OUTSIDE all
 * `<system-reminder>…</system-reminder>` envelopes — and wrap precisely
 * that span, wherever it sits in the string.
 *
 * Design constraints:
 *   - **Pure + idempotent.** `anchorCurrentUserQuery` first strips every
 *     anchor it ever produced (self-healing against replayed history from
 *     persisted transcripts), then wraps exactly one message. Calling it
 *     twice yields the same payload.
 *   - **Wire-only.** Applied in `streamHandler` AFTER
 *     `normalizeMessagesForAPI` / `prependUserContext` /
 *     `injectPendingSubAgentOutputsForMainTurn`, on the per-send message
 *     copy. The renderer store and persisted conversation never see the
 *     tags — each send re-derives the anchor from scratch.
 *   - **No mutation.** Input messages (and their content arrays / blocks)
 *     are not modified; changed nodes are shallow-copied.
 *   - Scope: main chat only. Sub-agents receive a single task prompt that
 *     IS the query — no anchor needed there (the host contract's "no tag →
 *     fall back to the last ordinary user message" clause covers them).
 */

import { extractKernelUserInputBody } from '../constants/sideChannelKinds'

export const USER_QUERY_OPEN_TAG = '<user-query>'
export const USER_QUERY_CLOSE_TAG = '</user-query>'

/** Wire shapes inserted by {@link anchorCurrentUserQuery}; the strip pass
 *  removes exactly these. */
const OPEN_MARKER = `${USER_QUERY_OPEN_TAG}\n`
const CLOSE_MARKER = `\n${USER_QUERY_CLOSE_TAG}`

const ENVELOPE_OPEN = '<system-reminder'
const ENVELOPE_CLOSE = '</system-reminder>'

type AnyMessage = { role?: unknown; content?: unknown } & Record<string, unknown>
type AnyBlock = { type?: unknown; text?: unknown } & Record<string, unknown>

/**
 * Locate the ordinary span of a text segment: the range from the first to
 * the last non-whitespace character that lies OUTSIDE every
 * `<system-reminder …>…</system-reminder>` envelope. Returns `null` when
 * the segment is empty, whitespace-only, or envelope-only. An unclosed
 * envelope extends to the end of the segment.
 */
function findOrdinarySpan(text: string): { start: number; end: number } | null {
  // Collect envelope intervals with a sequential (non-nested) scan.
  const envelopes: Array<{ start: number; end: number }> = []
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf(ENVELOPE_OPEN, cursor)
    if (open === -1) break
    const close = text.indexOf(ENVELOPE_CLOSE, open)
    if (close === -1) {
      envelopes.push({ start: open, end: text.length })
      break
    }
    const end = close + ENVELOPE_CLOSE.length
    envelopes.push({ start: open, end })
    cursor = end
  }

  let first = -1
  let last = -1
  let env = 0
  for (let i = 0; i < text.length; i++) {
    // Skip past any envelope covering position i.
    while (env < envelopes.length && i >= envelopes[env]!.end) env++
    if (env < envelopes.length && i >= envelopes[env]!.start) {
      i = envelopes[env]!.end - 1
      continue
    }
    const ch = text.charCodeAt(i)
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) continue
    if (first === -1) first = i
    last = i
  }
  if (first === -1) return null
  return { start: first, end: last + 1 }
}

/** Remove the first OPEN_MARKER and the last CLOSE_MARKER from a message
 *  (both-or-nothing, OPEN before CLOSE) — exactly inverting one wrap.
 *  Returns the original reference when nothing changed. */
function stripAnchorsFromMessage<T extends AnyMessage>(msg: T): T {
  if (msg.role !== 'user') return msg
  const c = msg.content

  if (typeof c === 'string') {
    const openIdx = c.indexOf(OPEN_MARKER)
    const closeIdx = c.lastIndexOf(CLOSE_MARKER)
    if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) return msg
    const stripped =
      c.slice(0, openIdx) +
      c.slice(openIdx + OPEN_MARKER.length, closeIdx) +
      c.slice(closeIdx + CLOSE_MARKER.length)
    return { ...msg, content: stripped }
  }

  if (!Array.isArray(c)) return msg
  const blocks = c as AnyBlock[]
  let openBlock = -1
  let closeBlock = -1
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b?.type !== 'text' || typeof b.text !== 'string') continue
    if (openBlock === -1 && b.text.includes(OPEN_MARKER)) openBlock = i
    if (b.text.includes(CLOSE_MARKER)) closeBlock = i
  }
  if (openBlock === -1 || closeBlock === -1 || closeBlock < openBlock) return msg
  const next = blocks.slice()
  {
    const t = next[openBlock]!.text as string
    const idx = t.indexOf(OPEN_MARKER)
    next[openBlock] = {
      ...next[openBlock],
      text: t.slice(0, idx) + t.slice(idx + OPEN_MARKER.length),
    }
  }
  {
    const t = next[closeBlock]!.text as string
    const idx = t.lastIndexOf(CLOSE_MARKER)
    next[closeBlock] = {
      ...next[closeBlock],
      text: t.slice(0, idx) + t.slice(idx + CLOSE_MARKER.length),
    }
  }
  return { ...msg, content: next }
}

/**
 * Host-authored user-role bodies that are deliberately NOT wrapped in
 * `<system-reminder>` (post-compact attachments keep their bodies bare so
 * the model treats `<restored-file>` content as authoritative reference —
 * see `postCompactAttachments.ts` P1-12). The anchor must still never land
 * on them: after an auto-compact folds the current turn's user text into
 * the summary, these attachments can become the LAST user message carrying
 * bare text, and wrapping one in `<user-query>` told the model the live
 * instruction was "[Post-compact context — paths recently seen …]"
 * (destructive 50×120 stress finding, 2026-06).
 */
const HOST_BARE_BODY_PREFIXES = [
  '[Post-compact', // file hints / verified files / plan / tool delta / session memory
  '<restored-file', // post-compact warmup file bodies
  '<invoked-skills', // skill reinjection fragment
] as const

function spanIsHostBareBody(text: string, span: { start: number; end: number }): boolean {
  const head = text.slice(span.start, Math.min(span.end, span.start + 64))
  return HOST_BARE_BODY_PREFIXES.some((p) => head.startsWith(p))
}

function textHasOrdinarySpan(text: string): boolean {
  const span = findOrdinarySpan(text)
  return span !== null && !spanIsHostBareBody(text, span)
}

function messageHasOrdinaryUserText(msg: AnyMessage): boolean {
  if (msg.role !== 'user') return false
  const c = msg.content
  if (typeof c === 'string') return textHasOrdinarySpan(c)
  if (!Array.isArray(c)) return false
  return (c as AnyBlock[]).some(
    (b) => b?.type === 'text' && typeof b.text === 'string' && textHasOrdinarySpan(b.text),
  )
}

function wrapTextAtSpan(text: string, span: { start: number; end: number }, openTag: boolean, closeTag: boolean): string {
  let out = text
  if (closeTag) out = out.slice(0, span.end) + CLOSE_MARKER + out.slice(span.end)
  if (openTag) out = out.slice(0, span.start) + OPEN_MARKER + out.slice(span.start)
  return out
}

/**
 * Wrap the ordinary text of one user message. For string content the tags
 * delimit the ordinary span (skipping any merged-in `<system-reminder>`
 * prefix/suffix). For block-array content the opening tag lands at the
 * FIRST ordinary block's span start and the closing tag at the LAST
 * ordinary block's span end, so an attachment-bearing turn reads as
 * `<user-query> text [image] text </user-query>`.
 */
function wrapMessage<T extends AnyMessage>(msg: T): T {
  const c = msg.content
  if (typeof c === 'string') {
    const span = findOrdinarySpan(c)
    if (!span) return msg
    return { ...msg, content: wrapTextAtSpan(c, span, true, true) }
  }
  if (!Array.isArray(c)) return msg
  const blocks = (c as AnyBlock[]).slice()
  let first = -1
  let last = -1
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b?.type === 'text' && typeof b.text === 'string' && findOrdinarySpan(b.text) !== null) {
      if (first < 0) first = i
      last = i
    }
  }
  if (first < 0) return msg
  if (first === last) {
    const t = blocks[first]!.text as string
    blocks[first] = { ...blocks[first], text: wrapTextAtSpan(t, findOrdinarySpan(t)!, true, true) }
  } else {
    const tFirst = blocks[first]!.text as string
    blocks[first] = {
      ...blocks[first],
      text: wrapTextAtSpan(tFirst, findOrdinarySpan(tFirst)!, true, false),
    }
    const tLast = blocks[last]!.text as string
    blocks[last] = {
      ...blocks[last],
      text: wrapTextAtSpan(tLast, findOrdinarySpan(tLast)!, false, true),
    }
  }
  return { ...msg, content: blocks }
}

/**
 * Ordinary text of ONE user message (the non-envelope span(s)), or `null`
 * when the message carries none. Extracted from
 * {@link extractCurrentUserQueryText} so callers that need POSITIONAL
 * reasoning (e.g. "does this tool batch belong to the current user turn?"
 * — systemDriveContext, 2026-07 复审 item 4) can classify individual
 * messages with the exact same ordinary-text semantics the anchor uses.
 */
export function extractOrdinaryUserText(msg: AnyMessage): string | null {
  if (!messageHasOrdinaryUserText(msg)) return null
  const c = msg.content
  if (typeof c === 'string') {
    const span = findOrdinarySpan(c)
    if (!span || spanIsHostBareBody(c, span)) return null
    return c.slice(span.start, span.end)
  }
  if (!Array.isArray(c)) return null
  const parts: string[] = []
  for (const b of c as AnyBlock[]) {
    if (b?.type !== 'text' || typeof b.text !== 'string') continue
    const span = findOrdinarySpan(b.text)
    if (!span || spanIsHostBareBody(b.text, span)) continue
    parts.push(b.text.slice(span.start, span.end))
  }
  return parts.length > 0 ? parts.join('\n') : null
}

/**
 * Index of the LAST user message carrying ordinary text — the message the
 * anchor would wrap — or `-1` when none exists. Companion to
 * {@link extractCurrentUserQueryText} for callers that need the position,
 * not just the text.
 *
 * F1 (2026-07 会话审计): a `kernel_user_input` delivery counts as a user
 * turn here — it IS the user speaking (mid-turn redirect), merely wrapped
 * in the host envelope for transport. Turn-boundary consumers (e.g. the
 * observation-digest attribution) must treat it as the newest user
 * instruction, not as host noise.
 */
export function findLastOrdinaryUserIndex(
  messages: ReadonlyArray<AnyMessage>,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (
      messageHasOrdinaryUserText(msg) ||
      extractKernelUserInputBody(msg as Record<string, unknown>) !== null
    ) {
      return i
    }
  }
  return -1
}

/**
 * Extract the CURRENT user query's ordinary text — the same message the
 * anchor would wrap — without mutating anything. Used by the goal-
 * recitation fallback (2026-07 deep-loop drift uplift): when a long
 * agentic run has NO TodoWrite list / objective to recite, the host
 * recites this text instead so the original instruction stays in recent
 * attention.
 *
 * Walks backwards to the last user message carrying ordinary
 * (non-host-envelope, non-bare-host-body) text and returns the ordinary
 * span(s). For block-array content, ordinary spans of every text block
 * are joined with a newline. Returns `null` when no such message exists
 * (e.g. a transcript that is 100% tool_results + reminders).
 */
export function extractCurrentUserQueryText(
  messages: ReadonlyArray<AnyMessage>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    // F1 (2026-07 会话审计) — a mid-turn user redirect delivered via the
    // kernel inbox IS the newest user instruction; return its unwrapped
    // body so goal recitation, the drive contract's Current request, and
    // objective validation all track the redirect instead of the stale
    // pre-redirect query. (The wire-time `<user-query>` anchor is left
    // unchanged: it never lands inside a host envelope by design — the
    // kind's system-prompt declaration already grants the body user-turn
    // authority.)
    const kernelBody = extractKernelUserInputBody(msg as Record<string, unknown>)
    if (kernelBody) return kernelBody
    if (!messageHasOrdinaryUserText(msg)) continue
    return extractOrdinaryUserText(msg)
  }
  return null
}

/**
 * Anchor the current user query: strip all previous anchors, then wrap
 * the ordinary span of the LAST user message that carries ordinary
 * (non-host-envelope) text. Messages whose user role only transports
 * `tool_result` blocks or `<system-reminder>` envelopes are skipped, so
 * the anchor always lands on the human's actual turn — including the
 * first-turn shape where the reminder prefix and the user's text were
 * merged into a single string.
 */
export function anchorCurrentUserQuery<T extends AnyMessage>(messages: T[]): T[] {
  const out = messages.map((m) => stripAnchorsFromMessage(m))
  for (let i = out.length - 1; i >= 0; i--) {
    if (messageHasOrdinaryUserText(out[i]!)) {
      out[i] = wrapMessage(out[i]!)
      return out
    }
  }
  return out
}
