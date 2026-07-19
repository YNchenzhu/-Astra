/**
 * Shared message-history query helpers used by host-attachment
 * collectors (stale-todo / stale-task nudges and any future
 * "look back over recent assistant activity" attachment).
 *
 * Both predicates operate on the orchestrator's normalised
 * `state.apiMessages` array — assistant messages with structured
 * `content` blocks plus side-channel user messages. They are
 * deliberately tolerant of unknown block shapes so a transcript
 * loaded from disk (post-`stripInternalMeta`) flows through the
 * same path as live in-memory frames.
 */

import { readSideChannelKind } from '../../../constants/sideChannelKinds'

/**
 * `true` when the assistant message contains nothing but thinking
 * blocks (no `text` / `tool_use` / `tool_result`). Intermediate
 * frames like these should not count toward "assistant turns" —
 * they represent the model thinking aloud, not a completed turn.
 */
export function isThinkingOnlyAssistantMessage(msg: Record<string, unknown>): boolean {
  const content = msg.content
  if (!Array.isArray(content)) return false
  if (content.length === 0) return false
  for (const block of content as Array<Record<string, unknown>>) {
    const t = block?.type
    if (t !== 'thinking' && t !== 'redacted_thinking') return false
  }
  return true
}

/**
 * `true` when any assistant message in the last `withinTurns`
 * assistant turns contains a `tool_use` block matching one of
 * `toolNames`. Thinking-only frames are skipped (do not consume
 * the window). Returns `false` early when `withinTurns <= 0`
 * (lets callers disable the cross-mute by setting the budget to 0).
 *
 * Note on the bound: the function inspects up to AND including
 * the `withinTurns`-th most recent non-thinking assistant turn. So
 * `withinTurns=5` means "did the model use one of these tools in
 * the last 5 real assistant turns?".
 */
export function hasRecentToolUse(
  messages: ReadonlyArray<Record<string, unknown>>,
  toolNames: ReadonlyArray<string>,
  withinTurns: number,
): boolean {
  if (withinTurns <= 0) return false
  const wanted = new Set(toolNames)
  let assistantTurnsSeen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'assistant') continue
    if (isThinkingOnlyAssistantMessage(msg as Record<string, unknown>)) continue
    assistantTurnsSeen++
    if (assistantTurnsSeen > withinTurns) return false
    const content = (msg as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_use' && typeof block.name === 'string' && wanted.has(block.name)) {
        return true
      }
    }
  }
  return false
}

/**
 * `true` when a **genuine human** user message appears more recently
 * than the most recent assistant `tool_use` matching one of
 * `toolNames` (or when there is a human message and no such tool_use
 * at all).
 *
 * "Genuine human" = a `role:'user'` message that is NOT a host-injected
 * side-channel envelope (`_convertedFromSystem` / `_sideChannelKind` /
 * a recognised bracket marker). Those synthetic frames are the nudges
 * and ledgers the host itself appends — they must not count as "the
 * user spoke".
 *
 * ## Why the stale-{todo,task} nudges consult this
 *
 * The nudges exist to catch a model that has been grinding
 * autonomously for many turns and forgot to update its checklist /
 * task list. But when the *human* has spoken since the last
 * planning-tool call, the human is actively steering — re-surfacing
 * the prior (possibly now-irrelevant) list as a `<system-reminder>`
 * right after a fresh human instruction is exactly the failure mode
 * where the model abandons the user's narrow request and resumes
 * stale work. Suppressing the nudge in that window keeps it scoped to
 * genuine autonomous drift.
 *
 * `toolNames` is the set that counts as "planning activity" for the
 * caller: `['TodoWrite']` for the V1 nudge, `['TaskCreate',
 * 'TaskUpdate']` for the V2 nudge.
 */
export function hasGenuineHumanTurnSinceLastToolUse(
  messages: ReadonlyArray<Record<string, unknown>>,
  toolNames: ReadonlyArray<string>,
): boolean {
  const wanted = new Set(toolNames)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    const role = msg.role

    if (role === 'assistant') {
      const content = (msg as Record<string, unknown>).content
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (
            block?.type === 'tool_use' &&
            typeof block.name === 'string' &&
            wanted.has(block.name)
          ) {
            // Reached the most recent planning-tool call before finding
            // a human turn — nothing human has happened since.
            return false
          }
        }
      }
      continue
    }

    if (role === 'user') {
      if ((msg as Record<string, unknown>)._convertedFromSystem === true) continue
      if (readSideChannelKind(msg as Record<string, unknown>) !== null) continue
      // A real human message newer than the last planning-tool call.
      return true
    }
  }
  return false
}
