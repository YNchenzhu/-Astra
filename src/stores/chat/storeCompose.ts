/**
 * Composed chat store entry.
 *
 * The actual state + actions live in per-domain slices under
 * `./slices/*.ts`; stream dispatch lives in `./mainStreamRouter.ts` and
 * `./subAgentStreamRouter.ts`. This file only composes them into the
 * final Zustand store, binds the shared `chatStoreApi` ref so the routers
 * can access the bound hook without a module-init cycle, and installs the
 * streaming-delta batcher bridge.
 *
 * Public symbols expected by downstream callers (ChatPanel / ConversationList /
 * test harnesses) are re-exported at the bottom so existing imports from
 * `./chat/storeCompose` continue to work unchanged.
 */
import { create } from 'zustand'

import { bindChatStoreApi } from './storeApiRef'
import { createMessagesSlice } from './slices/messagesSlice'
import { createInputSlice } from './slices/inputSlice'
import { createSendSlice } from './slices/sendSlice'
import { createConversationSlice } from './slices/conversationSlice'
import { createToolSlice } from './slices/toolSlice'
import { createOrchestrationSlice } from './slices/orchestrationSlice'
import { installDeltaBatcherBridge } from './streamEvents/applyBatchedDeltas'
import { installToolInputBatcherBridge } from './streamEvents/applyToolInputBatch'
import { flushAllPersistedConversationsForQuit as _flushAllPersistedConversationsForQuit } from './flushAllConversations'
import {
  pendingAssistantByConversation,
  readSlice,
  commitSlice,
  getActiveStreamIdsKey,
  countBackgroundActiveStreams,
} from './sessionSlice'
import { CHAT_MODE_OPTIONS } from './types'
import type {
  AgentType,
  ChatInteractionMode,
  ChatSessionSlice,
  ChatState,
} from './types'

export const useChatStore = create<ChatState>()((...a) => ({
  ...createMessagesSlice(...a),
  ...createInputSlice(...a),
  ...createSendSlice(...a),
  ...createConversationSlice(...a),
  ...createToolSlice(...a),
  ...createOrchestrationSlice(...a),
}))

// Wire the shared ref so `mainStreamRouter` / `subAgentStreamRouter` /
// the retrieval / persistence adapters can read `useChatStore` without a
// module-init cycle. Must happen before any router subscribes.
bindChatStoreApi(useChatStore)

// Install the batcher's flush target exactly once at module load.
installDeltaBatcherBridge()
installToolInputBatcherBridge()

// ─── Public re-exports (keep stable for downstream consumers) ─────────
// Types + constants come through `./types`. Router entry points and the
// `flushAllPersistedConversationsForQuit` quit-path helper come through
// their dedicated modules.

export { CHAT_MODE_OPTIONS }
export type { AgentType, ChatInteractionMode, ChatSessionSlice, ChatState }

export {
  pendingAssistantByConversation,
  readSlice,
  commitSlice,
  getActiveStreamIdsKey,
  countBackgroundActiveStreams,
}

/**
 * Await during app quit: persist every session slice that has messages
 * (incl. background tabs). Bound to `useChatStore` here so call sites
 * retain the nullary `flushAllPersistedConversationsForQuit()` signature
 * they had while the implementation was inline.
 */
export function flushAllPersistedConversationsForQuit(): Promise<void> {
  return _flushAllPersistedConversationsForQuit(useChatStore)
}

export {
  handleMainStreamEvent,
  ensureMainChatStreamRouter,
  disposeMainChatStreamRouter,
} from './mainStreamRouter'

export {
  ensureSubAgentGlobalStream,
  disposeSubAgentGlobalStream,
} from './subAgentStreamRouter'
