/**
 * Enqueue items into the active {@link OrchestrationKernel} inbox for a **conversation id**
 * (processed on the next `runLegacyDelegateMainChat` → PrepareContext → {@link flushInboxToTranscript}).
 */

import { randomUUID } from 'node:crypto'
import type { KernelInboxItem } from './kernelTypes'
import { USER_INPUT_INBOX_SOURCE } from './kernelTypes'
import { getOrchestrationKernelForConversation } from './activeKernelRegistry'

/**
 * `'no_conversation'`  — caller did not supply a usable `conversationId`.
 * `'no_kernel'`        — conversationId is valid but no active kernel is registered yet
 *                        (renderer should retry once the conversation kernel is online).
 * `'empty_payload'`    — conversationId + kernel are fine but the item content is empty
 *                        (empty synthetic text / empty slash name / empty mailbox lines /
 *                        empty toolUseId). Distinct from `'no_conversation'` so callers can
 *                        give correct feedback to the user (audit P0 fix §4.3).
 */
export type InboxEnqueueResult =
  | { ok: true; inboxItemId: string }
  | { ok: false; reason: 'no_conversation' | 'no_kernel' | 'empty_payload' }

function withInboxItemId(item: KernelInboxItem): KernelInboxItem & { inboxItemId: string } {
  const inboxItemId = item.inboxItemId?.trim() || randomUUID()
  return { ...item, inboxItemId }
}

function enqueueForConversation(conversationId: string, item: KernelInboxItem): InboxEnqueueResult {
  const id = conversationId.trim()
  if (!id) return { ok: false, reason: 'no_conversation' }
  const kernel = getOrchestrationKernelForConversation(id)
  if (!kernel) return { ok: false, reason: 'no_kernel' }
  const stamped = withInboxItemId(item)
  kernel.enqueueInboxItem(stamped)
  return { ok: true, inboxItemId: stamped.inboxItemId }
}

/**
 * Append synthetic user-visible text to the kernel inbox for the next main-chat prepare phase.
 * Requires an in-flight kernel registered for `conversationId`.
 */
export function enqueueSyntheticUserText(
  conversationId: string,
  text: string,
  source?: string,
): InboxEnqueueResult {
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body) return { ok: false, reason: 'empty_payload' }
  return enqueueForConversation(conversationId, {
    kind: 'synthetic_user_text',
    text,
    ...(typeof source === 'string' && source.trim() ? { source: source.trim() } : {}),
  })
}

/**
 * Append a REAL user message typed mid-turn (2026-07 复审 N2 fix). Same
 * queue as {@link enqueueSyntheticUserText}, but the item is stamped with
 * {@link USER_INPUT_INBOX_SOURCE} so the mid-turn drain delivers it to the
 * model under the instruction-level `kernel_user_input` side-channel kind
 * instead of the generic "host background" envelope. Callers MUST only use
 * this for text the human actually typed — never for host-synthesised text.
 */
export function enqueueMidTurnUserInput(
  conversationId: string,
  text: string,
): InboxEnqueueResult {
  return enqueueSyntheticUserText(conversationId, text, USER_INPUT_INBOX_SOURCE)
}

export function enqueueSlashCommand(
  conversationId: string,
  name: string,
  args = '',
): InboxEnqueueResult {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) return { ok: false, reason: 'empty_payload' }
  return enqueueForConversation(conversationId, {
    kind: 'slash_command',
    name: n,
    args: typeof args === 'string' ? args : String(args),
  })
}

export function enqueueInterAgentMailboxDraft(
  conversationId: string,
  lines: string[],
): InboxEnqueueResult {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { ok: false, reason: 'empty_payload' }
  }
  return enqueueForConversation(conversationId, {
    kind: 'inter_agent_mailbox_draft',
    lines: lines.map((l) => String(l)),
  })
}

/**
 * push a Human-In-The-Loop resume value into the kernel inbox.
 *
 * Called from the renderer-side IPC handler after the user answers a paused
 * `AskUserQuestion` (or future permission "ask" prompt). The value MUST be JSON-serialisable
 * so the inbox persistence file stays valid JSON.
 *
 * Requires a registered kernel for `conversationId`.
 * Returns `{ ok: false, reason: 'no_kernel' }` when called before the conversation's kernel
 * is constructed — the renderer should retry once the user re-enters the chat.
 */
export function enqueueHumanResume(
  conversationId: string,
  toolUseId: string,
  value: unknown,
): InboxEnqueueResult {
  const tid = typeof toolUseId === 'string' ? toolUseId.trim() : ''
  if (!tid) return { ok: false, reason: 'empty_payload' }
  return enqueueForConversation(conversationId, {
    kind: 'pending_human_resume',
    toolUseId: tid,
    value,
  })
}
