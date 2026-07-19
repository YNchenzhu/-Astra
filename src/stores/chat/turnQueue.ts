import type { ChatState, QueuedMainChatTurn } from './types'
import { pendingAssistantByConversation } from './sessionSlice'

/**
 * Per-conversation queue of user turns typed while a main stream is in
 * flight. Appendix-A phase-one style: we never silently drop input; we
 * replay it when the queue is safe to flush.
 */
export const mainChatTurnQueue = new Map<string, QueuedMainChatTurn[]>()

/**
 * Append a user turn to the queue for `convId`. Returns the queue length
 * after insertion so the caller can decide whether to show a pending-queue
 * indicator.
 */
export function enqueueMainChatTurn(convId: string, turn: QueuedMainChatTurn): number {
  const q = mainChatTurnQueue.get(convId) ?? []
  q.push(turn)
  mainChatTurnQueue.set(convId, q)
  return q.length
}

export function clearMainChatTurnQueue(convId: string): void {
  mainChatTurnQueue.delete(convId)
}

/**
 * Try to release the next queued turn into the single main-chat input
 * slot.
 *
 * Invariants (system-level, not local patches):
 *   - A queued turn can only be "released" into the single main-chat input
 *     slot, so the target conversation MUST be the currently-visible one.
 *   - If the stream for `convId` completes while the user is on another
 *     tab, we deliberately keep the queue intact and replay it from the
 *     conversation-switch path (see `loadConversationById`) instead of
 *     dropping the turn.
 *   - Never flush while another main turn is in flight for the same
 *     conversation (`pendingAssistantByConversation` guard) or while the
 *     renderer is globally typing (legacy single-in-flight assumption).
 */
export function flushMainChatTurnQueueForConversation(
  getState: () => ChatState,
  setState: (partial: Partial<ChatState>) => void,
  sendMessage: () => Promise<void>,
  convId: string,
): void {
  const queue = mainChatTurnQueue.get(convId)
  if (!queue || queue.length === 0) return
  const st = getState()
  if (pendingAssistantByConversation.has(convId)) return
  // Only flush into the visible conversation; otherwise keep the queue
  // parked for a later visit (see loadConversationById).
  if (st.currentConversationId !== convId) return
  if (st.isTyping) return
  const next = queue.shift()
  if (!next) return
  if (queue.length === 0) mainChatTurnQueue.delete(convId)
  else mainChatTurnQueue.set(convId, queue)
  setState({
    inputText: next.inputText,
    referencedFiles: [...next.referencedFiles],
    pendingAttachments: [...next.pendingAttachments],
  })
  void sendMessage()
}
