/**
 * Bridge between the streaming-delta batcher and the zustand chat store.
 *
 * The batcher (`../streamingDeltaBatcher`) coalesces per-token `text_delta`
 * / `thinking_delta` events into a single animation-frame-aligned flush.
 * This module is the flush consumer: one `setState` per frame instead of
 * one per token, which collapses N selector re-renders in `ChatPanel` into
 * one.
 *
 * Block-merge rule (the hard-won part)
 * ------------------------------------
 * Some providers (notably Gemini's `thoughtSummary` mode, and any gateway
 * that splits per-token across both content channels) emit `text_delta`
 * and `thinking_delta` events INTERLEAVED at token granularity. A naive
 * "merge into lastBlock if same type, else push new" produces dozens of
 * tiny thinking + text blocks in `m.blocks` — the UI then renders one
 * `ThinkingBlock` per fragment, yielding the "Thought for 0.0s" stutter.
 *
 * The fix: walk backwards from the tail when adding a delta, treating
 * `text` and `thinking` as soft-merge peers and `tool_use` / `image` /
 * `ask_user_question` as HARD boundaries that prohibit merging across.
 * This consolidates per-turn reasoning into ONE thinking block + ONE
 * text block, while still creating fresh blocks after a tool call.
 *
 * Ordering note: any thinking block in the current "section" (i.e. since
 * the last hard boundary) gets sealed the moment text begins — the
 * lingering streaming spinner is the visual cue we don't want bleeding
 * into the answer.
 */
import type { ContentBlock } from '../../../types/tool'
import {
  installDeltaBatchFlush,
  type DeltaFlushPayload,
} from '../streamingDeltaBatcher'
import { patchConversationSlice } from '../sessionSlice'
import { chatStoreApi } from '../storeApiRef'

/**
 * Per-block-type merge classification. Drives both backward-merge target
 * search and "current section" boundary walks. Keeping this as a single
 * source of truth makes adding new soft-merge peers (e.g.
 * `reasoning_summary` — see B) a one-line change instead of an N-place
 * audit across `HARD_BOUNDARY_BLOCK_TYPES`, `findMergeTargetIdx`, the
 * thinking-seal loop in `applyBatchedDeltasToSlice`, etc.
 *
 *   - `mergeable-text`              — assistant prose; same-kind deltas
 *                                     coalesce into one block per section.
 *   - `mergeable-thinking`          — raw chain-of-thought; same rules.
 *   - `mergeable-reasoning-summary` — provider-emitted TL;DR of the
 *                                     reasoning (OpenAI Responses
 *                                     `summary[]`); behaves like a third
 *                                     soft-merge peer so summary deltas
 *                                     interleaved with text/thinking
 *                                     deltas still produce ONE summary
 *                                     block per section.
 *   - `boundary`                    — discrete model-side action (tool
 *                                     call, image emission, structured
 *                                     user prompt). Closes the current
 *                                     section: nothing merges across it.
 */
export type BlockMergeKind =
  | 'mergeable-text'
  | 'mergeable-thinking'
  | 'mergeable-reasoning-summary'
  | 'boundary'

export function getBlockMergeKind(type: ContentBlock['type']): BlockMergeKind {
  switch (type) {
    case 'text':
      return 'mergeable-text'
    case 'thinking':
      return 'mergeable-thinking'
    case 'reasoning_summary':
      return 'mergeable-reasoning-summary'
    // Tool calls / images / ask-user-question explicitly enumerated below
    // as boundaries; any other future block type defaults to `boundary`
    // (the conservative choice — a new block kind shouldn't accidentally
    // get merged with thinking by virtue of being undocumented in this
    // switch).
    case 'tool_use':
    case 'image':
    case 'ask_user_question':
      return 'boundary'
    default:
      return 'boundary'
  }
}

/**
 * Walk backwards through `blocks` looking for the most recent block whose
 * merge kind matches `targetKind`. Stops (and returns -1) the moment a
 * hard-boundary block is encountered — those mark a real semantic gap
 * that must not be bridged by streaming-delta merge.
 *
 * Soft peers (the "other" mergeable kinds) are skipped harmlessly —
 * that's what lets per-token interleaved deltas all collapse into the
 * same thinking + text + reasoning_summary trio.
 */
function findMergeTargetIdx(
  blocks: ContentBlock[],
  targetKind: Exclude<BlockMergeKind, 'boundary'>,
): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const kind = getBlockMergeKind(blocks[i].type)
    if (kind === targetKind) return i
    if (kind === 'boundary') return -1
  }
  return -1
}

function hasLaterTextInCurrentSection(blocks: ContentBlock[], idx: number): boolean {
  for (let i = idx + 1; i < blocks.length; i++) {
    const kind = getBlockMergeKind(blocks[i].type)
    if (kind === 'boundary') return false
    if (kind === 'mergeable-text') return true
  }
  return false
}

export function applyBatchedDeltasToSlice(
  convId: string,
  payload: DeltaFlushPayload,
): void {
  const { assistantId, text, thinking, reasoningSummary } = payload
  chatStoreApi().setState((st) =>
    patchConversationSlice(st, convId, (sl) => ({
      ...sl,
      messages: sl.messages.map((m) => {
        if (m.id !== assistantId) return m
        // Once the message has been finalized (user cancel, error, or
        // `message_stop`), drop any straggler delta — the abort path on the
        // main process is asynchronous, so `thinking_delta` events can still
        // be in flight after `cancelMessage` has flipped `isStreaming` to
        // false. Applying them would re-stamp `isStreaming: true` onto the
        // matching thinking block, which keeps `ThinkingBlock`'s internal
        // tick effect alive and produces the "Thinking 253.7s" runaway
        // counter the user sees after pressing Stop.
        if (m.isStreaming === false) return m
        const blocks = [...(m.blocks || [])]
        let nextContent = m.content

        if (thinking) {
          const idx = findMergeTargetIdx(blocks, 'mergeable-thinking')
          if (idx !== -1) {
            const existing = blocks[idx] as Extract<ContentBlock, { type: 'thinking' }>
            const textAlreadyStarted = hasLaterTextInCurrentSection(blocks, idx)
            blocks[idx] = {
              ...existing,
              text: existing.text + thinking,
              isStreaming: !textAlreadyStarted,
            }
          } else {
            blocks.push({ type: 'thinking', text: thinking, isStreaming: true })
          }
          // G: legacy `m.thinking` / `m.isThinking` mirrors deliberately
          // NOT updated here. The blocks array is the canonical source
          // of truth for thinking content; the legacy fields stayed in
          // place purely to support `ChatMessage.tsx`'s defensive
          // fallback render for old conversation JSON that predates the
          // blocks-based model. New writes pass through blocks-only.
        }

        if (reasoningSummary) {
          // Summary follows the same soft-merge rule as thinking and
          // text: walk back to the most recent same-kind block within
          // the current section.
          const idx = findMergeTargetIdx(blocks, 'mergeable-reasoning-summary')
          if (idx !== -1) {
            const existing = blocks[idx] as Extract<
              ContentBlock,
              { type: 'reasoning_summary' }
            >
            blocks[idx] = {
              ...existing,
              text: existing.text + reasoningSummary,
              isStreaming: true,
            }
          } else {
            blocks.push({
              type: 'reasoning_summary',
              text: reasoningSummary,
              isStreaming: true,
            })
          }
        }

        if (text) {
          // Seal any still-streaming thinking / reasoning_summary block
          // in the current section (since the last hard boundary). The
          // spinner on a reasoning row shouldn't linger once user-facing
          // text starts arriving.
          for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i]
            if (getBlockMergeKind(b.type) === 'boundary') break
            if (b.type === 'thinking' && b.isStreaming) {
              blocks[i] = { ...b, isStreaming: false }
            } else if (b.type === 'reasoning_summary' && b.isStreaming) {
              blocks[i] = { ...b, isStreaming: false }
            }
          }
          const idx = findMergeTargetIdx(blocks, 'mergeable-text')
          if (idx !== -1) {
            const existing = blocks[idx] as Extract<ContentBlock, { type: 'text' }>
            blocks[idx] = { ...existing, text: existing.text + text }
          } else {
            blocks.push({ type: 'text', text })
          }
          nextContent = nextContent + text
        }

        return {
          ...m,
          content: nextContent,
          blocks,
        }
      }),
    })),
  )
}

/**
 * Wire the batcher's flush target. Call exactly once from the composer
 * after the store is bound — the batcher itself is stateless w.r.t.
 * zustand; this adapter is what routes the coalesced payload back into
 * the chat store.
 */
export function installDeltaBatcherBridge(): void {
  installDeltaBatchFlush(applyBatchedDeltasToSlice)
}
