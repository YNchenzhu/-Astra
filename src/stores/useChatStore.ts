/**
 * Thin re-export shell for the chat store.
 *
 * The actual composition (the `create<ChatState>(...)` block with all actions,
 * stream wiring, conversation persistence, sub-agent handling, etc.) lives in
 * `./chat/storeCompose.ts`. Stateless helpers and type definitions live in
 * dedicated `./chat/*` modules (`types.ts`, `sessionSlice.ts`,
 * `apiMessageBuilder.ts`, `conversationPersistence.ts`, `desktopNotify.ts`,
 * `turnQueue.ts`, `diffPreviewBridge.ts`).
 *
 * External callers can keep importing `useChatStore` / `CHAT_MODE_OPTIONS` /
 * `countBackgroundActiveStreams` / `ensureSubAgentGlobalStream` /
 * `getActiveStreamIdsKey` from this path — this file just re-exports the
 * canonical split-module symbols so downstream consumers see a single surface.
 */

export {
  useChatStore,
  // Types / options
  // (these come from storeCompose.ts which itself re-exports from ./chat/types)
  CHAT_MODE_OPTIONS,
  // Session-slice helpers consumed directly by ChatPanel / ConversationList
  pendingAssistantByConversation,
  readSlice,
  getActiveStreamIdsKey,
  countBackgroundActiveStreams,
  commitSlice,
  // Lifecycle helpers surfaced to callers.
  flushAllPersistedConversationsForQuit,
} from './chat/storeCompose'

export type {
  AgentType,
  ChatInteractionMode,
  ChatSessionSlice,
  ChatState,
} from './chat/storeCompose'

// These three live inline in storeCompose.ts as 0-arg wrappers that close over
// the store's module-level `chatStreamUnsubscribe` / `subAgentGlobalUnsub`
// state. Existing callers (ChatPanel mount effect, conversation switch) expect
// nullary signatures.
export {
  ensureMainChatStreamRouter,
  disposeMainChatStreamRouter,
  ensureSubAgentGlobalStream,
} from './chat/storeCompose'
