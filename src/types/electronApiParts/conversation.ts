import type { ConversationMeta, ConversationSearchResult } from '../tool'
import type { ConversationDataCompact } from '../workspaceModels'

export interface ElectronConversationApi {
  /** All methods accept an optional trailing `bundleId` (plan §4.5.4);
   *  undefined maps to the 'code-dev' partition whose on-disk location
   *  is the pre-bundle bucket, keeping legacy conversations readable. */
  save: (params: { id: string; messages: Array<{ role: string; content: string }>; workspacePath: string; model?: string; providerId?: string; todos?: Array<{ id: string; content: string; status: string }>; bundleId?: string }) => Promise<ConversationMeta>
  load: (convId: string, workspacePath: string, bundleId?: string) => Promise<ConversationDataCompact | null>
  list: (workspacePath: string, bundleId?: string) => Promise<ConversationMeta[]>
  rename: (convId: string, workspacePath: string, newTitle: string, bundleId?: string) => Promise<{ success: boolean }>
  delete: (convId: string, workspacePath: string, bundleId?: string) => Promise<{ success: boolean }>
  search: (query: string, workspacePath?: string, bundleId?: string) => Promise<ConversationSearchResult[]>
  autoTitle: (convId: string, workspacePath: string, bundleId?: string) => Promise<string>
  setOrder: (workspacePath: string, orderedIds: string[], bundleId?: string) => Promise<{ success: boolean }>
  /**
   * §10.4 — 复位指定会话的 thinking-clear latch（保留 lastSuccess）。
   * 在 startNewConversation / clearConversationContext 后 fire-and-forget。
   * 旧版本 main 没注册此 handler 时调用方拿不到响应，必须用可选链安全降级。
   */
  resetThinkingClearLatch?: (
    conversationId: string,
  ) => Promise<{ success: boolean }>
}
