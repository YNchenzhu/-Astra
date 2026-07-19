/**
 * Shared handle onto the composed chat-store api.
 *
 * `mainStreamRouter` / `subAgentStreamRouter` need to mutate chat state in
 * response to incoming IPC events, but importing the bound `useChatStore`
 * directly from `./storeCompose` would create a module-init cycle:
 *
 *   storeCompose → sendSlice → mainStreamRouter → storeCompose
 *
 * A minimal ref module sidesteps the cycle. The composer binds the hook
 * once right after `create()` returns; routers read the ref lazily (only
 * inside handler function bodies, never at import time).
 */
import type { StoreApi, UseBoundStore } from 'zustand'
import type { ChatState } from './types'

type ChatStore = UseBoundStore<StoreApi<ChatState>>

let boundStore: ChatStore | null = null

export function bindChatStoreApi(store: ChatStore): void {
  boundStore = store
}

export function chatStoreApi(): ChatStore {
  if (!boundStore) {
    throw new Error(
      '[chatStoreApi] Accessed before the chat store was bound. ' +
        'Make sure storeCompose.ts calls bindChatStoreApi(useChatStore) after create().',
    )
  }
  return boundStore
}
