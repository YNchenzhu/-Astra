import type { ChatMessage, ConversationMeta } from '../../types'
import type { ChatState } from './types'
import { saveConversation } from '../../services/conversationAPI'
import { dehydrateMessages, preStageBlockImages } from '../../services/attachmentPersistence'
import { useSettingsStore } from '../useSettingsStore'
import { useWorkspaceStore } from '../useWorkspaceStore'
import { getActiveBundleId } from '../bundleStore'
import { readSlice } from './sessionSlice'

/**
 * Default error string stamped onto historical `tool_use` blocks that were
 * persisted with `status: 'error'` but no `error` field (the
 * "phantom-error" data shape produced by older builds before the
 * mainStreamRouter `case 'error'` fix stamped an explicit error string).
 *
 * Surfaced to the model as the `tool_result` content. The text intentionally
 * tells the model that the result is gone from the transcript and that it
 * should treat the call as benign + continue — without this nudge, the model
 * sees an unexplained tool failure and tends to either retry the same call or
 * stall the turn (the user-reported `[Tool ended with status: error]` loop).
 */
export const PHANTOM_TOOL_USE_ERROR_HEAL_MSG =
  'Tool result was lost in persistence (status recorded as error but no detail captured). ' +
  'Treat this prior tool call as a benign no-op and continue with the user’s next instruction.'

/**
 * One-shot "heal" pass for tool_use blocks that were persisted in the broken
 * `status='error' + error=''` shape. Runs on the load path
 * (`loadConversationById`) right after `hydrateMessages`, so historical
 * conversations stop poisoning every subsequent turn's context with a
 * `[Tool ended with status: error]` catch-all in `contextBuilder.ts`.
 *
 * Pure / non-mutating: every changed message is returned as a new object
 * tree. Messages without offending blocks are returned by reference so
 * downstream identity-equality checks stay cheap.
 */
export function healPoisonedToolUseBlocks(messages: ChatMessage[]): ChatMessage[] {
  const out = messages.map((m) => {
    let messageChanged = false
    let nextBlocks = m.blocks
    if (Array.isArray(m.blocks)) {
      const patched = m.blocks.map((b) => {
        if (
          b &&
          (b as { type?: string }).type === 'tool_use' &&
          (b as { status?: string }).status === 'error' &&
          !((b as { error?: unknown }).error) &&
          !((b as { result?: unknown }).result)
        ) {
          messageChanged = true
          return { ...b, error: PHANTOM_TOOL_USE_ERROR_HEAL_MSG }
        }
        return b
      })
      if (messageChanged) nextBlocks = patched
    }
    let nextToolUses = m.toolUses
    if (Array.isArray(m.toolUses)) {
      let toolUsesChanged = false
      const patched = m.toolUses.map((tu) => {
        if (
          tu &&
          tu.status === 'error' &&
          !tu.error &&
          !tu.result
        ) {
          toolUsesChanged = true
          return { ...tu, error: PHANTOM_TOOL_USE_ERROR_HEAL_MSG }
        }
        return tu
      })
      if (toolUsesChanged) {
        nextToolUses = patched
        messageChanged = true
      }
    }
    return messageChanged ? { ...m, blocks: nextBlocks, toolUses: nextToolUses } : m
  })
  return out
}

/** Options shared by every "prepare for persist" helper in this module. */
export interface PersistTransformOptions {
  /**
   * When true, `thinking` blocks whose `text` exceeds
   * {@link COMPACT_THINKING_THRESHOLD} are truncated in-place to a short
   * preview prefix plus an elided-count suffix. The block's
   * cryptographic `signature` is also dropped (the truncation would
   * invalidate it anyway), and `compactedAt` is stamped so the renderer
   * can surface a "(truncated)" hint.
   *
   * Setting is driven by `useSettingsStore.compactThinkingOnSave`. The
   * caller is expected to read it once and pass through — keeps these
   * persist helpers pure / unit-testable.
   *
   * Default: behaviour unchanged (no compaction).
   */
  compactThinking?: boolean
}

/**
 * Strip transient streaming-UI flags (`isStreaming`, `isThinking`, per-block
 * `isStreaming` on thinking AND reasoning_summary blocks) from a message
 * array so it round-trips safely through the persistence layer. **Pure** —
 * does not touch attachment bytes, does not hit the network, does not mutate
 * its input.
 *
 * Per-block coverage:
 *   - `thinking` — historical: this was the only block kind covered.
 *   - `reasoning_summary` — added for parity. OpenAI Responses API's TL;DR
 *     channel has the same `isStreaming` mid-stream semantics; if we don't
 *     strip it,a session that quit / crashed while a summary was still
 *     streaming reloads with `ReasoningSummaryBlock` stuck on the running
 *     spinner forever (no `message_stop` will arrive for the dead session).
 *     Unlike thinking,reasoning_summary has no `signature` so clearing the
 *     flag is unambiguously safe.
 *
 * When `options.compactThinking` is true, additionally runs the thinking
 * compaction pass (see {@link compactThinkingInMessages}). This is the
 * established opt-in for storage shrinkage in long agentic sessions.
 *
 * Use this standalone when the caller is writing to a transport that must
 * keep attachment base64 inline (e.g. the quit-path / buffered-persist
 * fallbacks in `storeCompose.ts` that intentionally skip `preStageBlockImages`
 * for atomicity). Pair with {@link cleanMessagesForPersist} instead when the
 * caller already staged images via {@link ../../services/attachmentPersistence#preStageBlockImages}
 * and wants base64 → sha256 sentinel rewriting.
 */
export function stripStreamingUiFlags(
  messages: ChatMessage[],
  options: PersistTransformOptions = {},
): ChatMessage[] {
  // Plan Phase 2.B — fallback tombstone：被 mainStreamRouter#stream_fallback_reset
  // 打了标记 **且实质为空** 的空壳消息不应进入持久化。否则重启后会读到一条
  // role=assistant content='' blocks=[] 的占位消息。
  //
  // 修订：fallback 成功后非流式响应会重新追加 blocks 到同一条消息，标记还在但
  // blocks 有真实内容 — 这种情况要正常持久化。只丢弃"标记 + 真的没内容"的双重
  // 失败场景。
  const filteredOut = messages.filter((m) => {
    if (m._streamFallbackTombstone !== true) return true
    const hasBlocks = Array.isArray(m.blocks) && m.blocks.length > 0
    const hasContent = typeof m.content === 'string' && m.content.trim().length > 0
    const hasToolUses = Array.isArray(m.toolUses) && m.toolUses.length > 0
    // 标记存在但 blocks/content/toolUses 都空 → 真正的空壳，丢弃
    return hasBlocks || hasContent || hasToolUses
  })
  const stripped = filteredOut.map((m) => ({
    ...m,
    isStreaming: undefined,
    isThinking: undefined,
    blocks: (m.blocks || []).map((b) => {
      if (b.type === 'thinking') return { ...b, isStreaming: false }
      if (b.type === 'reasoning_summary') return { ...b, isStreaming: false }
      return b
    }),
    // P1-5 (audit): drop `streamingProgress` from persisted tool blocks.
    // The router clears it in the `tool_result` branch (see
    // `mainStreamRouter.ts`), but quit-time flush or crash recovery can
    // catch a tool mid-stream — without this strip the chunk buffer
    // (up to 32 KB text + 200 events per tool) would round-trip through
    // disk into the next session restore.
    //
    // Same treatment for `streamingInput` (model-args streaming buffer
    // for Write/Edit IDE-style cards). On quit-during-args the
    // buffer can be hundreds of KB and is meaningless after restart —
    // the model isn't streaming anymore, so a frozen partial JSON
    // would only mislead the UI into showing a "still typing" card.
    toolUses: m.toolUses?.map((tu) => {
      if (!tu.streamingProgress && !tu.streamingInput) return tu
      return { ...tu, streamingProgress: undefined, streamingInput: undefined }
    }),
  }))
  return options.compactThinking ? compactThinkingInMessages(stripped) : stripped
}

/**
 * Threshold above which a `thinking` block's text gets truncated by the
 * persistence-layer compaction pass. Blocks at or below this size are
 * left intact — the storage savings wouldn't justify the loss of full
 * context.
 *
 * 600 chars chosen empirically: enough to keep short / well-organised
 * reasoning verbatim (the typical chain-of-thought for an interactive
 * back-and-forth) while still catching the long ones that dominate
 * conversation-JSON size (multi-step planning, web-search-summary
 * dumps, etc.).
 */
export const COMPACT_THINKING_THRESHOLD = 600
/** Prefix length kept when a block is compacted. */
export const COMPACT_THINKING_PREVIEW_LENGTH = 200

/**
 * Truncate over-long `thinking` blocks in-place on a per-message basis.
 * Exported separately from {@link stripStreamingUiFlags} so callers can
 * unit-test the compaction rules independently and so persist paths can
 * compose it without inheriting the streaming-flag strip semantics.
 *
 * Invariants:
 *   - Idempotent: a block already marked `compactedAt` is left alone.
 *   - Only the `text` is changed; `thinkingTimeMs` / `thinkingTokens`
 *     pass through verbatim.
 *   - `signature` is dropped (truncating the text invalidates any
 *     cryptographic signature over it).
 *   - `reasoning_summary` blocks are explicitly NOT compacted —
 *     summaries are short by API contract (a few sentences) and the
 *     storage win wouldn't compensate for losing the model's own TL;DR.
 */
export function compactThinkingInMessages(messages: ChatMessage[]): ChatMessage[] {
  let anyChanged = false
  const next = messages.map((m) => {
    if (!m.blocks || m.blocks.length === 0) return m
    let touched = false
    const newBlocks = m.blocks.map((b) => {
      if (b.type !== 'thinking') return b
      if (b.compactedAt) return b // already compacted; idempotent
      if (b.text.length <= COMPACT_THINKING_THRESHOLD) return b
      touched = true
      const elided = b.text.length - COMPACT_THINKING_PREVIEW_LENGTH
      const preview = b.text.slice(0, COMPACT_THINKING_PREVIEW_LENGTH)
      // `\n…(N characters elided)` suffix; keeps the prefix's natural
      // ending (often mid-sentence) without injecting markdown that
      // would render weirdly.
      const newText = `${preview}\n…(${elided} characters elided on save)`
      // Spread sans signature — TS preserves the discriminant.
      const { signature: _signature, ...rest } = b as Record<string, unknown> & {
        type: 'thinking'
      }
      void _signature
      return {
        ...(rest as Omit<typeof b, 'signature'>),
        text: newText,
        compactedAt: Date.now(),
      }
    })
    if (!touched) return m
    anyChanged = true
    return { ...m, blocks: newBlocks }
  })
  return anyChanged ? next : messages
}

/**
 * Strip transient streaming-UI flags from a message array so it round-trips
 * safely through the persistence layer. Used by every save path (active save,
 * buffered save on message_stop, quit-time flush).
 *
 * Also swaps heavy attachment base64 payloads (PDF / scanned-PDF page images /
 * uploaded raw images) for a sentinel token — the actual bytes are kept in the
 * main-process `attachment-cache/` keyed by sha256+kind. Load paths call
 * {@link ../../services/attachmentPersistence#hydrateMessages} to refill.
 *
 * PRE-CONDITION: callers that use this function MUST have already staged
 * inline base64 via `preStageBlockImages` — otherwise the sentinels written
 * here point at bytes that never made it to disk and the next load will
 * hydrate to empty attachments. See the audit note in `storeCompose.ts` for
 * why the quit-path persistence currently uses {@link stripStreamingUiFlags}
 * directly instead of composing through here.
 */
export function cleanMessagesForPersist(
  messages: ChatMessage[],
  options: PersistTransformOptions = {},
): ChatMessage[] {
  return dehydrateMessages(stripStreamingUiFlags(messages, options))
}

/**
 * Sync header title when main process returns persisted meta for this
 * conversation. No-op when the conversation isn't currently active or the
 * meta has no usable title.
 */
export function applyPersistedTitleFromMeta(
  getState: () => ChatState,
  setState: (partial: Partial<ChatState> | ((st: ChatState) => Partial<ChatState>)) => void,
  convId: string,
  meta: ConversationMeta | Record<string, unknown> | null | undefined,
): void {
  const raw =
    meta && typeof meta === 'object' && 'title' in meta
      ? (meta as { title?: unknown }).title
      : undefined
  const t = typeof raw === 'string' ? raw.trim() : ''
  if (!t) return
  const st = getState()
  if (st.currentConversationId !== convId) return
  setState({ currentConversationTitle: t })
}

/**
 * Persist a buffered conversation slice (typically called on `message_stop`
 * / `error` stream events for the background conversation).
 */
export async function persistBufferedConversation(
  getState: () => ChatState,
  setState: (partial: Partial<ChatState> | ((st: ChatState) => Partial<ChatState>)) => void,
  convId: string,
): Promise<void> {
  const s = getState()
  const sl = readSlice(s, convId)
  if (sl.messages.length === 0) return
  const workspaceState = useWorkspaceStore.getState()
  const settings = useSettingsStore.getState()
  try {
    const staged = await preStageBlockImages(sl.messages)
    const meta = await saveConversation({
      id: convId,
      messages: cleanMessagesForPersist(staged, {
        compactThinking: settings.compactThinkingOnSave,
      }),
      workspacePath: workspaceState.rootPath || '',
      model: settings.model,
      providerId: settings.providerId,
      todos: sl.todos.length > 0 ? sl.todos : undefined,
      // Scope persistence to the currently active Bundle. `undefined`
      // maps to the code-dev legacy partition on the main side so
      // pre-bundle saves keep working.
      bundleId: getActiveBundleId(),
    })
    applyPersistedTitleFromMeta(getState, setState, convId, meta)
  } catch (e) {
    console.error('[ChatStore] persistBufferedConversation failed:', e)
  }
}
