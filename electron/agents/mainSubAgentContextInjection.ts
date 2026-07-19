/**
 * Injects new background sub-agent streamed text into the next main `ai:send-message` turn,
 * so the primary model sees Explore (etc.) output without calling TeamStatus.
 */

import { getActiveAgents } from './activeAgentRegistry'
import type { ActiveAgent } from './types'
import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'
import {
  drainUndeliveredSubAgentOutputs,
  restoreUndeliveredSubAgentOutputs,
  type UndeliveredSubAgentEntry,
} from './undeliveredSubAgentBuffer'

/**
 * Detects whether the assistant message at this index has any `tool_use`
 * block whose matching `tool_result` does not appear in `messages[idx+1]`.
 * Used by {@link injectPendingSubAgentOutputsForMainTurn} to refuse to
 * splice a synthetic user message between an unfulfilled assistant
 * tool_use and its (yet-to-arrive) tool_result — that ordering breaks the
 * Anthropic and DeepSeek "tool_use must be immediately followed by
 * tool_result" invariant and would force `ensureToolUseResultPairing` to
 * synthesise an error result that gets glued to our markdown.
 */
function assistantHasOrphanToolUse(
  messages: ReadonlyArray<MainLoopChatMessage>,
  assistantIdx: number,
): boolean {
  const msg = messages[assistantIdx]
  if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return false
  const need = new Set<string>()
  for (const b of msg.content as Array<Record<string, unknown>>) {
    if (b && b.type === 'tool_use' && typeof b.id === 'string') need.add(b.id)
  }
  if (need.size === 0) return false
  const next = messages[assistantIdx + 1]
  if (!next || next.role !== 'user' || !Array.isArray(next.content)) return need.size > 0
  for (const b of next.content as Array<Record<string, unknown>>) {
    if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      need.delete(b.tool_use_id)
    }
  }
  return need.size > 0
}

const MAX_PER_AGENT_CHARS = 12_000
const MAX_TOTAL_CHARS = 28_000

function shouldIncludeAgentForMainInjection(agent: ActiveAgent): boolean {
  const p = agent.parentAgentId
  if (p !== undefined && p !== 'main') return false
  return true
}

/**
 * Per-agent mutation record so {@link rewindMainContextDeliveryOffsetForLastCollect}
 * can precisely undo BOTH the delivery-offset advance and the
 * `terminalNotifiedToMain` flag flip when the caller (orphan tool_use
 * guard) decides to defer the synthetic injection for one turn. Without
 * this, the previous coarse "subtract MAX_PER_AGENT_CHARS from every
 * eligible agent" rewind would silently swallow a one-shot terminal
 * notice (the flag stays `true` even though the markdown was never
 * delivered → next turn the agent is filtered out and the parent never
 * learns its child died).
 */
type CollectMutation = {
  agentId: string
  prevOffset: number | undefined
  prevTerminalNotified: boolean | undefined
}
let lastCollectMutations: CollectMutation[] = []
/**
 * Buffered (already-unregistered) entries consumed by the last collect —
 * restored to the buffer when the rewind path defers the injection.
 */
let lastCollectDrainedBuffer: UndeliveredSubAgentEntry[] = []

/** Render one parked (post-unregister) entry — mirrors the live-agent section shape. */
function renderBufferedEntry(e: UndeliveredSubAgentEntry): string {
  const labelParts = [
    `**Sub-agent** (${e.agentType}) \`${e.agentId}\``,
    e.name ? `name: ${e.name}` : '',
    `status: ${e.status}`,
  ].filter(Boolean)
  const errorLine = e.terminalError
    ? `\n\n**Error**: ${e.terminalError.slice(0, 800)}`
    : ''
  const piece = e.undeliveredText.slice(0, MAX_PER_AGENT_CHARS)
  const truncatedNote =
    e.undeliveredText.length > MAX_PER_AGENT_CHARS
      ? `\n\n_[Output truncated; use TaskOutput with task_id="${e.agentId}" for the full text if still within retention.]_`
      : ''
  const emptyNote = !piece.trim()
    ? `\n\n_[Sub-agent reached terminal status (${e.status}) without undelivered streamed output.${e.terminalError ? ' See error above.' : ''}]_`
    : ''
  return `${labelParts.join(' · ')}${errorLine}\n\n${piece}${emptyNote}${truncatedNote}`
}

function collectPendingSubAgentOutputMarkdown(): string {
  const sections: string[] = []
  let totalChars = 0
  lastCollectMutations = []
  lastCollectDrainedBuffer = []

  const candidates = [...getActiveAgents().values()]
    .filter(shouldIncludeAgentForMainInjection)
    .sort((a, b) => a.agentId.localeCompare(b.agentId))

  for (const ag of candidates) {
    const full = ag.latestTextOutput ?? ''
    let start = ag.mainContextDeliveryOffset ?? 0
    if (full.length < start) {
      start = 0
      ag.mainContextDeliveryOffset = 0
    }

    const delta = full.slice(start)
    const isTerminal = ag.status !== 'running'
    const needsTerminalNotice = isTerminal && !ag.terminalNotifiedToMain
    // C9 — keep the old short-circuit for running agents with nothing new
    // (the most common case), but DO emit a status-only notice for any
    // sub-agent that has just transitioned to a terminal state — even
    // when it produced no text. Without this, a background sub-agent
    // that crashes during boot or fails before streaming a single token
    // would never show up in the parent's context, leaving the parent
    // unaware its child died.
    if (!delta.trim() && !needsTerminalNotice) continue

    const take = Math.min(delta.length, MAX_PER_AGENT_CHARS)
    const piece = delta.slice(0, take)
    const truncatedThisTurn = delta.length > take
    ag.mainContextDeliveryOffset = start + take

    const labelParts = [
      `**Sub-agent** (${ag.agentType}) \`${ag.agentId}\``,
      ag.name ? `name: ${ag.name}` : '',
      isTerminal ? `status: ${ag.status}` : '',
    ].filter(Boolean)

    const terminalErrorLine =
      isTerminal && ag.terminalError
        ? `\n\n**Error**: ${ag.terminalError.slice(0, 800)}`
        : ''
    const terminalEmptyLine =
      isTerminal && !piece.trim()
        ? `\n\n_[Sub-agent reached terminal status (${ag.status}) without producing any streamed output.${
            ag.terminalError ? ' See error above.' : ''
          }]_`
        : ''

    let body = `${labelParts.join(' · ')}${terminalErrorLine}\n\n${piece}${terminalEmptyLine}`
    if (truncatedThisTurn) {
      body +=
        '\n\n_[More output remains; send another message to continue receiving this agent text in context.]_'
    }

    if (totalChars + body.length > MAX_TOTAL_CHARS) {
      sections.push(
        '_[Additional sub-agent output omitted this turn (global cap). Send another message to pull more.]_',
      )
      break
    }
    sections.push(body)
    totalChars += body.length
    lastCollectMutations.push({
      agentId: ag.agentId,
      prevOffset: start,
      prevTerminalNotified: needsTerminalNotice ? false : ag.terminalNotifiedToMain,
    })
    if (needsTerminalNotice) {
      ag.terminalNotifiedToMain = true
    }
  }

  // Parked entries from agents that were already UNREGISTERED before this
  // collect ran (audit 2026-06 — the 5s post-terminal unregister window).
  // Rendered after live agents; anything that does not fit the global cap
  // goes back to the buffer and is delivered on the next turn.
  const parked = drainUndeliveredSubAgentOutputs()
  for (let i = 0; i < parked.length; i++) {
    const body = renderBufferedEntry(parked[i])
    if (totalChars + body.length > MAX_TOTAL_CHARS) {
      restoreUndeliveredSubAgentOutputs(parked.slice(i))
      sections.push(
        '_[Additional sub-agent output omitted this turn (global cap). Send another message to pull more.]_',
      )
      break
    }
    sections.push(body)
    totalChars += body.length
    lastCollectDrainedBuffer.push(parked[i])
  }

  if (sections.length === 0) return ''

  return (
    '[Background sub-agents — new output since your last reply]\n\n' +
    'The following was produced by background worker(s) spawned from this chat (Agent tool). ' +
    'It is context only, not proof that the requested work is complete. ' +
    'Incorporate it if relevant to the latest user message, and verify before making completion claims.\n\n' +
    sections.join('\n\n---\n\n')
  )
}

/** Main chat rows passed to `streamText` / `runAgenticLoop` (text or Anthropic-style blocks). */
export type MainLoopChatMessage = {
  role: 'user' | 'assistant'
  content: string | Array<Record<string, unknown>>
  /** Hint to downstream pipeline that this is system-side context. */
  _convertedFromSystem?: boolean
  /** Typed side-channel kind from the dictionary (when applicable). */
  _sideChannelKind?: string
}

/**
 * When the main session sends a new user turn, prepend a synthetic user
 * message with pending sub-agent text.
 *
 * P0-3 — wrap the markdown in `<system-reminder>` and tag with
 * `_convertedFromSystem` so:
 *   - the model treats this as system-side context, not as the user's words;
 *   - `mergeConsecutiveUserMessages` joining it with the actual user
 *     message no longer makes the joined string read as "user told me X".
 *
 * P0-4 — when the last assistant message has an unfulfilled `tool_use`
 * (last assistant block awaiting its `tool_result`), splicing or appending
 * a synthetic user message would let `ensureToolUseResultPairing` glue a
 * synthetic error `tool_result` to our markdown body. Skip injection
 * entirely in that case; the same delta is delivered next turn once the
 * tool_result arrives.
 *
 * P0-5 — when the last user message already carries `tool_result` blocks
 * for the immediately-preceding assistant `tool_use` (common in the
 * `post_tool` collector call site, where this helper fires right after
 * tool execution pushed `[assistant(tool_use), user(tool_result)]`),
 * splicing BEFORE that user would put a side-channel text user between
 * `tool_use` and its `tool_result`. Anthropic-compat gateways
 * (DeepSeek / Kimi / Zhipu / custom-anthropic-compat) reject the request
 * with HTTP 400 `tool_use ids were found without tool_result blocks
 * immediately after`. Append AFTER the tool_result user instead — the
 * downstream `mergeConsecutiveUserMessages` will fold the two user turns
 * so the sub-agent text rides as an extra text block after the
 * tool_results, keeping pairing adjacent.
 */
export function injectPendingSubAgentOutputsForMainTurn(
  messages: MainLoopChatMessage[],
): MainLoopChatMessage[] {
  const markdown = collectPendingSubAgentOutputMarkdown()
  if (!markdown.trim()) return messages

  const wrapped = wrapSideChannelBody(SIDE_CHANNEL_KIND.subAgentUpdate, markdown)
  const out = messages.slice()
  const lastIdx = out.length - 1

  if (lastIdx >= 0 && out[lastIdx]!.role === 'user') {
    // Last is user: splice the synthetic message before it. The assistant
    // immediately preceding (if any) must not have an unfulfilled tool_use.
    const prevAssistantIdx = lastIdx - 1
    if (
      prevAssistantIdx >= 0 &&
      out[prevAssistantIdx]!.role === 'assistant' &&
      assistantHasOrphanToolUse(out, prevAssistantIdx)
    ) {
      // Defer this delta — offset has already been advanced inside
      // `collectPendingSubAgentOutputMarkdown`, so we'd lose this slice
      // permanently. Roll the offset back by re-zeroing only when safe:
      // simpler is to rewind the offset advance we just made.
      rewindMainContextDeliveryOffsetForLastCollect(markdown.length)
      return messages
    }

    // P0-5 — when the last user already carries `tool_result` blocks for
    // the previous assistant's `tool_use` (the post_tool collector case,
    // or a stop-then-resend case the renderer entry observed), splicing
    // the synthetic user BEFORE it would put a non-tool_result user
    // message between `assistant(tool_use)` and `user(tool_result)`. The
    // Anthropic-compat wire validator (DeepSeek / Kimi / Zhipu / ...) 400s
    // with "tool_use ids were found without tool_result blocks immediately
    // after" because it only accepts the IMMEDIATELY-next user message as
    // the pairing slot.
    //
    // `ensureToolUseResultPairing` doesn't repair this on its own — it
    // scans CONSECUTIVE user messages and considers the pairing satisfied
    // as long as the ids appear somewhere in the chain, never relocating
    // blocks across user-message boundaries. So we have to avoid creating
    // the broken shape in the first place.
    //
    // Append AFTER the tool_result user instead: the wire-level
    // `mergeConsecutiveUserMessages` will fold the two adjacent user turns
    // into one, the sub-agent text becomes an additional text block after
    // the tool_results in the merged content, and pairing stays intact.
    const lastContent = out[lastIdx]!.content
    const lastUserHasToolResults =
      Array.isArray(lastContent) &&
      (lastContent as Array<Record<string, unknown>>).some(
        (b) => b?.type === 'tool_result',
      )
    if (lastUserHasToolResults) {
      out.push({
        role: 'user',
        content: wrapped,
        _convertedFromSystem: true,
        _sideChannelKind: SIDE_CHANNEL_KIND.subAgentUpdate,
      })
      return out
    }

    out.splice(lastIdx, 0, {
      role: 'user',
      content: wrapped,
      _convertedFromSystem: true,
      _sideChannelKind: SIDE_CHANNEL_KIND.subAgentUpdate,
    })
  } else if (
    lastIdx >= 0 &&
    out[lastIdx]!.role === 'assistant' &&
    assistantHasOrphanToolUse(out, lastIdx)
  ) {
    // Last is an assistant with an orphan tool_use — appending here would
    // break tool_use→tool_result pairing.
    rewindMainContextDeliveryOffsetForLastCollect(markdown.length)
    return messages
  } else {
    out.push({
      role: 'user',
      content: wrapped,
      _convertedFromSystem: true,
      _sideChannelKind: SIDE_CHANNEL_KIND.subAgentUpdate,
    })
  }
  return out
}

/**
 * P0-4 helper — when injection is deferred (orphan tool_use present), undo
 * BOTH the delivery-offset advance and the `terminalNotifiedToMain` flag
 * flip that {@link collectPendingSubAgentOutputMarkdown} just wrote. Uses
 * the precise per-agent record from `lastCollectMutations` so an agent
 * that received a terminal notice this round goes back to "not yet
 * notified" — the next clean turn re-emits the notice instead of
 * silently dropping the parent's only signal that its child finished.
 */
function rewindMainContextDeliveryOffsetForLastCollect(_totalChars: number): void {
  // Buffered (post-unregister) entries consumed by the deferred collect
  // must survive to the next clean turn — put them back first.
  if (lastCollectDrainedBuffer.length > 0) {
    restoreUndeliveredSubAgentOutputs(lastCollectDrainedBuffer)
    lastCollectDrainedBuffer = []
  }
  if (lastCollectMutations.length === 0) return
  const byId = new Map<string, ActiveAgent>()
  for (const ag of getActiveAgents().values()) {
    byId.set(ag.agentId, ag)
  }
  for (const m of lastCollectMutations) {
    const ag = byId.get(m.agentId)
    if (!ag) continue
    ag.mainContextDeliveryOffset = m.prevOffset
    ag.terminalNotifiedToMain = m.prevTerminalNotified
  }
  lastCollectMutations = []
}
