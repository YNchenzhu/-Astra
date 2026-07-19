/**
 * Shared seed / assertion helpers for the `handleMainStreamEvent` spec family.
 *
 * These were inlined at the top of the original monolithic
 * `handleMainStreamEvent.test.ts`. They depend on the (mocked) chat store, so
 * importing them from a spec only works AFTER that spec has registered its
 * `vi.mock(...)` calls — which is always the case since `vi.mock` is hoisted
 * above all imports.
 */
import type { ChatMessage, StreamEvent, ToolUseDisplay } from '../../types'
import type { ContentBlock } from '../../types/tool'
import { useChatStore } from './storeCompose'
import { pendingAssistantByConversation } from './sessionSlice'
import { flushPendingDeltasNow } from './streamingDeltaBatcher'
import { flushPendingToolInputsNow } from './toolInputDeltaBatcher'

export type { StreamEvent }

export const CONV_ID = 'conv-test'
export const ASSISTANT_ID = 'msg-assistant-1'
export const TOOL_USE_ID = 'tool-xyz'

export function seedAssistantWithToolUse(
  toolStatus: ContentBlock & { type: 'tool_use' } extends { status: infer S } ? S : never = 'running',
): ChatMessage {
  const toolUse: ToolUseDisplay = {
    id: TOOL_USE_ID,
    name: 'Bash',
    input: { command: 'ls' },
    status: toolStatus,
  }
  const block: ContentBlock = {
    type: 'tool_use',
    id: TOOL_USE_ID,
    name: 'Bash',
    input: { command: 'ls' },
    status: toolStatus,
  }
  return {
    id: ASSISTANT_ID,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    isStreaming: true,
    blocks: [block],
    toolUses: [toolUse],
  }
}

export function installAssistant(convId = CONV_ID, assistantId = ASSISTANT_ID): void {
  const message = seedAssistantWithToolUse()
  useChatStore.setState({
    currentConversationId: convId,
    messages: [message],
    sessionBuffers: {
      [convId]: {
        messages: [message],
        todos: [],
        isTyping: true,
        pendingPermissionRequest: null,
        pendingAskUserQuestion: null,
        pendingTeamPlanApproval: null,
        pendingPlanApproval: null,
      },
    },
  })
  pendingAssistantByConversation.set(convId, assistantId)
}

export function getFirstToolBlock(): (ContentBlock & { type: 'tool_use' }) | null {
  const msg = useChatStore.getState().messages[0]
  const b = msg?.blocks?.[0]
  if (b && b.type === 'tool_use') return b
  return null
}

export function getFirstToolUse(): ToolUseDisplay | null {
  return useChatStore.getState().messages[0]?.toolUses?.[0] ?? null
}

/**
 * Seed a blank assistant row (no content, no blocks) for streaming. The
 * tool-use seed from `installAssistant` is unrelated to text streaming and
 * clutters assertions, so streaming tests use a fresh minimal row.
 */
export function installBlankStreamingAssistant(): void {
  const message: ChatMessage = {
    id: ASSISTANT_ID,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    isStreaming: true,
    blocks: [],
    toolUses: [],
  }
  useChatStore.setState({
    currentConversationId: CONV_ID,
    messages: [message],
    sessionBuffers: {
      [CONV_ID]: {
        messages: [message],
        todos: [],
        isTyping: true,
        pendingPermissionRequest: null,
        pendingAskUserQuestion: null,
        pendingTeamPlanApproval: null,
        pendingPlanApproval: null,
      },
    },
  })
  pendingAssistantByConversation.set(CONV_ID, ASSISTANT_ID)
}

export function currentAssistantMessage(): ChatMessage | null {
  return useChatStore.getState().messages[0] ?? null
}

/** Full reset used by `beforeEach` — clears pending map, drains the batcher, resets store. */
export function resetChatStoreState(): void {
  pendingAssistantByConversation.clear()
  flushPendingDeltasNow()
  flushPendingToolInputsNow()
  useChatStore.setState({
    currentConversationId: null,
    messages: [],
    sessionBuffers: {},
    isTyping: false,
    recalledMemories: [],
    recalledWorkspaceHits: [],
    recalledAttachmentHits: [],
  })
}

/** Lighter cleanup used by `afterEach` — clears pending map and drains the batcher. */
export function flushAndClearPending(): void {
  pendingAssistantByConversation.clear()
  flushPendingDeltasNow()
  flushPendingToolInputsNow()
}
