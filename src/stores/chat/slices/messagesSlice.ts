/**
 * Messages + per-conversation session state slice.
 *
 * Owns the "what is currently on screen" fields:
 *   - `messages` / `sessionBuffers` (active vs parked slices)
 *   - `isTyping`, `todos`, `currentConversationId` / `title`
 *   - `currentCompactSummary` (pushed by the `context_compact` stream event)
 *   - `pendingPermissionRequest` / `pendingAskUserQuestion`
 *
 * Plus the primitive setter trio (`addMessage` / `setMessages` /
 * `setIsTyping` / `updateStreamingContent`). Everything compound
 * (send, load/save, permission reply, stream handling) lives in its own
 * slice / module so this file stays focused on "store the transcript".
 */
import type { StateCreator } from 'zustand'
import type { ChatState } from '../types'

export type MessagesSlice = Pick<ChatState,
  | 'messages' | 'sessionBuffers' | 'isTyping' | 'todos'
  | 'currentConversationId' | 'currentConversationTitle'
  | 'currentCompactSummary'
  | 'pendingPermissionRequest' | 'pendingAskUserQuestion' | 'pendingTeamPlanApproval' | 'pendingPlanApproval'
  | 'sessionMemoryStatus'
  | 'addMessage' | 'setMessages' | 'setIsTyping' | 'updateStreamingContent'
>

export const createMessagesSlice: StateCreator<
  ChatState, [], [], MessagesSlice
> = (set) => ({
  messages: [],
  sessionBuffers: {},
  isTyping: false,
  todos: [],
  currentConversationId: null,
  currentConversationTitle: '新对话',
  currentCompactSummary: null,
  pendingPermissionRequest: null,
  pendingAskUserQuestion: null,
  // P0-2 follow-up: see types.ts ChatSessionSlice.pendingTeamPlanApproval.
  // Initialized null; written by `handleTeamPlanApprovalRequestEvent`,
  // cleared by `respondToTeamPlanApproval` action.
  pendingTeamPlanApproval: null,
  // the IDE `create_plan`-style main-chat plan-approval slot. Written by
  // `handlePlanApprovalRequestEvent`, cleared by `respondToPlanApproval`.
  pendingPlanApproval: null,
  sessionMemoryStatus: {},
  latestTerminationReason: null,

  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  setMessages: (newMessages) => set({ messages: newMessages }),
  setIsTyping: (typing) => set({ isTyping: typing }),
  updateStreamingContent: (messageId, text) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId ? { ...m, content: text } : m,
      ),
    })),
})
