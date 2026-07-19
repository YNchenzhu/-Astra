/**
 * Thin zustand adapter around `fireRetrievalUiCaptureAsync` in
 * `./retrievalBudget`.
 *
 * The split module owns the racing retrieval pipeline + the "slow" trailing
 * capture that fires after the 800 ms budget window; it exposes a DI-form
 * that takes an "apply retrieved chunks to a user message row" callback.
 * This wrapper binds that callback to `useChatStore.setState` so in-module
 * call sites in the send / stream pipeline keep their terse two-argument
 * signature.
 */
import type { ChatMessage, RetrievedChunkDisplay } from '../../types'
import { fireRetrievalUiCaptureAsync as _fireRetrievalUiCaptureAsyncExt } from './retrievalBudget'
import type { UseBoundStore, StoreApi } from 'zustand'
import type { ChatState } from './types'

export function fireRetrievalUiCaptureAsync(
  useStore: UseBoundStore<StoreApi<ChatState>>,
  userMessageId: string,
  allMessages: ChatMessage[],
): Promise<void> {
  return _fireRetrievalUiCaptureAsyncExt(
    userMessageId,
    allMessages,
    (messageId: string, retrievedChunks: RetrievedChunkDisplay[]) => {
      useStore.setState((s) => ({
        messages: s.messages.map((m) =>
          m.id === messageId ? { ...m, retrievedChunks } : m,
        ),
      }))
    },
  )
}
