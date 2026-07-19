/**
 * Bridge between the tool-input batcher and the zustand chat store.
 *
 * The batcher (`../toolInputDeltaBatcher`) coalesces per-tick `tool_input_
 * delta` events into a single animation-frame-aligned flush. This module is
 * the flush consumer: one `setState` per frame patching every pending tool's
 * `streamingInput`, instead of one `setState` per ~20Hz delta.
 *
 * Only EXISTING `toolUses` entries are patched — the first delta for a tool
 * (which seeds the placeholder block + toolUses entry) is handled
 * synchronously in `mainStreamRouter`, so by the time a delta reaches this
 * batched path the entry always exists. A finished / stopped tool whose
 * entry is gone is simply skipped.
 */
import { installToolInputBatchFlush, type ToolInputEntry } from '../toolInputDeltaBatcher'
import { patchConversationSlice } from '../sessionSlice'
import { chatStoreApi } from '../storeApiRef'

export function applyToolInputBatchToSlice(
  convId: string,
  entries: ReadonlyMap<string, ToolInputEntry>,
): void {
  if (entries.size === 0) return
  chatStoreApi().setState((st) =>
    patchConversationSlice(st, convId, (sl) => ({
      ...sl,
      messages: sl.messages.map((m) => {
        // Mirror `applyBatchedDeltas`: once a message is finalized (user
        // cancel, error, message_stop all flip `isStreaming` to false), drop
        // any straggler tool-input write. The abort path is async, so a
        // batched `tool_input_delta` (or a pending rAF) can still arrive
        // after the message settled — applying it would resurrect a
        // streamingInput caret / Write-Edit progress card on a stopped tool.
        if (m.isStreaming === false) return m
        if (!m.toolUses || m.toolUses.length === 0) return m
        let changed = false
        const toolUses = m.toolUses.map((t) => {
          const entry = entries.get(t.id)
          if (!entry) return t
          // Only the assistant turn that owns this streaming tool may adopt
          // the batched input (tool ids are globally unique, but this keeps
          // the patch precise and uses the captured assistantId).
          if (entry.assistantId !== m.id) return t
          // Once a tool's input became authoritative — `tool_start` /
          // `tool_result` / stop all clear `streamingInput` — we must NOT
          // write it back. The first delta is applied synchronously and
          // seeds `streamingInput`, so any batched delta legitimately
          // targets an entry that still has it.
          if (t.streamingInput == null) return t
          // Skip if the partialJson is unchanged so we don't churn the
          // object reference (keeps the ToolUseCard memo from re-rendering
          // when the batched value matched what's already shown).
          if (t.streamingInput.partialJson === entry.partialJson) return t
          changed = true
          return { ...t, streamingInput: { partialJson: entry.partialJson } }
        })
        return changed ? { ...m, toolUses } : m
      }),
    })),
  )
}

/**
 * Wire the batcher's flush target. Call exactly once from the composer
 * after the store is bound.
 */
export function installToolInputBatcherBridge(): void {
  installToolInputBatchFlush(applyToolInputBatchToSlice)
}
