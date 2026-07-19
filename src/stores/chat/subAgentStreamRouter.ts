/**
 * Sub-agent IPC stream dispatch.
 *
 * Installed once via `ensureSubAgentGlobalStream` and kept alive across
 * conversation switches — background sub-agents emit `subagent_*` events
 * after the parent main turn has already sent `message_stop`, so the
 * listener cannot be tied to a single sendMessage lifetime.
 *
 * Keyed by `agentId` (a branded string cast via `asAgentId`) rather than
 * the current sendMessage `assistantId` so ping / mailbox replies still
 * land on the correct sub-agent block even after the parent turn ended.
 *
 * All mutations go through `patchConversationSlice` when the event carries
 * a `conversationId` — enabling the "in a background tab" case. Events
 * without a conversationId fall back to mutating the currently-visible
 * conversation, matching the pre-split behavior.
 */
import type {
  ChatMessage,
  StreamEvent,
  SubAgentDisplay,
  ToolUseDisplay,
  TodoItem,
} from '../../types'
import { asAgentId } from '../../types/ids'
import { onStreamEvent } from '../../services/electronAPI'
import { useSettingsStore } from '../useSettingsStore'
import { maybeDesktopNotify } from './desktopNotify'
import { parseTodoItemsFromToolOutput } from './parseTodoItems'
import {
  patchConversationSlice,
  findAssistantIndexWithSubAgent,
  findAssistantIndexForNewSubAgent,
  mergeSubAgentOutputChunk,
} from './sessionSlice'
import { placeOrphanSubAgent } from './placeOrphanSubAgent'
import { closeRunningSubAgentToolUses } from './subAgentToolState'
import { chatStoreApi } from './storeApiRef'
import type { ChatState, SessionMemoryStatus } from './types'

/**
 * Internal host agent type — runs after assistant turns to write
 * `~/.claude/session-memory/<convId>.md`. Surfaced as a small header pill
 * (`SessionMemoryIndicator`) instead of as a chat-timeline bubble.
 */
const SESSION_MEMORY_INTERNAL_AGENT_TYPE = 'session-memory-internal'

let subAgentGlobalUnsub: (() => void) | null = null

/** Tracks agentIds whose `subagent_start` has already been processed this
 *  session, preventing duplicate standalone messages when both the global
 *  and per-conversation listeners fire within the same React batch. */
const startedAgentIds = new Set<string>()

/**
 * Tracks agentIds we have classified as `session-memory-internal`. Subsequent
 * `subagent_*` events for these ids skip the messages-array path entirely and
 * route into `sessionMemoryStatus` for the header indicator instead.
 */
const sessionMemoryAgentIds = new Set<string>()

function subAgentTargetConvId(event: StreamEvent, s: ChatState): string | null {
  const raw = event.conversationId
  if (raw != null && String(raw).trim()) return String(raw).trim()
  return s.currentConversationId
}

/**
 * Patch `sessionMemoryStatus[convId]` immutably. No-op when convId is missing.
 * Falling back to `currentConversationId` is handled by the caller via
 * `subAgentTargetConvId`.
 */
function patchSessionMemoryStatus(
  s: ChatState,
  convId: string | null,
  patch: Partial<SessionMemoryStatus> & Pick<SessionMemoryStatus, 'agentId'>,
): Partial<ChatState> {
  if (!convId) return {}
  const prev = s.sessionMemoryStatus[convId]
  // Stale events from a different (older) run on the same conversation: ignore.
  if (prev && prev.agentId !== patch.agentId && prev.status === 'running') {
    // The newer run wins only if the incoming patch is a `start` (status:
    // 'running' and a fresh startedAt). Other events for stale ids are dropped.
    if (patch.status !== 'running') return {}
  }
  const next: SessionMemoryStatus = {
    agentId: patch.agentId,
    status: patch.status ?? prev?.status ?? 'running',
    startedAt: patch.startedAt ?? prev?.startedAt ?? Date.now(),
    completedAt: patch.completedAt ?? prev?.completedAt,
    totalDurationMs: patch.totalDurationMs ?? prev?.totalDurationMs,
    totalTokens: patch.totalTokens ?? prev?.totalTokens,
    errorMessage: patch.errorMessage ?? prev?.errorMessage,
  }
  return {
    sessionMemoryStatus: { ...s.sessionMemoryStatus, [convId]: next },
  }
}

/**
 * Tear down only the sub-agent global stream (symmetric to
 * `ensureSubAgentGlobalStream`). Exposed so tests and HMR full-resets can
 * drop the module-level listener without also tearing down the main chat
 * router. Production UI does not call this — the listener is intentionally
 * long-lived across conversation switches so late ping / mailbox replies
 * keep rendering.
 */
export function disposeSubAgentGlobalStream(): void {
  if (subAgentGlobalUnsub) {
    subAgentGlobalUnsub()
    subAgentGlobalUnsub = null
  }
}

/**
 * Install the single sub-agent IPC subscription. Idempotent.
 */
export function ensureSubAgentGlobalStream(): void {
  if (subAgentGlobalUnsub) return
  const api = chatStoreApi()
  subAgentGlobalUnsub = onStreamEvent((event: StreamEvent) => {
    const t = event.type
    if (
      t !== 'subagent_start' &&
      t !== 'subagent_text' &&
      t !== 'subagent_thinking_delta' &&
      t !== 'subagent_thinking_block_complete' &&
      t !== 'subagent_redacted_thinking_block' &&
      t !== 'subagent_reasoning_summary_delta' &&
      t !== 'subagent_reasoning_summary_block_complete' &&
      t !== 'subagent_tool_start' &&
      t !== 'subagent_tool_input_delta' &&
      t !== 'subagent_tool_result' &&
      t !== 'subagent_complete' &&
      t !== 'subagent_error' &&
      t !== 'subagent_stream_fallback_reset' &&
      // Phase D (granularity uplift): new typed sub-agent events. The
      // router currently accepts them so they reach the renderer's
      // store layer without being dropped here; component-level
      // consumers can opt into surfacing them (e.g. AgentBlock can
      // render a per-iteration token badge or a compact pill) without
      // any additional plumbing. Until a consumer wires up, these
      // events early-return at the trailing no-op branch below.
      t !== 'subagent_message_end' &&
      t !== 'subagent_context_compact' &&
      t !== 'subagent_max_iterations' &&
      t !== 'subagent_winddown'
    ) {
      return
    }

    // Phase D — accept-and-park: the events are no longer dropped by the
    // whitelist above, but the existing dispatch chain doesn't have a
    // handler for them yet. Returning here is intentional: the signal is
    // reachable (testable, telemetrable, observable in a future patch)
    // without forcing a UI change in the same commit. Remove this
    // early-return when a consumer needs the payload.
    if (
      t === 'subagent_message_end' ||
      t === 'subagent_context_compact' ||
      t === 'subagent_max_iterations' ||
      t === 'subagent_winddown'
    ) {
      return
    }

    if (t === 'subagent_start') {
      if (!event.agentId) return
      // Capture into a `const` so the type stays `string` inside the
      // setState callback below — TS does not propagate the early-return
      // narrowing across an arrow function boundary on `event.agentId`.
      const startAgentId: string = event.agentId

      // Host-internal session-memory agent: don't pollute the chat timeline.
      // Route into `sessionMemoryStatus` so the header pill can render its
      // running / completed / failed state instead.
      if (event.agentType === SESSION_MEMORY_INTERNAL_AGENT_TYPE) {
        if (startedAgentIds.has(startAgentId)) return
        startedAgentIds.add(startAgentId)
        sessionMemoryAgentIds.add(startAgentId)
        api.setState((s) => {
          const convId = subAgentTargetConvId(event, s)
          return patchSessionMemoryStatus(s, convId, {
            agentId: startAgentId,
            status: 'running',
            startedAt: Date.now(),
          })
        })
        return
      }

      api.setState((s) => {
        const convId = subAgentTargetConvId(event, s)
        const parentToolId =
          typeof event.parentToolUseId === 'string' && event.parentToolUseId.trim()
            ? event.parentToolUseId.trim()
            : undefined
        const subAgent: SubAgentDisplay = {
          agentId: asAgentId(startAgentId),
          agentType: event.agentType || 'unknown',
          description: event.description || '',
          name: event.name,
          status: 'running',
          toolUses: [],
          ...(parentToolId ? { parentToolId } : {}),
        }

        // Orphan sub-agents (no parentToolId — Skill fork, Debug/REPL fork,
        // ambient buddy spawn, etc.). Three placement strategies, fully
        // documented in `placeOrphanSubAgent.ts`:
        //   A — finished anchor exists: standalone bubble RIGHT AFTER it
        //       (post-stream hook of the trigger turn, chronologically
        //       correct).
        //   B — only a streaming bubble exists: **merge** SubAgentDisplay
        //       into that bubble's `subAgents` array (renders inside the
        //       main reply — no ghost slot between user msg and the
        //       still-streaming 星构Astra turn).
        //   C — no assistant at all: append standalone at end.
        if (!parentToolId) {
          // Guard against duplicate handling (both global + per-conversation
          // listeners can fire within the same React batch using stale state
          // snapshots — a module-level Set is deterministic).
          if (startedAgentIds.has(startAgentId)) return s
          startedAgentIds.add(startAgentId)
          const standaloneMsgId = `subagent-msg-${startAgentId}`
          const placeInto = (msgs: ChatMessage[]): ChatMessage[] =>
            placeOrphanSubAgent(msgs, subAgent, standaloneMsgId).messages
          if (!convId) return { messages: placeInto(s.messages) }
          if (convId === s.currentConversationId) {
            return { messages: placeInto(s.messages) }
          }
          return patchConversationSlice(s, convId, (sl) => {
            if (findAssistantIndexWithSubAgent(sl.messages, startAgentId) >= 0) return sl
            return { ...sl, messages: placeInto(sl.messages) }
          })
        }

        // Has parentToolId: attach to the message containing that tool.
        if (!convId) {
          const idx = findAssistantIndexForNewSubAgent(s.messages)
          if (idx < 0) return s
          const m = s.messages[idx]
          if (m.subAgents?.some((sa) => sa.agentId === event.agentId)) return s
          const messages = s.messages.map((row, i) =>
            i === idx ? { ...row, subAgents: [...(row.subAgents || []), subAgent] } : row,
          )
          return { messages }
        }
        return patchConversationSlice(s, convId, (sl) => {
          const idx = findAssistantIndexForNewSubAgent(sl.messages)
          if (idx < 0) return sl
          const m = sl.messages[idx]
          if (m.subAgents?.some((sa) => sa.agentId === event.agentId)) return sl
          const messages = sl.messages.map((row, i) =>
            i === idx ? { ...row, subAgents: [...(row.subAgents || []), subAgent] } : row,
          )
          return { ...sl, messages }
        })
      })
      return
    }

    if (!event.agentId) return

    // Session-memory-internal events (post-start): only `complete` / `error`
    // affect the indicator. Text / thinking / tool deltas are dropped — we
    // intentionally don't surface the agent's transcript anywhere in the UI.
    if (sessionMemoryAgentIds.has(event.agentId)) {
      const smAgentId = event.agentId
      if (t === 'subagent_complete') {
        const result = event.result as
          | {
              success: boolean
              output: string
              totalDurationMs: number
              totalTokens: number
            }
          | undefined
        api.setState((s) => {
          const convId = subAgentTargetConvId(event, s)
          return patchSessionMemoryStatus(s, convId, {
            agentId: smAgentId,
            status: result?.success ? 'completed' : 'failed',
            completedAt: Date.now(),
            totalDurationMs: result?.totalDurationMs,
            totalTokens: result?.totalTokens,
          })
        })
        sessionMemoryAgentIds.delete(smAgentId)
        // Mirror the normal subagent_complete cleanup at line ~569 — the
        // session-memory branch returns early below, so the parent
        // `startedAgentIds` slot must be released here too. Without this
        // the dedupe Set leaks one entry per session-memory run.
        startedAgentIds.delete(smAgentId)
      } else if (t === 'subagent_error') {
        const errMsg = event.error ? String(event.error).trim() : undefined
        api.setState((s) => {
          const convId = subAgentTargetConvId(event, s)
          return patchSessionMemoryStatus(s, convId, {
            agentId: smAgentId,
            status: 'failed',
            completedAt: Date.now(),
            errorMessage: errMsg,
          })
        })
        sessionMemoryAgentIds.delete(smAgentId)
        startedAgentIds.delete(smAgentId)
      }
      return
    }

    // Brand as AgentId for downstream lookups (SubAgentDisplay.agentId is branded).
    const aid = asAgentId(event.agentId)

    if (t === 'subagent_stream_fallback_reset') {
      api.setState((s) => {
        const convId = subAgentTargetConvId(event, s)
        // Sub-agent uses a flat-field model (no `blocks: []` reset trick the
        // main chat path enjoys), so EVERY content channel must be enumerated
        // by hand. Missed fields silently bleed half-streamed payloads from
        // the aborted attempt into the retry — currently observed when a
        // long reasoning summary was mid-stream and a fallback restart fired
        // (would concat 'old half' + 'new half' into one garbled summary).
        const wipe = (subAgents: SubAgentDisplay[] | undefined) =>
          (subAgents || []).map((sa) =>
            sa.agentId === aid
              ? {
                  ...sa,
                  output: '',
                  thinking: '',
                  isThinking: false,
                  reasoningSummary: '',
                  isReasoningSummarising: false,
                  toolUses: [],
                }
              : sa,
          )
        if (!convId) {
          const idx = findAssistantIndexWithSubAgent(s.messages, aid)
          if (idx < 0) return s
          const messages = s.messages.map((row, i) =>
            i === idx ? { ...row, subAgents: wipe(row.subAgents) } : row,
          )
          return { messages }
        }
        return patchConversationSlice(s, convId, (sl) => {
          const idx = findAssistantIndexWithSubAgent(sl.messages, aid)
          if (idx < 0) return sl
          const messages = sl.messages.map((row, i) =>
            i === idx ? { ...row, subAgents: wipe(row.subAgents) } : row,
          )
          return { ...sl, messages }
        })
      })
      return
    }

    if (t === 'subagent_text') {
      if (event.text == null || event.text === '') return
      api.setState((s) => {
        const convId = subAgentTargetConvId(event, s)
        if (!convId) {
          const idx = findAssistantIndexWithSubAgent(s.messages, aid)
          if (idx < 0) return s
          const messages = s.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid
                ? { ...sa, output: mergeSubAgentOutputChunk(sa.output || '', event.text || '') }
                : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { messages }
        }
        return patchConversationSlice(s, convId, (sl) => {
          const idx = findAssistantIndexWithSubAgent(sl.messages, aid)
          if (idx < 0) return sl
          const messages = sl.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid
                ? { ...sa, output: mergeSubAgentOutputChunk(sa.output || '', event.text || '') }
                : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { ...sl, messages }
        })
      })
      return
    }

    if (t === 'subagent_thinking_delta') {
      if (event.text == null || event.text === '') return
      api.setState((s) => {
        const convId = subAgentTargetConvId(event, s)
        if (!convId) {
          const idx = findAssistantIndexWithSubAgent(s.messages, aid)
          if (idx < 0) return s
          const messages = s.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid
                ? {
                    ...sa,
                    thinking: mergeSubAgentOutputChunk(sa.thinking || '', event.text || ''),
                    isThinking: true,
                  }
                : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { messages }
        }
        return patchConversationSlice(s, convId, (sl) => {
          const idx = findAssistantIndexWithSubAgent(sl.messages, aid)
          if (idx < 0) return sl
          const messages = sl.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid
                ? {
                    ...sa,
                    thinking: mergeSubAgentOutputChunk(sa.thinking || '', event.text || ''),
                    isThinking: true,
                  }
                : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { ...sl, messages }
        })
      })
      return
    }

    if (t === 'subagent_thinking_block_complete') {
      // Sub-agent thinking is UI-only (see SubAgentDisplay.thinking doc:
      // "shown in UI only; not sent to the parent model in tool results").
      // The sub-agent's own agenticLoop handles intra-turn transcript replay
      // via its internal `thinkingBlocks` accumulator, so cross-turn
      // signature plumbing isn't required here. All we need to do in the
      // renderer is mark the thinking stream as settled and replace the
      // merged delta text with the canonical whole-block payload so the
      // UI reflects exactly what the provider signed off on.
      const block = event.thinkingBlock
      if (!block) return
      // `thinkingTimeMs` and `thinkingTokens` are conditionally spread so
      // callers that omit them (legacy / skill fork paths that don't set
      // them yet) produce the same SubAgentDisplay shape as before. Once
      // present they persist alongside `thinking` so the renderer's
      // `<ThinkingBlock>` inside `AgentBlock` can authoritatively snap to
      // the true elapsed time + cost estimate instead of falling back to
      // the tick value held in its module-scoped `durationCache`.
      const timeFragment =
        typeof block.thinkingTimeMs === 'number' && block.thinkingTimeMs > 0
          ? { thinkingTimeMs: block.thinkingTimeMs }
          : {}
      const tokensFragment =
        typeof block.thinkingTokens === 'number' && block.thinkingTokens > 0
          ? { thinkingTokens: block.thinkingTokens }
          : {}
      api.setState((s) => {
        const convId = subAgentTargetConvId(event, s)
        if (!convId) {
          const idx = findAssistantIndexWithSubAgent(s.messages, aid)
          if (idx < 0) return s
          const messages = s.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid
                ? { ...sa, thinking: block.thinking, isThinking: false, ...timeFragment, ...tokensFragment }
                : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { messages }
        }
        return patchConversationSlice(s, convId, (sl) => {
          const idx = findAssistantIndexWithSubAgent(sl.messages, aid)
          if (idx < 0) return sl
          const messages = sl.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid
                ? { ...sa, thinking: block.thinking, isThinking: false, ...timeFragment, ...tokensFragment }
                : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { ...sl, messages }
        })
      })
      return
    }

    if (t === 'subagent_redacted_thinking_block') {
      // Plan Phase 4 — sub-agent 的 redacted_thinking 块。SubAgentDisplay
      // 没有 blocks 数组（与主 chat 的 ChatMessage 不一样），所以无法在 UI
      // 端结构化展示一个独立的"加密 thinking"占位。我们在 UI 上沿用现有的
      // `thinking` 字段标识—简单写一个 "(私密推理已加密)" 占位文本，让
      // AgentBlock 至少看得到有思考发生。
      //
      // **关键**：sub-agent 的 thinking 字段是 UI-only，cross-turn replay
      // 不会经过这里 — sub-agent 的 agenticLoop 内部有自己的 thinkingBlocks
      // accumulator 会维护真正的 redacted_thinking 数据并回灌给 sub-agent
      // 的 API（见 electron/ai/agenticLoop/stream.ts）。这里仅做展示。
      const block = event.redactedThinkingBlock
      if (!block || typeof block.data !== 'string' || !block.data) return
      const placeholder = '(私密推理已加密)'
      api.setState((s) => {
        const convId = subAgentTargetConvId(event, s)
        const patchSubAgent = (sa: SubAgentDisplay): SubAgentDisplay =>
          sa.agentId === aid
            ? { ...sa, thinking: placeholder, isThinking: false }
            : sa
        if (!convId) {
          const idx = findAssistantIndexWithSubAgent(s.messages, aid)
          if (idx < 0) return s
          const messages = s.messages.map((row, i) => {
            if (i !== idx) return row
            return { ...row, subAgents: (row.subAgents || []).map(patchSubAgent) }
          })
          return { messages }
        }
        return patchConversationSlice(s, convId, (sl) => {
          const idx = findAssistantIndexWithSubAgent(sl.messages, aid)
          if (idx < 0) return sl
          const messages = sl.messages.map((row, i) => {
            if (i !== idx) return row
            return { ...row, subAgents: (row.subAgents || []).map(patchSubAgent) }
          })
          return { ...sl, messages }
        })
      })
      return
    }

    if (t === 'subagent_reasoning_summary_delta') {
      // Same model as `subagent_thinking_delta`: accumulate into the
      // sub-agent's flat `reasoningSummary` string + flip
      // `isReasoningSummarising: true`. Empty deltas (transient at the
      // moment a summary block opens) are dropped so a UI flash doesn't
      // happen.
      if (event.text == null || event.text === '') return
      api.setState((s) => {
        const convId = subAgentTargetConvId(event, s)
        if (!convId) {
          const idx = findAssistantIndexWithSubAgent(s.messages, aid)
          if (idx < 0) return s
          const messages = s.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid
                ? {
                    ...sa,
                    reasoningSummary: mergeSubAgentOutputChunk(
                      sa.reasoningSummary || '',
                      event.text || '',
                    ),
                    isReasoningSummarising: true,
                  }
                : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { messages }
        }
        return patchConversationSlice(s, convId, (sl) => {
          const idx = findAssistantIndexWithSubAgent(sl.messages, aid)
          if (idx < 0) return sl
          const messages = sl.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid
                ? {
                    ...sa,
                    reasoningSummary: mergeSubAgentOutputChunk(
                      sa.reasoningSummary || '',
                      event.text || '',
                    ),
                    isReasoningSummarising: true,
                  }
                : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { ...sl, messages }
        })
      })
      return
    }

    if (t === 'subagent_reasoning_summary_block_complete') {
      // Mirror of `subagent_thinking_block_complete` for the summary
      // channel: replace the merged-delta text with the canonical
      // payload + stamp the elapsed / token meta. No signature
      // round-trip — summaries are output-only by API contract.
      const block = event.reasoningSummaryBlock
      if (!block) return
      const timeFragment =
        typeof block.thinkingTimeMs === 'number' && block.thinkingTimeMs > 0
          ? { reasoningSummaryTimeMs: block.thinkingTimeMs }
          : {}
      const tokensFragment =
        typeof block.thinkingTokens === 'number' && block.thinkingTokens > 0
          ? { reasoningSummaryTokens: block.thinkingTokens }
          : {}
      api.setState((s) => {
        const convId = subAgentTargetConvId(event, s)
        if (!convId) {
          const idx = findAssistantIndexWithSubAgent(s.messages, aid)
          if (idx < 0) return s
          const messages = s.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid
                ? {
                    ...sa,
                    reasoningSummary: block.text,
                    isReasoningSummarising: false,
                    ...timeFragment,
                    ...tokensFragment,
                  }
                : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { messages }
        }
        return patchConversationSlice(s, convId, (sl) => {
          const idx = findAssistantIndexWithSubAgent(sl.messages, aid)
          if (idx < 0) return sl
          const messages = sl.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid
                ? {
                    ...sa,
                    reasoningSummary: block.text,
                    isReasoningSummarising: false,
                    ...timeFragment,
                    ...tokensFragment,
                  }
                : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { ...sl, messages }
        })
      })
      return
    }

    if (t === 'subagent_tool_start') {
      if (!event.toolUse) return
      const toolUse = event.toolUse
      const saToolDisplay: ToolUseDisplay = {
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
        status: 'running',
      }
      // Replace any prior `tool_input_delta` placeholder (same id)
      // with the canonical entry, otherwise append. Mirrors the main
      // chat `tool_start` semantics — keeps `streamingInput` cleared
      // and `input` authoritative once the model finished streaming.
      const replaceOrAppend = (toolUses: ToolUseDisplay[]): ToolUseDisplay[] => {
        const i = toolUses.findIndex((t) => t.id === saToolDisplay.id)
        if (i >= 0) {
          const next = toolUses.slice()
          next[i] = saToolDisplay
          return next
        }
        return [...toolUses, saToolDisplay]
      }
      api.setState((s) => {
        const convId = subAgentTargetConvId(event, s)
        if (!convId) {
          const idx = findAssistantIndexWithSubAgent(s.messages, aid)
          if (idx < 0) return s
          const messages = s.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid ? { ...sa, toolUses: replaceOrAppend(sa.toolUses) } : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { messages }
        }
        return patchConversationSlice(s, convId, (sl) => {
          const idx = findAssistantIndexWithSubAgent(sl.messages, aid)
          if (idx < 0) return sl
          const messages = sl.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid ? { ...sa, toolUses: replaceOrAppend(sa.toolUses) } : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { ...sl, messages }
        })
      })
      return
    }

    // IDE-style live writing inside a sub-agent. Creates a
    // running-status placeholder ToolUseDisplay if no prior entry
    // exists yet, then attaches `streamingInput` so the AgentBlock's
    // ToolUseCard can render the in-progress `content` / `newString`.
    // The subsequent `subagent_tool_start` will swap this placeholder
    // for the canonical entry (see `replaceOrAppend` above).
    if (t === 'subagent_tool_input_delta') {
      const toolUseId = event.toolUseId
      const toolName = event.toolName || ''
      const partialJson = event.partialJson || ''
      if (!toolUseId || !partialJson) return
      const upsert = (toolUses: ToolUseDisplay[]): ToolUseDisplay[] => {
        const i = toolUses.findIndex((t) => t.id === toolUseId)
        if (i >= 0) {
          const next = toolUses.slice()
          next[i] = { ...toolUses[i], streamingInput: { partialJson } }
          return next
        }
        if (!toolName) return toolUses
        return [
          ...toolUses,
          {
            id: toolUseId,
            name: toolName,
            input: {} as Record<string, unknown>,
            status: 'running' as ToolUseDisplay['status'],
            streamingInput: { partialJson },
          },
        ]
      }
      api.setState((s) => {
        const convId = subAgentTargetConvId(event, s)
        if (!convId) {
          const idx = findAssistantIndexWithSubAgent(s.messages, aid)
          if (idx < 0) return s
          const messages = s.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid ? { ...sa, toolUses: upsert(sa.toolUses) } : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { messages }
        }
        return patchConversationSlice(s, convId, (sl) => {
          const idx = findAssistantIndexWithSubAgent(sl.messages, aid)
          if (idx < 0) return sl
          const messages = sl.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid ? { ...sa, toolUses: upsert(sa.toolUses) } : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { ...sl, messages }
        })
      })
      return
    }

    if (t === 'subagent_tool_result') {
      if (!event.toolResult) return
      const saToolResult = event.toolResult
      // When a sub-agent calls `TodoWrite` we pull the latest list out of the
      // result payload (same shape the main `tool_result` branch parses) and
      // attach it to `SubAgentDisplay.todos`. This powers the mini task panel
      // rendered inside the sub-agent block; the main conversation's top-level
      // TodoPanel is deliberately **not** updated — each sub-agent run owns
      // its own todo scope.
      const todosFromResult: TodoItem[] | undefined =
        saToolResult.name === 'TodoWrite' && saToolResult.success
          ? parseTodoItemsFromToolOutput(saToolResult.output)
          : undefined
      const patchSubAgent = (sa: SubAgentDisplay): SubAgentDisplay => {
        if (sa.agentId !== aid) return sa
        const nextToolUses = sa.toolUses.map((tu) =>
          tu.id === saToolResult.id
            ? {
                ...tu,
                status: (saToolResult.success ? 'completed' : 'error') as 'completed' | 'error',
                result: saToolResult.output,
                error: saToolResult.error,
                // Audit fix B2: forward the structured failure fields so
                // sub-agent tool failures get the same `StructuredErrorView`
                // treatment as the main chat. Without this spread, every
                // subagent tool error in the UI fell back to a raw `<pre>`
                // even after #2 widened the wire format.
                toolErrorClass: saToolResult.toolErrorClass,
                errorWhat: saToolResult.errorWhat,
                errorTried: saToolResult.errorTried,
                errorContext: saToolResult.errorContext,
                errorNext: saToolResult.errorNext,
                // Defensive: drop any leftover streamingInput buffer
                // — same invariant the main chat tool_result path
                // enforces. Should already be cleared by the
                // preceding subagent_tool_start, but a provider that
                // skips tool_start (eager input, non-stream fallback)
                // would leak otherwise.
                streamingInput: undefined,
              }
            : tu,
        )
        return todosFromResult !== undefined
          ? { ...sa, toolUses: nextToolUses, todos: todosFromResult }
          : { ...sa, toolUses: nextToolUses }
      }
      api.setState((s) => {
        const convId = subAgentTargetConvId(event, s)
        if (!convId) {
          const idx = findAssistantIndexWithSubAgent(s.messages, aid)
          if (idx < 0) return s
          const messages = s.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map(patchSubAgent)
            return { ...row, subAgents: updatedSubAgents }
          })
          return { messages }
        }
        return patchConversationSlice(s, convId, (sl) => {
          const idx = findAssistantIndexWithSubAgent(sl.messages, aid)
          if (idx < 0) return sl
          const messages = sl.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map(patchSubAgent)
            return { ...row, subAgents: updatedSubAgents }
          })
          return { ...sl, messages }
        })
      })
      return
    }

    if (t === 'subagent_complete') {
      if (!event.result) return
      // P1-36: free the dedupe entry once the agent reaches a terminal
      // state so a future re-start (disk recovery, retry) is no longer
      // blocked by the global "already started" guard, and so this Set
      // doesn't grow unbounded over a long-lived session.
      startedAgentIds.delete(aid)
      const result = event.result as {
        success: boolean
        agentType: string
        output: string
        totalDurationMs: number
        totalTokens: number
      }
      const patchCompletedSubAgent = (sa: SubAgentDisplay): SubAgentDisplay =>
        sa.agentId === aid
          ? {
              ...sa,
              status: (result.success ? 'completed' : 'failed') as 'completed' | 'failed',
              output: result.output,
              isThinking: false,
              toolUses: closeRunningSubAgentToolUses(sa.toolUses),
              totalDurationMs: result.totalDurationMs,
              totalTokens: result.totalTokens,
            }
          : sa
      const sPre = api.getState()
      const convForEvent = subAgentTargetConvId(event, sPre)
      const otherSession = convForEvent !== sPre.currentConversationId
      const agentLabel = result.agentType || 'Agent'
      if (result.success) {
        maybeDesktopNotify({
          enabled: useSettingsStore.getState().notifyOnSubagentCompleted,
          title: '子任务完成',
          body: `${agentLabel} 已完成`,
          otherSession,
        })
      } else {
        maybeDesktopNotify({
          enabled: useSettingsStore.getState().notifyOnSubagentFailed,
          title: '子任务失败',
          body: `${agentLabel} 未成功完成`,
          otherSession,
        })
      }
      api.setState((s) => {
        const convId = subAgentTargetConvId(event, s)
        if (!convId) {
          const idx = findAssistantIndexWithSubAgent(s.messages, aid)
          if (idx < 0) return s
          const messages = s.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map(patchCompletedSubAgent)
            return { ...row, subAgents: updatedSubAgents }
          })
          return { messages }
        }
        return patchConversationSlice(s, convId, (sl) => {
          const idx = findAssistantIndexWithSubAgent(sl.messages, aid)
          if (idx < 0) return sl
          const messages = sl.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map(patchCompletedSubAgent)
            return { ...row, subAgents: updatedSubAgents }
          })
          return { ...sl, messages }
        })
      })
      return
    }

    if (t === 'subagent_error') {
      if (event.error == null || event.error === '') return
      // P1-36: same as subagent_complete — release the started-id slot.
      startedAgentIds.delete(aid)
      const sErr = api.getState()
      const convForErr = subAgentTargetConvId(event, sErr)
      const otherSessionErr = convForErr !== sErr.currentConversationId
      const errRaw = String(event.error).trim()
      const errBody = errRaw.length > 160 ? `${errRaw.slice(0, 157)}…` : errRaw
      maybeDesktopNotify({
        enabled: useSettingsStore.getState().notifyOnSubagentFailed,
        title: '子任务失败',
        body: errBody,
        otherSession: otherSessionErr,
      })
      // Converge any tool_input_delta placeholder for this sub-agent
      // — same invariant as the main-chat error path
      // (`mainStreamRouter.ts` `case 'error'`): a placeholder that
      // never reached `tool_start` would otherwise keep its blinking
      // caret + pulse forever on a failed sub-agent turn.
      //
      // Mirror the main-chat fix: also stamp an `error` string onto the
      // converged block so `contextBuilder.ts` doesn't fall through to
      // its catch-all "[Tool ended with status: error]" — which gives
      // the model an opaque failure on the next turn.
      const subagentPlaceholderErrorMsg = errRaw
        ? `Sub-agent stream error before tool input completed: ${errRaw}`
        : 'Sub-agent tool call interrupted before its input was fully delivered.'
      const convergePlaceholders = (sa: SubAgentDisplay): SubAgentDisplay => ({
        ...sa,
        toolUses: sa.toolUses.map((tu) =>
          tu.streamingInput
            ? {
                ...tu,
                status: 'error' as ToolUseDisplay['status'],
                streamingInput: undefined,
                error: tu.error || subagentPlaceholderErrorMsg,
              }
            : tu,
        ),
      })
      api.setState((s) => {
        const convId = subAgentTargetConvId(event, s)
        if (!convId) {
          const idx = findAssistantIndexWithSubAgent(s.messages, aid)
          if (idx < 0) return s
          const messages = s.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid
                ? convergePlaceholders({
                    ...sa,
                    status: 'failed' as const,
                    output: event.error,
                    isThinking: false,
                  })
                : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { messages }
        }
        return patchConversationSlice(s, convId, (sl) => {
          const idx = findAssistantIndexWithSubAgent(sl.messages, aid)
          if (idx < 0) return sl
          const messages = sl.messages.map((row, i) => {
            if (i !== idx) return row
            const updatedSubAgents = (row.subAgents || []).map((sa) =>
              sa.agentId === aid
                ? convergePlaceholders({
                    ...sa,
                    status: 'failed' as const,
                    output: event.error,
                    isThinking: false,
                  })
                : sa,
            )
            return { ...row, subAgents: updatedSubAgents }
          })
          return { ...sl, messages }
        })
      })
    }
  })
}
