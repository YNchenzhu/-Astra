/**
 * upstream report §2.2 Step 15 — 12-pass message normalization pipeline
 * (+ Pass 5b for Bedrock tool_use contiguity, planned 2026-05).
 *
 * Transforms the internal message array into the exact shape required by the
 * Anthropic Messages API before each request. Each pass is idempotent.
 *
 * ┌─────┬──────────────────────────────────┬──────────────────────────────────┐
 * │ Pass│ Processing Step                   │ Purpose                          │
 * ├─────┼──────────────────────────────────┼──────────────────────────────────┤
 * │  1  │ reorderAttachmentsForAPI          │ Attachments near tool_result     │
 * │  2  │ stripVirtualMessages              │ Remove virtual-type messages     │
 * │  3  │ buildStripTargets                 │ Build removal targets for errors │
 * │  4  │ filterAndTransform                │ user merge, assistant merge,     │
 * │     │                                   │ attachment normalize, sys→user   │
 * │  5  │ relocateToolReferenceSiblings     │ Move text near tool_reference    │
 * │ 5b  │ reorderAssistantToolUseBlocks     │ tool_use 簇连续化 (upstream 移植) │
 * │  6  │ filterOrphanedThinkingOnly        │ Remove orphaned thinking msgs   │
 * │  7  │ filterTrailingThinkingFromLast    │ Filter last assistant trailing   │
 * │  8  │ filterWhitespaceOnlyAssistant     │ Remove whitespace-only assistant │
 * │  9  │ ensureNonEmptyAssistantContent    │ Ensure assistant has content     │
 * │  10 │ smooshSystemReminderSiblings      │ Fold adjacent system-reminders   │
 * │  11 │ sanitizeErrorToolResultContent    │ Clean error tool_result content  │
 * │  12 │ appendMessageTagToUserMessage     │ Add message tags for snip tool   │
 * └─────┴──────────────────────────────────┴──────────────────────────────────┘
 */

import { mergeConsecutiveUserMessages } from './mergeConsecutiveUserMessages'
import { ensureToolUseResultPairing } from './ensureToolUseResultPairing'
import { reorderAssistantToolUseBlocks } from './reorderAssistantToolUseBlocks'
import {
  SIDE_CHANNEL_KIND,
  readSideChannelKind,
  wrapSideChannelBody,
} from '../constants/sideChannelKinds'
import {
  fixAssistantThinkingNotLastBlock,
  stripExcessImageBlocks,
} from './apiMessageInvariants'

type Msg = Record<string, unknown>

function contentBlocks(msg: Msg): Array<Record<string, unknown>> {
  if (Array.isArray(msg.content)) return msg.content as Array<Record<string, unknown>>
  if (typeof msg.content === 'string') return [{ type: 'text', text: msg.content }]
  return []
}

// ─── Pass 1: reorderAttachmentsForAPI ───
//
// Attachments must immediately follow the NEXT tool_result `user` turn —
// that's where the model sees them paired with the action that
// surfaced them. Crucially, attachments must HOLD across non-tool-result
// messages until they reach a real tool_result; previously the loop
// flushed pending attachments on every non-attachment / non-tool_result
// message, which dumped them BEFORE intervening assistant turns and made
// E57 (attachments at array head, tool_result later) fail.
//
// New semantics:
//   - keep collecting attachments into `pendingAttachments`
//   - on every non-attachment message: push that message first, then if
//     it carried a tool_result drain the pending queue immediately
//     after it (so attachments end up adjacent to the tool_result they
//     belong to)
//   - on array end: any leftover attachments go to the tail (E58)
function reorderAttachmentsForAPI(messages: Msg[]): Msg[] {
  const out: Msg[] = []
  const pendingAttachments: Msg[] = []

  for (const m of messages) {
    const isAttachment =
      m._type === 'attachment' ||
      m._meta_type === 'attachment' ||
      (m.role === 'user' && m._isAttachment === true)

    if (isAttachment) {
      pendingAttachments.push({ ...m })
      continue
    }

    const hasToolResult =
      m.role === 'user' &&
      Array.isArray(m.content) &&
      (m.content as Msg[]).some((b) => b.type === 'tool_result')

    out.push({ ...m })
    if (hasToolResult && pendingAttachments.length > 0) {
      out.push(...pendingAttachments)
      pendingAttachments.length = 0
    }
  }

  if (pendingAttachments.length > 0) {
    out.push(...pendingAttachments)
  }

  return out
}

// ─── Pass 2: stripVirtualMessages ───
function stripVirtualMessages(messages: Msg[]): Msg[] {
  return messages.filter((m) => {
    if (m._type === 'virtual' || m._meta_type === 'virtual') return false
    if (m._virtual === true) return false
    return true
  })
}

// ─── Pass 3: buildStripTargets + Pass 4: filterAndTransform ───

function mergeAssistantContent(
  existing: unknown,
  incoming: unknown,
): Array<Record<string, unknown>> {
  const a = Array.isArray(existing)
    ? (existing as Msg[])
    : typeof existing === 'string' && existing
      ? [{ type: 'text', text: existing }]
      : []
  const b = Array.isArray(incoming)
    ? (incoming as Msg[])
    : typeof incoming === 'string' && incoming
      ? [{ type: 'text', text: incoming }]
      : []
  return [...a, ...b]
}

function convertSystemToUser(msg: Msg): Msg {
  if (msg.role === 'system') {
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as Msg[])
              .filter((b) => b.type === 'text')
              .map((b) => String(b.text ?? ''))
              .join('\n')
          : String(msg.content ?? '')
    // P1-16 — `wrapSideChannelBody` is idempotent: a caller that already
    // wraps its body in `<system-reminder>…</system-reminder>` is returned
    // verbatim; otherwise we apply the canonical envelope. This replaces
    // the previous inline `startsWith / endsWith` check so all converted-
    // system messages funnel through the dictionary's idempotency rule.
    return {
      ...msg,
      role: 'user',
      content: wrapSideChannelBody(
        SIDE_CHANNEL_KIND.genericConvertedSystem,
        text,
      ),
      _convertedFromSystem: true,
    }
  }
  return msg
}

function filterAndTransform(messages: Msg[], applyConsecutiveUserMerge: boolean): Msg[] {
  const errToolUseIds = new Set<string>()
  for (const m of messages) {
    if (m._stripToolError === true && Array.isArray(m.content)) {
      for (const b of m.content as Msg[]) {
        if (b.type === 'tool_use' && typeof b.id === 'string') {
          errToolUseIds.add(b.id)
        }
      }
    }
  }

  let out: Msg[] = []
  for (const m of messages) {
    if (m._stripToolError === true) continue

    if (m.role === 'user' && Array.isArray(m.content)) {
      const filtered = (m.content as Msg[]).filter((b) => {
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          return !errToolUseIds.has(b.tool_use_id)
        }
        return true
      })
      if (filtered.length === 0) continue
      out.push({ ...m, content: filtered })
      continue
    }

    const converted = convertSystemToUser(m)
    out.push({ ...converted })
  }

  // 2026-05 audit (long-run semantic-tag integrity) — consecutive-user
  // merge is a WIRE-level invariant (Bedrock rejects back-to-back user
  // turns), not a transcript-shape invariant. When the iteration-level
  // normalize call site writes the result back to `state.apiMessages`
  // we want to SKIP this pass, because:
  //
  //   - `post_tool` host attachments inject side-channel reminders
  //     right after the `user (tool_result)` message produced by tool
  //     execution. tool_result-only user messages do NOT carry
  //     `_convertedFromSystem: true`, so `mergeConsecutiveUserMessages`'s
  //     AND-semantics treats them as "real user text" and DROPS the
  //     side-channel reminder's typed `_sideChannelKind` flag from the
  //     merged turn.
  //   - That kind-flag was the only thing keeping
  //     `staleTodoNudge.computeTurnCounts` / `staleTaskNudge.computeTaskTurnCounts`
  //     able to identify "the last reminder of this kind in history"
  //     across iterations. Without it the double-cadence throttle
  //     silently degrades (both gates pass because the collector can
  //     never see a prior reminder).
  //
  // `electron/ai/streamHandler.ts:865`'s normalize call still runs
  // this pass (default `true`) before the wire payload is built, so
  // Bedrock and other strict providers continue to see the merged
  // shape they require. Only the iteration-end state writeback opts
  // out via `applyConsecutiveUserMerge: false`.
  if (applyConsecutiveUserMerge) {
    out = mergeConsecutiveUserMessages(out)
  }

  const merged: Msg[] = []
  for (const m of out) {
    if (
      m.role === 'assistant' &&
      merged.length > 0 &&
      merged[merged.length - 1].role === 'assistant'
    ) {
      const prev = merged[merged.length - 1]
      merged[merged.length - 1] = {
        ...prev,
        content: mergeAssistantContent(prev.content, m.content),
      }
    } else {
      merged.push(m)
    }
  }

  return merged
}

// ─── Pass 5: relocateToolReferenceSiblings ───
//
// v1/H8 fix — keep the relocation in a single user message.
//
// The previous implementation, when both `tool_reference` blocks AND
// other content lived in one user message, emitted **two** consecutive
// user messages (`refs` then `rest`). That violates the Bedrock /
// Anthropic-compat invariant that consecutive user turns must not
// appear, and this pass ran AFTER the only `mergeConsecutiveUserMessages`
// call so nothing folded them back. Repackaging into a single user with
// `[refs..., rest...]` preserves the original relocation intent (refs
// surface first, then the surrounding content) without breaking the
// invariant.
function relocateToolReferenceSiblings(messages: Msg[]): Msg[] {
  const out: Msg[] = []
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) {
      out.push(m)
      continue
    }

    const blocks = m.content as Msg[]
    const hasToolRef = blocks.some((b) => b.type === 'tool_reference')
    if (!hasToolRef) {
      out.push(m)
      continue
    }

    const refs: Msg[] = []
    const rest: Msg[] = []
    for (const b of blocks) {
      if (b.type === 'tool_reference') {
        refs.push(b)
      } else {
        rest.push(b)
      }
    }

    if (rest.length > 0) {
      out.push({ ...m, content: [...refs, ...rest] })
    } else {
      out.push(m)
    }
  }
  return out
}

// ─── Pass 6: filterOrphanedThinkingOnly ───
//
// 2026-06 multi-turn degradation fix (Pass 6 side-effect): despite the
// "orphaned" name, this pass removes EVERY thinking-only assistant
// message. That's correct for the WIRE payload (upstream parity; some
// providers 400 on dangling thinking), but the iteration-level writeback
// call in `orchestration/phases/iteration.ts` assigns the result back to
// `state.apiMessages` — destructively erasing the persisted reasoning
// record of thinking-only turns on every iteration, in direct conflict
// with the "persisted transcript keeps the full reasoning record"
// principle (see anthropicThinkingTranscript.ts R1 ephemeral note).
// Combined with the Symptom-3 degeneration (thinking-only turns), the
// model could never see that it had already "thought" — it re-thought
// the same content or skipped straight to claiming completion. The
// `preserve` flag lets the writeback call site keep these messages while
// wire-bound callers retain the legacy removal.
function filterOrphanedThinkingOnly(
  messages: Msg[],
  strictThinkingEcho?: boolean,
  preserveThinkingOnly?: boolean,
): Msg[] {
  if (strictThinkingEcho || preserveThinkingOnly) return messages
  return messages.filter((m) => {
    if (m.role !== 'assistant') return true
    const blocks = contentBlocks(m)
    if (blocks.length === 0) return true
    const onlyThinking = blocks.every(
      (b) => b.type === 'thinking' || b.type === 'redacted_thinking',
    )
    if (!onlyThinking) return true
    return false
  })
}

// ─── Pass 7: filterTrailingThinkingFromLastAssistant ───
function filterTrailingThinkingFromLastAssistant(messages: Msg[], strictThinkingEcho?: boolean): Msg[] {
  if (strictThinkingEcho) return messages
  if (messages.length === 0) return messages
  const lastIdx = messages.length - 1
  const last = messages[lastIdx]
  if (last.role !== 'assistant' || !Array.isArray(last.content)) return messages

  const blocks = last.content as Msg[]
  if (blocks.length === 0) return messages

  let trimIdx = blocks.length
  while (
    trimIdx > 0 &&
    (blocks[trimIdx - 1].type === 'thinking' || blocks[trimIdx - 1].type === 'redacted_thinking')
  ) {
    trimIdx--
  }

  if (trimIdx === blocks.length) return messages
  if (trimIdx === 0) {
    return messages.slice(0, lastIdx)
  }

  const out = [...messages]
  out[lastIdx] = { ...last, content: blocks.slice(0, trimIdx) }
  return out
}

// ─── Pass 8: filterWhitespaceOnlyAssistant ───
//
// Removes assistant turns that are purely whitespace (`'   '`, `'\n\n'`)
// since those add noise without semantic content. TRULY EMPTY content
// (`''`, `[]`) is intentionally PASSED THROUGH so pass 9
// (`ensureNonEmptyAssistantContent`) can replace it with a `'...'`
// placeholder — without that hand-off, an assistant turn with empty
// content was silently dropped and the message disappeared from the API
// payload (broke E37).
function filterWhitespaceOnlyAssistant(messages: Msg[]): Msg[] {
  return messages.filter((m) => {
    if (m.role !== 'assistant') return true
    if (typeof m.content === 'string') {
      // Keep truly empty so pass 9 can placeholder it; drop only when
      // the string has characters that all turn out to be whitespace.
      if (m.content.length === 0) return true
      return m.content.trim().length > 0
    }
    if (Array.isArray(m.content)) {
      const blocks = m.content as Msg[]
      if (blocks.length === 0) return true // ditto — pass 9 will placeholder
      return blocks.some((b) => {
        if (b.type === 'text') return String(b.text ?? '').trim().length > 0
        return true
      })
    }
    return true
  })
}

// ─── Pass 9: ensureNonEmptyAssistantContent ───
function ensureNonEmptyAssistantContent(messages: Msg[], strictThinkingEcho?: boolean): Msg[] {
  return messages.map((m) => {
    if (m.role !== 'assistant') return m
    if (typeof m.content === 'string') {
      if (!m.content || (m.content as string).trim().length === 0) {
        return { ...m, content: [{ type: 'text', text: '...' }] }
      }
      return m
    }
    if (Array.isArray(m.content)) {
      const blocks = m.content as Msg[]
      if (blocks.length === 0) {
        return { ...m, content: [{ type: 'text', text: '...' }] }
      }
      // When strictThinkingEcho is set, preserve assistant messages that contain
      // only thinking blocks — DeepSeek requires them echoed back verbatim.
      if (strictThinkingEcho) return m
      const hasNonThinking = blocks.some(
        (b) => b.type !== 'thinking' && b.type !== 'redacted_thinking',
      )
      if (!hasNonThinking) {
        return { ...m, content: [...blocks, { type: 'text', text: '...' }] }
      }
      return m
    }
    return { ...m, content: [{ type: 'text', text: '...' }] }
  })
}

// ─── Pass 10: smooshSystemReminderSiblings ───
//
// v1/M1 fix — flatten content safely. Previously the function did
// `String(prev.content ?? '')` when content was an array, producing
// "[object Object],[object Object]" in the merged body — the model then
// saw garbage where reminder text should be. Now we extract text blocks
// and discard non-text blocks (which are not legal inside a smooshed
// reminder anyway).
function flattenReminderContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content as Array<Record<string, unknown>>) {
      if (b && b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text)
      }
    }
    return parts.join('\n')
  }
  return ''
}

/**
 * F1 (2026-07 会话审计) — `kernel_user_input` deliveries carry REAL user
 * speech (mid-turn redirect) and must never be smooshed into an adjacent
 * host reminder blob: folding the user's own instruction into e.g. a
 * stale-todo nudge both dilutes its attention weight and breaks the
 * marker-first-line detection the disk-resume path relies on. Applies to
 * BOTH directions (as the folded message and as the fold target).
 */
function isSmooshExemptUserInput(msg: Msg): boolean {
  return readSideChannelKind(msg) === SIDE_CHANNEL_KIND.kernelUserInput
}

function smooshSystemReminderSiblings(messages: Msg[]): Msg[] {
  const out: Msg[] = []
  for (const m of messages) {
    if (
      m.role === 'user' &&
      m._convertedFromSystem === true &&
      !isSmooshExemptUserInput(m) &&
      out.length > 0
    ) {
      const prev = out[out.length - 1]
      if (
        prev.role === 'user' &&
        prev._convertedFromSystem === true &&
        !isSmooshExemptUserInput(prev)
      ) {
        const prevText = flattenReminderContentToText(prev.content)
        const thisText = flattenReminderContentToText(m.content)
        out[out.length - 1] = {
          ...prev,
          content: `${prevText}\n\n${thisText}`,
        }
        continue
      }
    }
    out.push(m)
  }
  return out
}

// ─── Pass 11: sanitizeErrorToolResultContent ───
function sanitizeErrorToolResultContent(messages: Msg[]): Msg[] {
  return messages.map((m) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m
    const blocks = m.content as Msg[]
    let changed = false
    const cleaned = blocks.map((b) => {
      if (b.type !== 'tool_result' || b.is_error !== true) return b
      const content = b.content
      if (typeof content !== 'string') return b
      const MAX_ERROR_LEN = 8000
      if (content.length <= MAX_ERROR_LEN) return b
      changed = true
      return {
        ...b,
        content: `${content.slice(0, MAX_ERROR_LEN)}\n\n[Error output truncated — was ${content.length} chars]`,
      }
    })
    return changed ? { ...m, content: cleaned } : m
  })
}

// ─── Pass 12: appendMessageTagToUserMessage ───
function appendMessageTagToUserMessage(messages: Msg[]): Msg[] {
  let tagCounter = 0
  return messages.map((m) => {
    if (m.role !== 'user') return m
    if (m._messageTag != null) return m
    tagCounter++
    return { ...m, _messageTag: tagCounter }
  })
}

// ─── Clean internal metadata before sending to API ───
//
// Keys that are prefixed with `_` are treated as private markers that never
// reach the provider. Anything starting with `_pole` is a product-specific
// tracking field (e.g. `_poleContextUsage`, `_poleQueryTracking`). The
// previous implementation used a stale list with snake_case entries and a
// `startsWith('_pole_')` guard that required a trailing underscore — neither
// pattern matched the real camelCase keys, so those fields leaked to every
// provider. Audit Bug 2.
const INTERNAL_KEYS = new Set([
  '_type',
  '_meta_type',
  '_isAttachment',
  '_virtual',
  '_stripToolError',
  '_convertedFromSystem',
  '_messageTag',
  // Bug F-1: marks the fork boilerplate envelope so the recursive-fork
  // detector can identify it without substring-matching message content.
  '_forkBoilerplate',
  // Typed side-channel kind from {@link SIDE_CHANNEL_KIND_SPECS} — internal
  // discriminator used by smoosh / merge / compact gating; never goes to the wire.
  '_sideChannelKind',
  // Compact boundary markers (compact.ts + compactBoundary.ts). `_type` is
  // already stripped above; the boolean + timestamp siblings are used only by
  // `findLastCompactBoundaryIndex` in-process and must not leak either.
  '_compactBoundary',
  '_compactedAt',
  // Accept both snake_case (historical) and camelCase (actual) forms so
  // nothing is accidentally left behind even if callers mix them.
  '_pole_context_usage',
  '_poleContextUsage',
  '_poleQueryTracking',
])

function isInternalKey(k: string): boolean {
  if (INTERNAL_KEYS.has(k)) return true
  // `_pole*` is our private product prefix; strip aggressively regardless
  // of trailing separator (`_pole_foo`, `_poleFoo`, `_pole`).
  if (k.startsWith('_pole')) return true
  return false
}

function stripInternalFields(messages: Msg[]): Msg[] {
  return messages.map((m) => {
    const cleaned: Msg = {}
    for (const [k, v] of Object.entries(m)) {
      if (!isInternalKey(k)) {
        cleaned[k] = v
      }
    }
    return cleaned
  })
}

/**
 * Full 12-pass normalization pipeline.
 * Transforms internal messages into API-ready format.
 *
 * @param options.strictThinkingEcho — When true, skips all passes that would
 *   delete or mutate historical `thinking` / `redacted_thinking` blocks.
 *   Required for DeepSeek's Anthropic-compat endpoint which 400s when those
 *   blocks are stripped or altered (they must be echoed back verbatim).
 * @param options.applyConsecutiveUserMerge — When `false`, skips the
 *   `mergeConsecutiveUserMessages` pass inside Pass 3+4. Defaults to
 *   `true` (wire-output behaviour). Set to `false` at iteration-level
 *   state writeback sites so `post_tool`-injected side-channel
 *   reminders keep their typed `_sideChannelKind` flag (they would
 *   otherwise be merged into the preceding `user (tool_result)` turn
 *   and lose the flag via `mergeConsecutiveUserMessages`'s AND-semantics).
 *   The wire-bound call site in `electron/ai/streamHandler.ts` keeps
 *   the default `true` so Bedrock / Anthropic continue to see the
 *   merged shape they require.
 */
export function normalizeMessagesForAPI(
  messages: Msg[],
  options?: {
    stripInternalMeta?: boolean
    applyAnthropicInvariants?: boolean
    strictThinkingEcho?: boolean
    applyConsecutiveUserMerge?: boolean
    /**
     * When `true`, Pass 6 keeps thinking-only assistant messages instead
     * of removing them. Set by the iteration-level state-writeback call
     * site (which must not destroy the persisted reasoning record);
     * wire-bound callers keep the default `false` removal. See the Pass 6
     * doc block for the full rationale.
     */
    preserveThinkingOnlyAssistant?: boolean
  },
): Msg[] {
  const strictThinkingEcho = options?.strictThinkingEcho === true
  const preserveThinkingOnlyAssistant = options?.preserveThinkingOnlyAssistant === true
  const applyConsecutiveUserMerge = options?.applyConsecutiveUserMerge !== false
  let result = messages.map((m) => ({ ...m }))

  // Pass 1: Reorder attachments near tool_result
  result = reorderAttachmentsForAPI(result)

  // Pass 2: Strip virtual messages
  result = stripVirtualMessages(result)

  // Pass 3+4: Build strip targets, filter/transform, merge users/assistants, system→user
  result = filterAndTransform(result, applyConsecutiveUserMerge)

  // Pass 5: Relocate text near tool_reference blocks
  result = relocateToolReferenceSiblings(result)

  // Pass 5b: tool_use 簇连续化（Bedrock 兜底） — thinking 夹在簇内会被推到
  // 簇之后，与 upstream-main src/utils/messages.ts:2454-2489 行为一致。
  // Idempotent，对已连续的 content 是 no-op（返回同一引用）。
  result = result.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m
    const reordered = reorderAssistantToolUseBlocks(
      m.content as Array<{ type: string }>,
    )
    if (reordered === m.content) return m
    return { ...m, content: reordered }
  })

  // Pass 6: Remove orphaned thinking-only assistant messages
  // (skipped when the caller preserves the reasoning record — see option doc)
  result = filterOrphanedThinkingOnly(result, strictThinkingEcho, preserveThinkingOnlyAssistant)

  // Pass 7: Filter trailing thinking from last assistant message
  result = filterTrailingThinkingFromLastAssistant(result, strictThinkingEcho)

  // Pass 8: Remove whitespace-only assistant messages
  result = filterWhitespaceOnlyAssistant(result)

  // Pass 9: Ensure assistant messages have non-empty content
  result = ensureNonEmptyAssistantContent(result, strictThinkingEcho)

  // Pass 10: Fold adjacent system-reminder messages
  result = smooshSystemReminderSiblings(result)

  // Pass 11: Sanitize oversized error tool_result content
  result = sanitizeErrorToolResultContent(result)

  // Pass 12: Add message tags for snip tool
  result = appendMessageTagToUserMessage(result)

  // Ensure tool_use/tool_result pairing invariant
  result = ensureToolUseResultPairing(result)

  if (options?.applyAnthropicInvariants !== false) {
    result = fixAssistantThinkingNotLastBlock(result, strictThinkingEcho)
    result = stripExcessImageBlocks(result)
  }

  if (options?.stripInternalMeta !== false) {
    result = stripInternalFields(result)
  }

  return result
}

/**
 * Stable opening-tag substring that identifies a `prependUserContext`-
 * produced user-meta message in the wire payload. Other host-injected
 * `<system-reminder>` blocks (task ledger, sub-agent context updates,
 * compact summaries) do NOT carry this attribute, so the dedup pass
 * below targets only this specific producer.
 *
 * Why a content-shape marker (Stage 10 audit fix):
 *   - `_convertedFromSystem: true` is listed in `INTERNAL_KEYS` and gets
 *     stripped by `stripInternalFields`, which is called inside
 *     `normalizeMessagesForAPI` BEFORE `prependUserContext` runs at the
 *     streamHandler call site. A flag-based dedup never finds anything
 *     in production.
 *   - The wire payload itself, on the other hand, IS a stable signal —
 *     and embedding the marker as an HTML-style attribute on the
 *     `<system-reminder>` tag is benign for the model (the host runtime
 *     contract already explains the `<system-reminder>` semantics; the
 *     attribute is informational).
 */
const USER_META_OPENING_TAG = '<system-reminder type="user-meta-context">'
const USER_META_CLOSING_TAG = '</system-reminder>'

function isLeadingUserMetaContextMessage(msg: Msg): boolean {
  if (msg.role !== 'user') return false
  const c = msg.content
  if (typeof c !== 'string') return false
  return c.startsWith(USER_META_OPENING_TAG)
}

/**
 * Prepend a user context meta-message (CLAUDE.md + date + memory + LSP +
 * env + session + skill index) as the first message. Uses <system-reminder>
 * tag wrapping per upstream report Step 16.
 *
 * Stage 10 — strips any stale leading user-meta message before prepending
 * the fresh one, identified by the dedicated `<system-reminder
 * type="user-meta-context">` opening tag. Without this, a re-entry into
 * `prependUserContext` (e.g. a downstream caller that re-prepends after
 * normalization) would silently double-inject; with it, repeated calls
 * are idempotent at the wire level.
 */
export function prependUserContext(
  messages: Msg[],
  userContext: string,
): Msg[] {
  // Drop any pre-existing leading user-meta-context messages before
  // placing the new one. Only consecutive leading user-meta-context msgs
  // are stripped; non-meta user/assistant turns and OTHER kinds of
  // user-meta (task ledger, compact summary, sub-agent inject) are not
  // touched.
  let head = 0
  while (head < messages.length && isLeadingUserMetaContextMessage(messages[head]!)) {
    head++
  }
  const stripped = head === 0 ? messages : messages.slice(head)

  if (!userContext || !userContext.trim()) return stripped
  return [
    {
      role: 'user',
      content: `${USER_META_OPENING_TAG}\n${userContext.trim()}\n${USER_META_CLOSING_TAG}`,
      _convertedFromSystem: true,
    },
    ...stripped,
  ]
}

// `appendSystemContext` was removed in Stage 2 — the only caller
// (streamHandler) was injecting cwd + Today's date that were already
// carried elsewhere (cwd in `# Environment`, date in user-meta), so the
// helper became dead code. Future "append more text to the system field"
// callers should use `mergeSystemPromptLayers` against a layer instead so
// the added text participates in the cache-aware split.

export {
  reorderAttachmentsForAPI,
  stripVirtualMessages,
  filterAndTransform,
  relocateToolReferenceSiblings,
  filterOrphanedThinkingOnly,
  filterTrailingThinkingFromLastAssistant,
  filterWhitespaceOnlyAssistant,
  ensureNonEmptyAssistantContent,
  smooshSystemReminderSiblings,
  sanitizeErrorToolResultContent,
  appendMessageTagToUserMessage,
  stripInternalFields,
}
