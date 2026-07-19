/**
 * Main-chat IPC stream dispatch.
 *
 * Subscribes to `onStreamEvent` exactly once (idempotent via
 * `ensureMainChatStreamRouter`) and routes each incoming event to the
 * matching `ChatSessionSlice` mutator. Larger case bodies are delegated to
 * dedicated handler modules under `./streamEvents/` so the dispatcher stays
 * readable:
 *   - permission / team-permission / plan-approval / ask-user-question →
 *     `permissionStreamEvents`
 *   - error / message_stop / context_compact → `lifecycleStreamEvents`
 *   - orchestration_phase → `orchestrationStreamEvents`
 *   - file_change_applied → `fileChangeStreamEvents`
 * Each handler receives one shared {@link MainRouterContext} (see
 * `mainRouterShared`).
 *
 * Behavior note: every non-delta event first flushes any queued text /
 * thinking deltas via `flushPendingDeltasNow()` so ordering between
 * streamed text and tool cards / message_stop / permission prompts stays
 * correct even while deltas are coalesced.
 *
 * Exported:
 *   - `handleMainStreamEvent(event)`  — test seam; production callers
 *                                       should go through `ensureMainChatStreamRouter`.
 *   - `ensureMainChatStreamRouter()` — one-time subscription install.
 *   - `disposeMainChatStreamRouter()` — unsubscribe + drain queued deltas
 *                                        (used by tests / HMR full reset).
 */
import type {
  StreamEvent,
  ToolProgressEvent,
  ToolUseDisplay,
} from '../../types'
import { onStreamEvent } from '../../services/electronAPI'
import { ensureTaskOutputStream, disposeTaskOutputStream } from '../../hooks/useTaskOutput'
import { useBuddyStore } from '../useBuddyStore'
import { useSettingsStore } from '../useSettingsStore'
import {
  enqueueReasoningSummaryDelta,
  enqueueTextDelta,
  enqueueThinkingDelta,
  flushPendingDeltasNow,
} from './streamingDeltaBatcher'
import {
  enqueueToolInputDelta,
  flushPendingToolInputsNow,
} from './toolInputDeltaBatcher'
import {
  pendingAssistantByConversation,
  patchConversationSlice,
  readSlice,
} from './sessionSlice'
import { clampPreview, maybeDesktopNotify } from './desktopNotify'
import { parseTodoItemsFromToolOutput } from './parseTodoItems'
import { chatStoreApi } from './storeApiRef'
import {
  handleAskUserQuestionEvent,
  handlePermissionRequestEvent,
  handleTeamPermissionRequestEvent,
  handleTeamPlanApprovalRequestEvent,
  handlePlanApprovalRequestEvent,
} from './streamEvents/permissionStreamEvents'
import type { MainRouterContext } from './streamEvents/mainRouterShared'
import {
  handleErrorEvent,
  handleMessageStopEvent,
  handleContextCompactEvent,
  handleContextCompactStartEvent,
} from './streamEvents/lifecycleStreamEvents'
import { handleOrchestrationPhaseEvent } from './streamEvents/orchestrationStreamEvents'
import { handleFileChangeAppliedEvent } from './streamEvents/fileChangeStreamEvents'
import type { ChatSessionSlice, ChatState } from './types'

let chatStreamUnsubscribe: (() => void) | null = null
let mainChatStreamRouterInstalled = false

/**
 * upstream alignment stage 2: append one tool progress chunk to the running
 * tool block's `streamingProgress`. Two storage shapes:
 *
 *   - If the chunk's `data` is a `{ text: string }` payload AND the chunk
 *     `type` looks like a text stream (`text` / `stdout` / `stderr` /
 *     `chunk` — the conventional shell streaming names upstream uses), we
 *     concatenate into `text` for cheap rendering.
 *   - Otherwise we push the raw chunk onto `events[]` so richer payloads
 *     (web search partials, todo deltas) are preserved verbatim.
 *
 * Returns a fresh object — never mutates `prev`.
 */
const STREAMING_TEXT_CHUNK_TYPES = new Set([
  'text',
  'stdout',
  'stderr',
  'chunk',
  'output',
])

const STREAMING_PROGRESS_MAX_TEXT = 32_000 // ~32 KB of streamed text per tool
const STREAMING_PROGRESS_MAX_EVENTS = 200

function appendStreamingProgress(
  prev: { text?: string; events?: ToolProgressEvent[] } | undefined,
  chunk: { type?: string; data?: unknown },
): { text?: string; events?: ToolProgressEvent[] } {
  const chunkType = typeof chunk.type === 'string' ? chunk.type : 'chunk'
  const chunkData = chunk.data
  const isTextLike =
    STREAMING_TEXT_CHUNK_TYPES.has(chunkType) &&
    chunkData !== null &&
    typeof chunkData === 'object' &&
    typeof (chunkData as { text?: unknown }).text === 'string'

  if (isTextLike) {
    const incoming = (chunkData as { text: string }).text
    const merged = (prev?.text ?? '') + incoming
    // Cap at MAX_TEXT to keep React renders cheap on long-running tools.
    // Truncate from the head so the latest output stays visible.
    const text = merged.length > STREAMING_PROGRESS_MAX_TEXT
      ? merged.slice(merged.length - STREAMING_PROGRESS_MAX_TEXT)
      : merged
    return { ...prev, text }
  }

  const events = [...(prev?.events ?? []), { type: chunkType, data: chunkData }]
  return {
    ...prev,
    events: events.length > STREAMING_PROGRESS_MAX_EVENTS
      ? events.slice(events.length - STREAMING_PROGRESS_MAX_EVENTS)
      : events,
  }
}

export function handleMainStreamEvent(event: StreamEvent): void {
  // Any event that is not itself a streaming delta MUST observe a
  // consistent view of the transcript — including any text / thinking
  // deltas that are still sitting in the batcher waiting for the next
  // animation frame. Flushing here is what keeps ordering between text
  // chunks and tool cards / message_stop / permission prompts / etc.
  // correct even when deltas are being coalesced.
  //
  // `tool_input_delta` joins the white-list: it's a per-chunk model-
  // streaming signal (same rate class as text/thinking deltas), and
  // forcing a flush on every chunk would defeat the rAF batcher exactly
  // when the model is most expensive to render (Write/Edit args
  // streaming). Cards that depend on `streamingInput` already render
  // off the next frame's commit, so missing one frame of batched text
  // ordering vs the streaming card is invisible.
  if (
    event.type !== 'text_delta' &&
    event.type !== 'thinking_delta' &&
    event.type !== 'reasoning_summary_delta' &&
    event.type !== 'tool_input_delta'
  ) {
    flushPendingDeltasNow()
    // Same ordering contract for batched tool-input writes: a finalising
    // event (tool_start / tool_result / message_stop / error) must see the
    // latest streamingInput already committed, otherwise a still-pending
    // batched write could resurrect a caret after the tool settled.
    flushPendingToolInputsNow()
  }

  const api = chatStoreApi()
  const st0 = api.getState()
  const convId = event.conversationId ?? st0.currentConversationId ?? 'default'
  const assistantId = pendingAssistantByConversation.get(convId)

  const apply = (
    fn: (sl: ChatSessionSlice) => ChatSessionSlice,
    extra?: Partial<ChatState>,
  ) => {
    api.setState((st) => ({ ...patchConversationSlice(st, convId, fn), ...extra }))
  }

  // Shared context forwarded to the handler modules split out of this router.
  const ctx: MainRouterContext = { event, convId, assistantId, st0, apply, api }

  switch (event.type) {
    case 'memory_recall': {
      if (convId !== st0.currentConversationId) break
      const list = event.recalledMemories
      if (list && list.length > 0) {
        api.setState({
          recalledMemories: list.map((m) => ({
            filename: m.filename,
            name: m.name,
            type: m.type,
            matchSnippet: m.matchSnippet,
            content: m.matchSnippet,
          })),
        })
      } else {
        api.setState({ recalledMemories: [] })
      }
      break
    }

    // P1-6 — retrieval citations. Mirror `memory_recall`: only the active
    // conversation updates the top-level store (the citation renders under the
    // current transcript). Emitted post-`message_stop`, so the set survives the
    // turn-boundary clear below and stays visible until the next turn.
    case 'workspace_recall': {
      if (convId !== st0.currentConversationId) break
      const hits = event.workspaceRetrieval
      api.setState({ recalledWorkspaceHits: hits && hits.length > 0 ? hits : [] })
      break
    }

    case 'attachment_recall': {
      if (convId !== st0.currentConversationId) break
      const hits = event.attachmentRetrieval
      api.setState({ recalledAttachmentHits: hits && hits.length > 0 ? hits : [] })
      break
    }

    case 'stream_fallback_reset': {
      if (!assistantId) break
      // Plan Phase 2.B — 除了清空消息体内容，再额外打 `_streamFallbackTombstone`
      // 标记，让 contextBuilder / 渲染 / 持久化三处都识别"这是个被 fallback
      // 抛弃的空壳"。光清空 content/blocks 不打标记会让下一轮 API 看到
      // role=assistant content=[] 占位（被 ensureNonEmptyAssistantContent
      // 换成 '...'），主模型容易模仿这种空白回复 → 噪音链路。
      apply((sl) => ({
        ...sl,
        messages: sl.messages.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: '',
                thinking: '',
                isThinking: false,
                blocks: [],
                toolUses: [],
                _streamFallbackTombstone: true,
              }
            : m,
        ),
      }))
      break
    }

    case 'text_delta': {
      if (!assistantId) break
      enqueueTextDelta(convId, assistantId, event.text || '')
      break
    }

    case 'thinking_delta': {
      if (!assistantId) break
      // Route through the same rAF batcher as `text_delta`. The previous
      // revision force-flushed on both sides ("must stream in real-time"),
      // but token-rate setState calls re-rendered `ChatPanel`'s selector
      // subtree at ~50/s on fast reasoning models — the dominant streaming
      // jank source. The batcher already coalesces inside one animation
      // frame (≤16ms), which is below visible flicker threshold for text,
      // and any non-delta event (`tool_start`, `thinking_block_complete`,
      // `message_stop`, …) still calls `flushPendingDeltasNow()` at the top
      // of `handleMainStreamEvent`, so ordering against tool cards and the
      // canonical block-complete replacement is preserved.
      //
      // Sub-agent `thinking_delta` already went through the main-process
      // `streamCoalescer` (≤60Hz IPC), so this change finally puts main-
      // agent thinking on the same smoothness budget as sub-agent thinking.
      enqueueThinkingDelta(convId, assistantId, event.text || '')
      break
    }

    case 'reasoning_summary_delta': {
      if (!assistantId) break
      // Same batched path as `thinking_delta`: OpenAI Responses summary
      // streams are typically slower per-token than raw reasoning, but
      // routing through the rAF batcher keeps the three soft-merge peers
      // (text + thinking + reasoning_summary) on identical coalescing
      // budgets — important for the ordering invariant when a provider
      // interleaves them at token granularity.
      enqueueReasoningSummaryDelta(convId, assistantId, event.text || '')
      break
    }

    case 'thinking_block_complete': {
      // End-to-end signature plumbing for `type:'thinking'` blocks.
      //
      // Cross-turn transcript replay (the DeepSeek / Anthropic native
      // `content[].thinking` round-trip) depends on the renderer owning the
      // COMPLETE thinking payload, including the `signature` field when the
      // provider sends one (`signature_delta` SSE frames). Delta events
      // carry only the incremental thinking text; signatures arrive as a
      // separate SSE frame that our `streaming` batcher would have no way
      // to stitch into the ChatBlock. This event is emitted once the server
      // sends `content_block_stop` for the thinking block; it replaces the
      // currently-streaming block's `text` with the canonical whole-block
      // payload (so a dropped / reordered delta doesn't cause drift) and
      // stashes the `signature` so the next turn's
      // `chatMessageToAgentApiRows` can forward it on the wire.
      if (!assistantId || !event.thinkingBlock) break
      const { thinking, signature, thinkingTimeMs, thinkingTokens } = event.thinkingBlock
      apply((sl) => ({
        ...sl,
        messages: sl.messages.map((m) => {
          if (m.id !== assistantId) return m
          const blocks = [...(m.blocks || [])]
          // Walk backwards to find the right thinking block to stamp.
          // Two-pass targeting (defensive over the pre-Step-3 single-pass
          // heuristic that just grabbed the last thinking block):
          //
          //   Pass 1 — prefer the most recent IN-FLIGHT thinking block
          //   (`isStreaming !== false`). After the protocol-layer fix in
          //   `electron/ai/thinkingBlockAccumulator.ts`, `_complete` events
          //   arrive at each wire-level `content_block_stop` — so there is
          //   exactly one in-flight thinking block whenever a `_complete`
          //   reaches the renderer in the happy path. Targeting THAT block
          //   instead of "last thinking" makes the renderer robust to:
          //     - duplicate `_complete` events from a retrying gateway /
          //       proxy replay (we don't want to overwrite an already-
          //       signed earlier block);
          //     - rare reverse-order `_complete` arrival (B stamps first,
          //       then a late A `_complete` must still find A — not B —
          //       even though B is geometrically more recent).
          //
          //   Pass 2 — fallback to ANY trailing thinking block. Covers
          //   the idempotent-duplicate case (same canonical payload
          //   arrives twice; harmless to overwrite the already-stamped
          //   block with itself) and a few stranger edges where every
          //   thinking block in the transcript is already stamped but a
          //   stray `_complete` still arrives.
          //
          // What this DOES NOT defend against: a true burst with
          // multiple in-flight thinking blocks simultaneously (would
          // require an `index` field on the `_complete` event for an
          // exact match). The protocol-layer per-stop emission in Step 3
          // is the canonical fix for that case; this is belt-and-
          // suspenders for protocol regressions only.
          let targetIdx = -1
          for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i]
            if (b.type === 'thinking' && b.isStreaming !== false) {
              targetIdx = i
              break
            }
          }
          if (targetIdx === -1) {
            for (let i = blocks.length - 1; i >= 0; i--) {
              if (blocks[i].type === 'thinking') {
                targetIdx = i
                break
              }
            }
          }
          // Optional fields are conditionally spread so callers (and tests)
          // that omit them produce the same block shape as before. Once
          // present these persist with the rest of the message via
          // saveConversationFile, so a process restart restores the elapsed
          // time AND the cost estimate on the ThinkingBlock card instead
          // of snapping to defaults.
          const timeFragment =
            typeof thinkingTimeMs === 'number' && thinkingTimeMs > 0
              ? { thinkingTimeMs }
              : {}
          const tokensFragment =
            typeof thinkingTokens === 'number' && thinkingTokens > 0
              ? { thinkingTokens }
              : {}
          if (targetIdx === -1) {
            // No thinking block in the transcript yet — the server sent the
            // complete event without any preceding deltas (possible on a
            // fast-mode / short-reasoning response). Synthesize the block.
            blocks.push({
              type: 'thinking',
              text: thinking,
              isStreaming: false,
              ...(signature ? { signature } : {}),
              ...timeFragment,
              ...tokensFragment,
            })
          } else {
            const existing = blocks[targetIdx] as Extract<
              (typeof blocks)[number],
              { type: 'thinking' }
            >
            blocks[targetIdx] = {
              ...existing,
              text: thinking,
              isStreaming: false,
              ...(signature ? { signature } : {}),
              ...timeFragment,
              ...tokensFragment,
            }
          }
          return { ...m, blocks }
        }),
      }))
      break
    }

    case 'redacted_thinking_block': {
      // Plan Phase 4 — Anthropic `redacted_thinking` 块到位。整块一次性
      // append 到 blocks 尾部（无 delta），UI 渲染成不可展开的 ✻ Thinking
      // 占位。`data` 必须存下来，下一轮 `chatMessageToAgentApiRows` 会原
      // 样回灌给 API。
      if (!assistantId || !event.redactedThinkingBlock) break
      const { data, startedAtMs } = event.redactedThinkingBlock
      if (typeof data !== 'string' || data.length === 0) break
      apply((sl) => ({
        ...sl,
        messages: sl.messages.map((m) => {
          if (m.id !== assistantId) return m
          const blocks = [...(m.blocks || [])]
          blocks.push({
            type: 'redacted_thinking',
            data,
            isStreaming: false,
            ...(typeof startedAtMs === 'number' && startedAtMs > 0
              ? { startedAtMs }
              : {}),
          })
          return { ...m, blocks }
        }),
      }))
      break
    }

    case 'reasoning_summary_block_complete': {
      // Mirror of `thinking_block_complete` for the summary channel.
      // Replaces the most recent `reasoning_summary` block's text with
      // the canonical payload (so a dropped / reordered delta doesn't
      // cause drift) and stamps the elapsed / token meta. No signature
      // round-trip: summaries are output-only.
      if (!assistantId || !event.reasoningSummaryBlock) break
      const { text: rText, thinkingTimeMs: rTimeMs, thinkingTokens: rTokens } =
        event.reasoningSummaryBlock
      apply((sl) => ({
        ...sl,
        messages: sl.messages.map((m) => {
          if (m.id !== assistantId) return m
          const blocks = [...(m.blocks || [])]
          let targetIdx = -1
          for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i].type === 'reasoning_summary') {
              targetIdx = i
              break
            }
          }
          const timeFragment =
            typeof rTimeMs === 'number' && rTimeMs > 0
              ? { thinkingTimeMs: rTimeMs }
              : {}
          const tokensFragment =
            typeof rTokens === 'number' && rTokens > 0
              ? { thinkingTokens: rTokens }
              : {}
          if (targetIdx === -1) {
            blocks.push({
              type: 'reasoning_summary',
              text: rText,
              isStreaming: false,
              ...timeFragment,
              ...tokensFragment,
            })
          } else {
            const existing = blocks[targetIdx] as Extract<
              (typeof blocks)[number],
              { type: 'reasoning_summary' }
            >
            blocks[targetIdx] = {
              ...existing,
              text: rText,
              isStreaming: false,
              ...timeFragment,
              ...tokensFragment,
            }
          }
          return { ...m, blocks }
        }),
      }))
      break
    }

    // Mid-block model-time streaming of a tool_use's JSON arguments.
    // Lets Write/Edit cards show the in-progress `content`/`newString`
    // before the tool block actually closes. We materialise a *placeholder*
    // ToolUseDisplay (status:'running', empty `input`) if no entry exists
    // yet — the subsequent `tool_start` will overwrite the input field
    // and clear `streamingInput` once the parsed args are authoritative.
    case 'tool_input_delta': {
      if (!assistantId || !event.toolUseId) break
      const toolUseId = event.toolUseId
      const toolName = event.toolName || ''
      const partialJson = event.partialJson || ''
      if (!partialJson) break
      // Ordering fix: `tool_input_delta` is intentionally OUT of the
      // top-of-function `flushPendingDeltasNow()` whitelist so heavy
      // Write/Edit args streaming doesn't defeat the rAF batcher. But
      // the very first delta for a given tool also *pushes a tool_use
      // placeholder block to `blocks`* — and any preamble text the
      // model emitted right before the tool call is still sitting in
      // the delta batcher. If we add the boundary first, the later
      // flush sees a `tool_use` block at the tail of `blocks` and
      // `applyBatchedDeltasToSlice` (via `findMergeTargetIdx`) gives
      // up at the boundary, appending the preamble *after* the tool
      // card — exact symptom: the explanation "我要把内容写入 txt 文件"
      // renders below the Write tool's OUTPUT instead of above it.
      //
      // Fix: flush exactly once, on the FIRST delta that's about to
      // create the placeholder. Subsequent deltas for the same tool
      // id keep the perf optimisation (the placeholder already exists,
      // no new boundary added → no ordering hazard).
      const existingSlice = readSlice(st0, convId)
      const assistantMsg = existingSlice.messages.find((m) => m.id === assistantId)
      const placeholderAlreadyExists =
        assistantMsg?.blocks?.some(
          (b) => b.type === 'tool_use' && b.id === toolUseId,
        ) ?? false
      if (placeholderAlreadyExists) {
        // Fast path: the placeholder block + toolUses entry already exist,
        // so no new boundary is added and there's no ordering hazard. Coalesce
        // the (full) partialJson into the rAF batcher — ~20Hz/tool of
        // immediate `setState` + full `messages.map` becomes ≤1/frame.
        enqueueToolInputDelta(convId, assistantId, toolUseId, partialJson)
        break
      }
      // First delta for this tool: seed synchronously so the card appears in
      // order (flush any queued preamble text first) and immediately.
      if (toolName) {
        flushPendingDeltasNow()
      }
      apply((sl) => ({
        ...sl,
        messages: sl.messages.map((m) => {
          if (m.id !== assistantId) return m
          const blocks = [...(m.blocks || [])]
          const existingBlockIdx = blocks.findIndex(
            (b) => b.type === 'tool_use' && b.id === toolUseId,
          )
          if (existingBlockIdx < 0 && toolName) {
            // Seed an empty-input placeholder so the card renders during
            // the model-typing window. `input` stays `{}` until tool_start
            // arrives with the parsed payload.
            blocks.push({
              type: 'tool_use' as const,
              id: toolUseId,
              name: toolName,
              input: {} as Record<string, unknown>,
              status: 'running' as const,
              taskId: `agent-${toolUseId}`,
            })
          }
          const existingToolIdx = (m.toolUses || []).findIndex(
            (t) => t.id === toolUseId,
          )
          let updatedToolUses: ToolUseDisplay[]
          if (existingToolIdx >= 0) {
            updatedToolUses = (m.toolUses || []).map((t, i) =>
              i === existingToolIdx
                ? { ...t, streamingInput: { partialJson } }
                : t,
            )
          } else if (toolName) {
            updatedToolUses = [
              ...(m.toolUses || []),
              {
                id: toolUseId,
                name: toolName,
                input: {} as Record<string, unknown>,
                status: 'running' as ToolUseDisplay['status'],
                streamingInput: { partialJson },
              },
            ]
          } else {
            // No name & no existing entry — can't seed safely. Skip.
            updatedToolUses = m.toolUses || []
          }
          return { ...m, toolUses: updatedToolUses, blocks }
        }),
      }))
      break
    }

    case 'tool_start': {
      if (!assistantId || !event.toolUse) break
      const toolDisplay: ToolUseDisplay = {
        id: event.toolUse.id,
        name: event.toolUse.name,
        input: event.toolUse.input,
        status: 'running',
      }
      apply((sl) => ({
        ...sl,
        messages: sl.messages.map((m) => {
          if (m.id !== assistantId) return m
          const blocks = [...(m.blocks || [])]
          const lastBlock = blocks[blocks.length - 1]
          if (lastBlock && lastBlock.type === 'thinking' && lastBlock.isStreaming) {
            blocks[blocks.length - 1] = { ...lastBlock, isStreaming: false }
          }
          const existingIdx2 = blocks.findIndex(
            (b) => b.type === 'tool_use' && b.id === toolDisplay.id,
          )
          const existing2 = existingIdx2 >= 0 ? blocks[existingIdx2] : undefined
          if (existing2 && existing2.type === 'tool_use') {
            blocks[existingIdx2] = { ...existing2, input: toolDisplay.input, status: 'running' as const }
          } else {
            blocks.push({
              type: 'tool_use' as const,
              id: toolDisplay.id,
              name: toolDisplay.name,
              input: toolDisplay.input,
              status: 'running' as const,
              taskId: `agent-${toolDisplay.id}`,
            })
          }
          const existingToolIdx = (m.toolUses || []).findIndex(
            (t) => t.id === toolDisplay.id,
          )
          const updatedToolUses = existingToolIdx >= 0
            ? m.toolUses!.map((t, i) => i === existingToolIdx ? toolDisplay : t)
            : [...(m.toolUses || []), toolDisplay]
          // G: legacy `isThinking: false` mirror dropped. Blocks-based
          // rendering reads streaming state from the per-block
          // `isStreaming` flag (already sealed by `applyBatchedDeltas`
          // when text starts), so the top-level flag is redundant.
          return { ...m, toolUses: updatedToolUses, blocks }
        }),
      }))
      break
    }

    case 'tool_result': {
      if (!assistantId || !event.toolResult) break
      apply((sl) => {
        let nextTodos = sl.todos
        if (event.toolResult!.name === 'TodoWrite' && event.toolResult!.success) {
          const parsed = parseTodoItemsFromToolOutput(event.toolResult!.output)
          if (parsed) nextTodos = parsed
        }
        return {
          ...sl,
          todos: nextTodos,
          messages: sl.messages.map((m) => {
            if (m.id !== assistantId) return m
            const resultId = event.toolResult!.id
            const newStatus: 'completed' | 'error' = event.toolResult!.success ? 'completed' : 'error'
            // P1-5 fix (audit): drop `streamingProgress` once the final
            // `tool_result` lands. The UI's `shouldShowStreaming` already
            // hides the live feed at that point, but keeping the buffer in
            // memory bloats every message and (worse) bloats the persisted
            // conversation JSON since `cleanMessagesForPersist` / dehydrate
            // don't strip this field. Clearing here is the single source of
            // truth for "streaming done → free the chunk buffer".
            //
            // Mirror the same cleanup for `streamingInput` (IDE-style
            // Write/Edit live-args buffer). Normally `tool_start` already
            // overwrites the toolUses entry and drops `streamingInput`
            // implicitly; this explicit `undefined` is a defensive belt
            // for two edge cases: (a) a provider that fires `tool_result`
            // without a preceding `tool_start` (eager/non-stream
            // fallback), (b) a late `tool_input_delta` that races past
            // `tool_start` and re-seeds the field.
            // Spread the structured `error*` fields onto every tool view —
            // both the legacy `toolUses` array and the canonical `blocks`
            // list — so the renderer can show the headline + recovery
            // hints as styled regions. All five fields are optional; when
            // the tool emits only the flat `error` string they stay
            // `undefined` and the UI falls back to a `<pre>` blob.
            const tr = event.toolResult!
            const updatedTools = (m.toolUses || []).map((tu) =>
              tu.id === resultId
                ? {
                    ...tu,
                    status: newStatus,
                    result: tr.output,
                    error: tr.error,
                    toolErrorClass: tr.toolErrorClass,
                    errorWhat: tr.errorWhat,
                    errorTried: tr.errorTried,
                    errorContext: tr.errorContext,
                    errorNext: tr.errorNext,
                    streamingProgress: undefined,
                    streamingInput: undefined,
                  }
                : tu,
            )
            const blocks = (m.blocks || []).map((b) =>
              b.type === 'tool_use' && b.id === resultId
                ? {
                    ...b,
                    status: newStatus,
                    result: tr.output,
                    error: tr.error,
                    toolErrorClass: tr.toolErrorClass,
                    errorWhat: tr.errorWhat,
                    errorTried: tr.errorTried,
                    errorContext: tr.errorContext,
                    errorNext: tr.errorNext,
                  }
                : b,
            )
            return { ...m, toolUses: updatedTools, blocks }
          }),
        }
      })
      break
    }

    case 'permission_request': {
      handlePermissionRequestEvent(event, apply, convId !== st0.currentConversationId)
      break
    }

    case 'team_permission_request':
      handleTeamPermissionRequestEvent(event, apply, convId !== st0.currentConversationId)
      break

    case 'team_plan_approval_request':
      handleTeamPlanApprovalRequestEvent(event, apply, convId !== st0.currentConversationId)
      break

    case 'plan_approval_request':
      handlePlanApprovalRequestEvent(event, apply, convId !== st0.currentConversationId)
      break

    case 'ask_user_question': {
      handleAskUserQuestionEvent(event, apply, convId !== st0.currentConversationId)
      break
    }

    case 'mode_changed': {
      // Only reflect the change in top-bar chips if the event is for the
      // conversation the user is currently looking at. Background sessions
      // used to silently overwrite the visible Agent/Plan/Ask selector and
      // permission mode, which directly affected which request flags the
      // next `sendMessage` emitted for the *foreground* conversation.
      if (convId !== st0.currentConversationId) break
      const mode = event.mode || 'default'
      api.setState({
        permissionMode: mode,
        // Sync chatInteractionMode bidirectionally:
        // - Plan mode ON  → set chatInteractionMode to 'plan'
        // - Plan mode OFF → reset to 'agent' (was stuck as 'plan' permanently before this fix)
        // Guard on st0.chatInteractionMode === 'plan' prevents overriding user's intentional 'ask' selection.
        ...(mode === 'plan'
          ? { chatInteractionMode: 'plan' as const }
          : st0.chatInteractionMode === 'plan'
            ? { chatInteractionMode: 'agent' as const }
            : {}),
      })
      break
    }

    case 'buddy_event': {
      // Route protocol-level buddy updates into the dedicated store. The
      // type was defined in `StreamEventType` but no consumer forwarded it,
      // so main-process mood/bubble pushes were silently dropped.
      useBuddyStore.getState().applyStreamEvent(event as unknown as Parameters<ReturnType<typeof useBuddyStore.getState>['applyStreamEvent']>[0])
      break
    }

    case 'file_change_applied': {
      handleFileChangeAppliedEvent(ctx)
      break
    }

    case 'context_compact_start': {
      handleContextCompactStartEvent(ctx)
      break
    }

    case 'context_compact': {
      handleContextCompactEvent(ctx)
      break
    }

    case 'error': {
      handleErrorEvent(ctx)
      break
    }

    case 'message_stop': {
      handleMessageStopEvent(ctx)
      break
    }

    // Stage 3.2 — kernel phase telemetry dispatch (see orchestrationStreamEvents.ts).
    case 'orchestration_phase': {
      handleOrchestrationPhaseEvent(ctx)
      break
    }

    // ── Layer-E — `task_terminated`. ──────────────────────────────────
    // Emitted exactly once per `runAgenticLoop` run by `streamHandler.ts`
    // (immediately after `message_stop`, via a scoped
    // `registerTerminationCleanup` callback), carrying the canonical
    // `TerminationReason`. We stash it on the per-conversation session
    // slice so the chat UI can decide whether to surface a "继续未完成的任务"
    // / retry affordance on the latest assistant bubble. `'completed'`
    // clears the flag so a clean turn dismisses any prior failure badge.
    case 'task_terminated': {
      const reason = event.terminationReason
      apply(
        (sl) => ({
          ...sl,
          latestTerminationReason:
            !reason || reason === 'completed' ? null : reason,
        }),
        { recalledMemories: [], recalledWorkspaceHits: [], recalledAttachmentHits: [] },
      )
      break
    }

    // -------------------------------------------------------------------------
    // Ported from `mainStreamHandlers.ts` (PR-A of streaming handler cleanup).
    //
    // These three events are emitted by the main process (see
    // `electron/ai/runAgenticToolUse.ts` + `streamingToolExecutor.ts`
    // + `electron/agents/resumeAgent.ts`) but were historically silently
    // dropped by this switch's `default: break` — a stranded-refactor
    // side effect where the additions landed in a sibling handler
    // (`mainStreamHandlers.ts`) that was never wired up via `useChatStore`.
    // -------------------------------------------------------------------------
    case 'tool_progress': {
      if (!assistantId || !event.toolUseId) break
      const phase = (event as unknown as { phase?: 'start' | 'end' | 'chunk' }).phase
      const success = (event as unknown as { success?: boolean }).success
      // upstream alignment stage 2: a `chunk` phase carries a serialized
      // progress event in `event.data` (cf. `ToolProgressEvent`). We append
      // it to the matching tool block's `streamingProgress` so the renderer
      // shows live activity before the final `tool_result` lands.
      const chunkData = (event as unknown as { data?: { type?: string; data?: unknown } }).data
      apply((sl) => ({
        ...sl,
        messages: sl.messages.map((m) => {
          if (m.id !== assistantId) return m
          const blocks = (m.blocks || []).map((b) => {
            if (b.type !== 'tool_use' || b.id !== event.toolUseId) return b
            if (phase === 'end') {
              // Explicit failure flips to 'error' immediately — prior behaviour
              // kept the block 'running' relying on `tool_result`, which left
              // the spinner stuck forever if the result never arrived (e.g.
              // crash mid-stream). Success stays 'running' until `tool_result`
              // confirms — the tool_result case flips it to 'completed'.
              return {
                ...b,
                status: success === false ? ('error' as const) : ('running' as const),
              }
            }
            return b
          })
          const toolUses = (m.toolUses || []).map((t) => {
            if (t.id !== event.toolUseId) return t
            if (phase === 'end') {
              return {
                ...t,
                status: success === false ? ('error' as const) : ('running' as const),
              }
            }
            if (phase === 'chunk' && chunkData) {
              return {
                ...t,
                streamingProgress: appendStreamingProgress(t.streamingProgress, chunkData),
              }
            }
            return t
          })
          return { ...m, blocks, toolUses }
        }),
      }))
      break
    }

    case 'tool_use_summary': {
      // Post-tool summary (duration / metadata). The main chat already gets
      // the final `tool_result`; we stash metadata onto the matching tool
      // display entry so UI decorations can read it.
      if (!assistantId || !event.toolUseId) break
      const metadata = (event as unknown as { metadata?: Record<string, unknown> }).metadata
      if (!metadata) break
      apply((sl) => ({
        ...sl,
        messages: sl.messages.map((m) => {
          if (m.id !== assistantId) return m
          const toolUses = (m.toolUses || []).map((t) =>
            t.id === event.toolUseId ? { ...t, metadata } : t,
          )
          return { ...m, toolUses }
        }),
      }))
      break
    }

    case 'subagent_notification': {
      // Resume / background sub-agent completion. Surface as a toast — the
      // chat transcript does not get a separate row (the sub-agent row
      // inside the parent assistant already shows status).
      const notif = event as unknown as { title?: string; body?: string }
      maybeDesktopNotify({
        enabled: useSettingsStore.getState().notifyOnSubagentCompleted,
        title: notif.title || '子代理消息',
        body: clampPreview(notif.body || ''),
        otherSession: convId !== st0.currentConversationId,
      })
      break
    }

    default:
      break
  }
}

export function ensureMainChatStreamRouter(): void {
  if (mainChatStreamRouterInstalled) return
  mainChatStreamRouterInstalled = true
  // upstream alignment stage 2: also wire the `task:output-chunk` consumer.
  // `useTaskOutputStore` was designed as a separate idempotent IPC subscription
  // (see "avoids N×setState per ToolUseCard" note in useTaskOutput.ts) but
  // nothing called it, so streaming bash output never reached any UI. Install
  // it alongside the main router so bash stdout flows to `useTaskOutputSlice`
  // for live rendering.
  ensureTaskOutputStream()
  chatStreamUnsubscribe = onStreamEvent((event: StreamEvent) => {
    handleMainStreamEvent(event)
  })
}

/** Unsubscribe main chat IPC listener (e.g. tests / full reset). Prefer not calling on normal session switch. */
export function disposeMainChatStreamRouter(): void {
  // Drain queued deltas before tearing down the IPC subscription, otherwise
  // a partial final turn ending right on app-quit / full-reset would lose
  // its last ~16 ms of text chunks. Cheap no-op when the queue is empty.
  flushPendingDeltasNow()
  flushPendingToolInputsNow()
  if (chatStreamUnsubscribe) {
    chatStreamUnsubscribe()
    chatStreamUnsubscribe = null
  }
  mainChatStreamRouterInstalled = false
  // upstream alignment audit P1-7: ensureMainChatStreamRouter() installs
  // both the main chat listener and the task-output listener. Dispose
  // symmetrically so a test/HMR reset doesn't leak the task-output
  // subscription past the main one.
  disposeTaskOutputStream()
}
