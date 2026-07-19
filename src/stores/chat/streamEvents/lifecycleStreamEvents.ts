/**
 * Lifecycle stream events split out of `mainStreamRouter.ts`:
 *   - `error`            → converge placeholders, seal message, persist, drain queue
 *   - `message_stop`     → seal streaming blocks, persist, drain queue
 *   - `context_compact_start` → show transient "compacting…" toast
 *   - `context_compact`  → resolve toast to "done · freed N" + capture summary
 */
import type { ChatMessage, ToolUseDisplay } from '../../../types'
import { pendingAssistantByConversation } from '../sessionSlice'
import { useCompactionToastStore } from '../../useCompactionToastStore'
import { flushTurnQueueFor } from '../slices/sendSlice'
import { persistBufferedConversation, type MainRouterContext } from './mainRouterShared'

export function handleErrorEvent({ event, convId, assistantId, apply }: MainRouterContext): void {
  if (!assistantId) return
  pendingAssistantByConversation.delete(convId)
  apply(
    (sl) => ({
      ...sl,
      messages: sl.messages.map((m) => {
        if (m.id !== assistantId) return m
        // Converge any tool_use placeholder that's still in the
        // "model-args streaming" window (`streamingInput` is set but
        // `tool_start` never fired) — without this the Write/Edit
        // progress card would keep its blue pulse + blinking caret
        // forever on a failed turn. Real running tools (no
        // `streamingInput`, already executing) are left alone — the
        // agentic loop's own abort path will surface their
        // `tool_result` with `success: false`.
        //
        // Bug fix: also stamp an `error` string onto the converged
        // block. Without it, `contextBuilder.ts` falls through to its
        // catch-all and serializes the tool_result content as the
        // opaque "[Tool ended with status: error]" — which the model
        // then sees on the next turn as an unexplained failure
        // (visible to users as e.g. an AskUserQuestion that "errored"
        // when it was actually a stream-level abort/timeout). Using
        // the stream event's own error text gives the model a real
        // reason to act on.
        const placeholderErrorMsg =
          typeof event.error === 'string' && event.error.trim()
            ? `Stream error before tool input completed: ${event.error.trim()}`
            : 'Tool call interrupted before its input was fully delivered (stream error or abort).'
        const toolUses = (m.toolUses || []).map((tu) =>
          tu.streamingInput
            ? {
                ...tu,
                status: 'error' as ToolUseDisplay['status'],
                streamingInput: undefined,
                error: tu.error || placeholderErrorMsg,
              }
            : tu,
        )
        const placeholderIds = new Set(
          (m.toolUses || [])
            .filter((tu) => tu.streamingInput)
            .map((tu) => tu.id),
        )
        const updatedBlocks = (m.blocks || []).map((b) =>
          b.type === 'tool_use' && placeholderIds.has(b.id)
            ? {
                ...b,
                status: 'error' as const,
                error: b.error || placeholderErrorMsg,
              }
            : b,
        )
        const errorText = `Error: ${event.error}`
        // Bug A fix (debug session cb2d71): when the assistant message
        // already has blocks (thinking / tool_use / etc.), ChatMessage
        // renders via block-mode (`hasBlocks=true` branch) and never
        // reads `m.content`. The pre-fix code only wrote the error to
        // `m.content`, leaving block-mode users with no visible
        // failure. Appending a text block makes the error render as a
        // normal text block alongside the prior thinking/tool blocks.
        // No-blocks case keeps relying on the `content` fallback.
        const blocks =
          updatedBlocks.length > 0
            ? [...updatedBlocks, { type: 'text' as const, text: errorText }]
            : updatedBlocks
        return {
          ...m,
          content: m.content || errorText,
          isStreaming: false,
          toolUses,
          blocks,
        }
      }),
      isTyping: false,
      pendingPermissionRequest: null,
      // When the kernel pauses for HITL, the stream legitimately ends
      // (kernel.interrupt cascades to message_stop / error), but the user
      // is still expected to answer. Preserve the pending AskUserQuestion
      // slot in that state.
      pendingAskUserQuestion: sl.hitlPaused ? sl.pendingAskUserQuestion : null,
    }),
    { recalledMemories: [], recalledWorkspaceHits: [], recalledAttachmentHits: [] },
  )
  void persistBufferedConversation(convId)
  flushTurnQueueFor(convId)
}

export function handleMessageStopEvent({ convId, assistantId, apply }: MainRouterContext): void {
  if (!assistantId) return
  pendingAssistantByConversation.delete(convId)
  apply(
    (sl) => ({
      ...sl,
      messages: sl.messages.map((m: ChatMessage) => {
        if (m.id !== assistantId) return m
        const blocks = (m.blocks || []).map((b) => {
          if (b.type === 'thinking' && b.isStreaming) return { ...b, isStreaming: false }
          if (b.type === 'reasoning_summary' && b.isStreaming) return { ...b, isStreaming: false }
          return b
        })
        // Defensive: a tool_use placeholder still holding
        // `streamingInput` here means the model emitted
        // `input_json_delta` but never closed the content block
        // (truncated stream, anthropic 529 mid-args, etc.) — UI
        // would otherwise show a perpetually streaming card.
        // Collapse to `stopped` so the visual state matches the
        // transport state.
        const toolUses = (m.toolUses || []).map((tu) =>
          tu.streamingInput
            ? {
                ...tu,
                status: 'stopped' as ToolUseDisplay['status'],
                streamingInput: undefined,
              }
            : tu,
        )
        // G: legacy `isThinking: false` mirror dropped. Per-block
        // `isStreaming` sealing above is the source of truth; the
        // top-level flag was a duplicate that risked drift.
        return { ...m, isStreaming: false, blocks, toolUses }
      }),
      isTyping: false,
      pendingPermissionRequest: null,
      // HITL pause is the expected "stream ended but user still needs to
      // answer" case; do not clear the AskUserQuestion slot in that state.
      pendingAskUserQuestion: sl.hitlPaused ? sl.pendingAskUserQuestion : null,
    }),
    { recalledMemories: [], recalledWorkspaceHits: [], recalledAttachmentHits: [] },
  )
  void persistBufferedConversation(convId)
  flushTurnQueueFor(convId)
}

/**
 * `context_compact_start` — compaction is beginning. Surface a transient
 * "正在压缩…" toast (active conversation only). The matching
 * `context_compact` success event resolves it to "已压缩 · 释放 N tokens"
 * and the toast then auto-dismisses. Previously each compaction appended a
 * permanent `compact_boundary` divider that stacked at the bottom forever;
 * the transient toast replaces that entirely.
 */
export function handleContextCompactStartEvent({ event, convId, st0 }: MainRouterContext): void {
  if (convId !== st0.currentConversationId) return
  const level =
    typeof (event as unknown as { level?: string }).level === 'string'
      ? (event as unknown as { level: string }).level
      : 'unknown'
  useCompactionToastStore.getState().start(convId, level)
}

export function handleContextCompactEvent({ event, convId, st0, api }: MainRouterContext): void {
  // Compaction succeeded. Resolve the transient toast to its "done" state
  // (auto-dismisses shortly after). No permanent transcript entry is added —
  // the old `compact_boundary` divider behaviour was removed because every
  // threshold's divider stayed in the UI permanently and stacked at the
  // bottom. `apiMessageBuilder` still filters any legacy `compact_boundary`
  // entries from persisted conversations so they never reach the model.
  const level =
    typeof (event as unknown as { level?: string }).level === 'string'
      ? (event as unknown as { level: string }).level
      : 'unknown'
  const reclaimedTokens = (event as unknown as { reclaimedTokens?: number })
    .reclaimedTokens

  if (convId === st0.currentConversationId) {
    useCompactionToastStore.getState().done(convId, level, reclaimedTokens)
  }

  // Capture the summary payload (if main pushed one) so the next send
  // reuses it instead of recomputing a weaker local summary.
  if (convId === st0.currentConversationId) {
    const text =
      typeof event.text === 'string'
        ? event.text
        : typeof (event as unknown as { summary?: string }).summary === 'string'
          ? (event as unknown as { summary?: string }).summary || ''
          : ''
    if (text.trim()) {
      api.setState({ currentCompactSummary: text.trim() })
    }
  }
}
