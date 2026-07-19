/**
 * Pure placement helper for orphan sub-agents (no `parentToolId`) in the
 * chat timeline.
 *
 * Background — three orphan-spawn sources need a slot in the messages array:
 *   1. **Post-stream hook** of a turn that just ended (e.g. session-memory-
 *      internal extract, although that one is hidden by the
 *      `SESSION_MEMORY_INTERNAL_AGENT_TYPE` short-circuit upstream).
 *   2. **Skill / Debug / REPL fork** dispatched mid-stream while the main
 *      turn is still producing text + tool batches.
 *   3. **Ambient buddy / background spawn** with no clear trigger turn (rare,
 *      typically only on a fresh conversation).
 *
 * The previous placement rule was "always create a standalone
 * `subagent-msg-<agentId>` message and slot it near the trigger", which
 * worked for (1) but produced an ugly "ghost bubble" for (2) — the orphan
 * card would land **between the user's question and the still-streaming
 * 星构Astra reply**, visually splitting the turn into two halves.
 *
 * New rule:
 *   - Strategy A — finished anchor: insert a standalone bubble RIGHT AFTER
 *     the most recent assistant turn whose stream has ended.
 *   - Strategy B — streaming bubble (UPDATED): **merge** the SubAgentDisplay
 *     into the streaming assistant's `subAgents` array (no standalone
 *     bubble). The renderer's orphan-subAgent path (`ChatMessage.tsx`)
 *     surfaces it inside the main reply bubble.
 *   - Strategy C — no assistant at all: append a standalone bubble at the
 *     end (preserves original semantics for brand-new conversations).
 *
 * The helper is intentionally pure (no module-level state, no React
 * dependencies) so the placement contract can be pinned by a unit test
 * without spinning up the full zustand store.
 */

import type { ChatMessage, SubAgentDisplay } from '../../types'

export interface PlaceOrphanResult {
  /** New messages array. Reference-equal to input when no slot existed (caller may skip). */
  messages: ChatMessage[]
  /** How the orphan landed — handy for telemetry / asserts. */
  placement: 'inserted-after-finished' | 'merged-into-streaming' | 'appended-no-anchor'
}

export function placeOrphanSubAgent(
  messages: ChatMessage[],
  subAgent: SubAgentDisplay,
  standaloneMsgId: string,
  now: number = Date.now(),
): PlaceOrphanResult {
  // Strategy A: most recent FINISHED assistant turn → insert standalone right after.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    if (m.isStreaming) continue
    if (typeof m.id === 'string' && m.id.startsWith('subagent-msg-')) continue
    const newMsg: ChatMessage = {
      id: standaloneMsgId,
      role: 'assistant',
      content: '',
      timestamp: now,
      subAgents: [subAgent],
    }
    return {
      messages: [...messages.slice(0, i + 1), newMsg, ...messages.slice(i + 1)],
      placement: 'inserted-after-finished',
    }
  }

  // Strategy B (UPDATED): no finished anchor, but a streaming bubble exists →
  // merge the orphan INTO that bubble's `subAgents` array instead of slotting
  // a separate `subagent-msg-*` bubble before it. This avoids the
  // user-message-then-ghost-bubble-then-星构Astra visual the old behaviour
  // produced (Skill / Debug fork dispatched while the main turn was still in
  // flight). Downstream `subagent_*` events still locate this sub-agent via
  // `findAssistantIndexWithSubAgent` because it is now part of a real
  // assistant message's `subAgents`.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    if (!m.isStreaming) continue
    if (typeof m.id === 'string' && m.id.startsWith('subagent-msg-')) continue
    return {
      messages: messages.map((row, ri) =>
        ri === i
          ? {
              ...row,
              subAgents: [...(row.subAgents ?? []), subAgent],
            }
          : row,
      ),
      placement: 'merged-into-streaming',
    }
  }

  // Strategy C: brand-new conversation, no assistant bubble of any kind →
  // append a standalone bubble at the end. The orphan still gets a slot;
  // when the user eventually sends a first reply the standalone will sit
  // ABOVE that reply, which is the chronologically correct order.
  const newMsg: ChatMessage = {
    id: standaloneMsgId,
    role: 'assistant',
    content: '',
    timestamp: now,
    subAgents: [subAgent],
  }
  return {
    messages: [...messages, newMsg],
    placement: 'appended-no-anchor',
  }
}
