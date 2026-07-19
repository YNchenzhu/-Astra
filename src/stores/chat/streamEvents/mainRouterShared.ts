/**
 * Shared context + helpers for the main-chat stream-event handlers split out
 * of `mainStreamRouter.ts`. The router builds one {@link MainRouterContext}
 * per event and forwards the larger case bodies to dedicated handler modules.
 */
import type { StreamEvent } from '../../../types'
import { chatStoreApi } from '../storeApiRef'
import { persistBufferedConversation as _persistBufferedConversationDI } from '../conversationPersistence'
import type { ChatSessionSlice, ChatState } from '../types'

export interface MainRouterContext {
  event: StreamEvent
  convId: string
  assistantId: string | undefined
  st0: ChatState
  apply: (
    fn: (sl: ChatSessionSlice) => ChatSessionSlice,
    extra?: Partial<ChatState>,
  ) => void
  api: ReturnType<typeof chatStoreApi>
}

export function persistBufferedConversation(convId: string): Promise<void> {
  const api = chatStoreApi()
  return _persistBufferedConversationDI(api.getState, api.setState, convId)
}

/**
 * Extension → Monaco language id mapping for AI-opened diff tabs.
 * Kept as a module-local constant to avoid reimporting the full
 * `diffPreviewBridge` just for the lookup.
 */
export const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', json: 'json',
  css: 'css', html: 'html', md: 'markdown', yaml: 'yaml', yml: 'yaml',
  sh: 'shell', sql: 'sql', xml: 'xml',
}
