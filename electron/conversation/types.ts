/**
 * Conversation persistence type definitions.
 * Stores full chat history per workspace as JSON files.
 */

// Re-export branded types for use by callers
export type { AgentId, SessionId } from '../tools/ids'
export { asAgentId, asSessionId } from '../tools/ids'

/** Lightweight metadata for listing conversations without loading full messages */
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

/** Serializable todo item persisted with conversation */
export interface ConversationTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

/** Full conversation data persisted to disk */
export interface ConversationData {
  meta: ConversationMeta
  messages: ConversationMessage[]
  todos?: ConversationTodoItem[]
}

/**
 * Serializable message format.
 * Mirrors the renderer's ChatMessage but strips transient fields
 * like isStreaming / isThinking.
 */
export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  thinking?: string
  blocks?: ConversationContentBlock[]
  toolUses?: ConversationToolUse[]
  subAgents?: ConversationSubAgent[]
  codeBlocks?: { language: string; code: string; fileName?: string }[]
  referencedFiles?: string[]
  /**
   * Optional discriminator for UI-only system artifacts (currently only
   * 'compact_boundary' — a host-inserted dim divider rendered when
   * context compaction ran). Filtered out before API conversion by
   * `apiMessageBuilder` and `contextBuilder`. Schema-documented here so
   * downstream consumers / migrations don't trip over a serialized
   * boundary row whose role is 'assistant' but content is empty.
   */
  kind?: 'compact_boundary'
  /** Populated alongside `kind === 'compact_boundary'`. */
  compactBoundary?: {
    level: string
    preTokens?: number
    postTokens?: number
    reclaimedTokens?: number
  }
}

/**
 * On-disk content block shape.
 *
 * NOTE: At runtime Electron IPC serialises the **full** renderer-side
 * `ContentBlock` (`src/types/tool.ts`) verbatim into the JSON — extra
 * fields the type here doesn't enumerate still hit disk. This file is
 * the SCHEMA DOCUMENTATION end: it should track what the renderer
 * actually writes so future consumers / migrations / external tooling
 * can rely on the type rather than spelunking through `ChatMessage`.
 *
 * Keep in sync with `ContentBlock` in `src/types/tool.ts`. The renderer
 * union is the source of truth for what's emitted; this one
 * narrows-down to JSON-safe fields (no streaming flags survive — the
 * persist transforms in `src/stores/chat/conversationPersistence.ts`
 * strip them).
 */
export type ConversationContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'thinking'
      text: string
      /**
       * Anthropic-Messages-style cryptographic signature over the block
       * text. Round-tripped to the model on subsequent requests when
       * extended thinking is active AND the same assistant turn carries
       * a `tool_use` — otherwise DeepSeek's Anthropic-compat / Anthropic
       * native return HTTP 400. Absent on:
       *   - non-thinking providers (Chat Completions, Gemini)
       *   - blocks that were compacted on save (truncation invalidates
       *     the signature, so the persist pass drops it — see
       *     `compactedAt` below).
       */
      signature?: string
      /**
       * Wall-clock duration the provider's `thinking` content block was
       * open. Stamped on stream close (`anthropicCompatHttp.ts#
       * consumeAnthropicStream`); the renderer persists it so a
       * reopened conversation still surfaces the original elapsed time
       * even after the in-memory tick state is gone.
       */
      thinkingTimeMs?: number
      /**
       * Approximate output-token cost of the block. Sourced from a
       * length-based heuristic (`estimateThinkingTokens` in
       * `anthropicCompatHttp.ts`) rather than a wire field — provider
       * APIs lump thinking tokens into aggregate `output_tokens` and
       * don't break them out per block.
       */
      thinkingTokens?: number
      /**
       * Timestamp (ms) at which this block's text was truncated by the
       * save-time compaction pass (settings flag
       * `compactThinkingOnSave`). When non-null, `text` is a short
       * preview prefix + elided-count suffix; `signature` is dropped
       * since truncation invalidates it. UI renders a "(truncated)"
       * pill in the meta strip.
       */
      compactedAt?: number
    }
  | {
      /**
       * Provider-emitted safe-to-show TL;DR of the chain of thought
       * (currently only OpenAI Responses API). Distinct from `thinking`
       * — summaries don't carry signatures, aren't echoed back to the
       * model, and aren't subject to the save-time compaction pass
       * (they're short by API contract).
       */
      type: 'reasoning_summary'
      text: string
      thinkingTimeMs?: number
      thinkingTokens?: number
    }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; status: 'running' | 'completed' | 'error'; result?: string; error?: string }

export interface ConversationToolUse {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'running' | 'completed' | 'error'
  result?: string
  error?: string
}

/**
 * On-disk shape of a sub-agent run. Like {@link ConversationContentBlock}
 * this enumerates the JSON-safe subset of `SubAgentDisplay`
 * (`src/types/tool.ts`); renderer writes through Electron's verbatim
 * serialisation, so any field added on the renderer side flows here.
 *
 * `thinking` / `reasoningSummary` are flat strings rather than block
 * arrays — sub-agents use a flat-text model (rendered by `AgentBlock`
 * via the standalone `<ThinkingBlock>` / `<ReasoningSummaryBlock>`).
 * The streaming-state flags from the renderer (`isThinking`, etc.) are
 * intentionally NOT persisted; they're transient.
 */
export interface ConversationSubAgent {
  agentId: string
  agentType: string
  description: string
  name?: string
  status: 'running' | 'completed' | 'failed'
  output?: string
  toolUses: ConversationToolUse[]
  totalDurationMs?: number
  totalTokens?: number
  /**
   * Raw chain-of-thought from the sub-agent's most recent thinking
   * block. UI-only — `SubAgentResult.output` is what gets fed back to
   * the parent model, never this.
   */
  thinking?: string
  /** Wall-clock duration of the most recent thinking block. */
  thinkingTimeMs?: number
  /** Approximate output-token cost of the most recent thinking block. */
  thinkingTokens?: number
  /**
   * Provider-emitted reasoning summary (OpenAI Responses) for this
   * sub-agent run. Independent of {@link thinking}; rendered as a
   * separate row inside the AgentBlock chrome.
   */
  reasoningSummary?: string
  reasoningSummaryTimeMs?: number
  reasoningSummaryTokens?: number
}

/** Search result returned when searching across conversations */
export interface ConversationSearchResult {
  conversationId: string
  conversationTitle: string
  messageId: string
  role: 'user' | 'assistant'
  preview: string
  timestamp: number
}

/** Parameters received from renderer for saving a conversation */
export interface SaveConversationParams {
  id: string
  messages: ConversationMessage[]
  workspacePath: string
  model?: string
  providerId?: string
  todos?: ConversationTodoItem[]
  /** Bundle that owns this conversation (plan §4.5.4). Defaults to
   *  'code-dev' when omitted, which matches the pre-bundle storage
   *  location so legacy data stays discoverable without migration. */
  bundleId?: string
}
