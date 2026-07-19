// ============================================================================
// Memory Types
// ============================================================================

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
export type MemoryScope = 'session' | 'project' | 'user'

export interface MemoryEntryDisplay {
  filename: string
  name: string
  description: string
  type: MemoryType
  scope: MemoryScope
  enabled: boolean
  tags: string[]
  content: string
  updated: string
  ageDays: number
  isStale: boolean
  sourceAgentId?: string
  sourceTaskId?: string
  sourcePath?: string
}

export interface RecalledMemory {
  filename: string
  name: string
  type: MemoryType
  scope: MemoryScope
  score: number
  matchSnippet: string
}

// ============================================================================
// Conversation Types
// ============================================================================

export interface ConversationMeta {
  id: string
  title: string
  workspacePath: string
  createdAt: number
  updatedAt: number
  messageCount: number
  model?: string
  providerId?: string
}

export interface ConversationSearchResult {
  conversationId: string
  conversationTitle: string
  messageId: string
  role: 'user' | 'assistant'
  preview: string
  timestamp: number
}
