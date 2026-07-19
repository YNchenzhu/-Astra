import type { ConversationMeta } from './tool'

export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'folder'
  children?: FileTreeNode[]
  language?: string
}

export interface SearchResultItem {
  file: string
  path: string
  matches: { line: number; text: string }[]
}

export interface ToolDefinitionCompact {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface SessionSnapshot {
  tasks: Array<{ name: string; status: string }>
  files: Array<{ path: string; action: string }>
  errors: Array<{ message: string; file?: string }>
  worklog: string[]
  decisions: Array<{ summary: string }>
  learnings: string[]
  userGoals: string[]
  lastUpdated: string
  state: string
}

export interface ContextStateCompact {
  estimatedTokens: number
  level: string
  compactCount: number
  consecutiveCompactFailures: number
  lastCompactSummary?: string
  usagePercentOfWindow?: number
  breakdown?: ContextBreakdownCompact
}

export interface ContextBreakdownCategoryCompact {
  id: string
  label: string
  tokens: number
  percentOfTotal: number
}

export interface ContextBreakdownCompact {
  totalTokens: number
  heuristicTokens: number
  generatedAt: number
  accuracy: 'heuristic' | 'anchored'
  cache?: ContextBreakdownCacheCompact
  categories: ContextBreakdownCategoryCompact[]
}

export interface ContextBreakdownCacheCompact {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  cacheHitRate: number
}

export interface ContextThresholdsCompact {
  warningTokens: number
  errorTokens: number
  /** History-snip tier (upstream §9.1 layer 1). Optional for backward compat with
   *  saved settings written before this field existed — main process derives
   *  a midpoint when missing or invariant-broken. */
  historySnipTokens?: number
  microCompactTokens: number
  autoCompactTokens: number
  blockingTokens: number
  anchorBudgetChars: number
}

export interface ContextAnalysisCategory {
  name: string
  tokens: number
  percent: number
  color: string
}

export interface ContextAnalysisSuggestion {
  type: 'info' | 'warning' | 'error'
  message: string
}

export interface ContextAnalysisResult {
  model: string
  contextWindowTokens: number
  effectiveWindowTokens: number
  totalUsedTokens: number
  usagePercent: number
  categories: ContextAnalysisCategory[]
  grid: string[][]
  suggestions: ContextAnalysisSuggestion[]
}

export interface PromptDiagnosticsRecordCompact {
  requestId: string
  conversationId?: string
  agentId?: string
  providerId: string
  model: string
  iteration: number
  status: 'running' | 'success' | 'error'
  payload: {
    systemPromptTokens: number
    systemContextTokens: number
    userContextTokens: number
    userMetaTokens: number
    toolSchemaTokens: number
    messageTokens: number
    messageCount: number
    hashes: Record<string, string | undefined>
    cacheControl: { systemContext: boolean; messageLevel: boolean }
  }
  thinking: {
    effort?: string
    alwaysThinking: boolean
    thinkingBudgetTokens?: number
  }
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
    totalInputWithCache: number
  }
  timing: {
    startedAt: number
    firstResponseAt?: number
    endedAt?: number
    ttfbMs?: number
    totalMs?: number
  }
  diagnosis: string[]
  error?: string
}

export interface ConversationDataCompact {
  meta: ConversationMeta
  messages: Array<{ role: string; content: string; id?: string; timestamp?: number }>
  todos?: Array<{ id: string; content: string; status: string }>
}

export type WorkspaceIndexStatusResult = {
  indexed: boolean
  namespace: string
  filesScanned: number
  filesIndexed: number
  chunkCount: number
  bytesSource: number
  model: string
  dim: number
  builtAt: number
  durationMs: number
  errors: Array<{ file: string; error: string }>
}

/** Mirrors electron/attachments/types.ts#IngestedAttachment. */
export type IngestedAttachmentResult =
  | {
      type: 'image'
      name: string
      base64: string
      mediaType: string
      size: number
      sha256: string
    }
  | {
      type: 'file'
      name: string
      path: string
      size: number
      kind: string
      mimeType: string
      sha256: string
      status: 'ready' | 'error'
      error?: string
      pdf?: { base64: string; pageCount?: number }
      text?: { content: string; truncated: boolean; originalChars: number }
      pageImages?: Array<{ page: number; base64: string; mediaType: 'image/jpeg' }>
      sheets?: Array<{ name: string; rowCount: number; colCount: number }>
      inlineImages?: Array<{ base64: string; mediaType: string; altText?: string }>
      /** ingest 过程的非致命警告(poppler 缺失、行列截断等)。 */
      notes?: string[]
    }
