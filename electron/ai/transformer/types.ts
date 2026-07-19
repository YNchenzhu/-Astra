/**
 * API 格式转换系统 - 类型定义
 * 支持 Claude、OpenAI Chat、OpenAI2 (Responses API)、Gemini 格式的互转
 */

// ========== Claude 格式 ==========

export interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string | ClaudeContentBlock[]
}

/**
 * PTC caller identifier on `tool_use` blocks. Populated by Anthropic when a
 * tool is invoked from inside the `code_execution_20260120` sandbox.
 *
 * @see https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
 */
export type ClaudePtcCaller =
  | { type: 'direct' }
  | { type: 'code_execution_20260120'; tool_id: string }

/**
 * `code_execution_tool_result.content` shape emitted when PTC finishes a
 * code execution stretch (whether it ran one tool call or many).
 */
export interface CodeExecutionResultPayload {
  type: 'code_execution_result'
  stdout: string
  stderr: string
  return_code: number
  /** Structured blocks (rare; usually empty). */
  content?: unknown[]
}

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
      /** Gemini 3 思考模型在多轮中要求随 functionCall 回传；由 Gemini 响应解析得到 */
      thoughtSignature?: string
      /**
       * Anthropic PTC caller annotation. When `type === 'code_execution_*'`,
       * this tool_use was invoked from inside a code_execution sandbox and
       * our response MUST contain only `tool_result` blocks (no mixed text).
       */
      caller?: ClaudePtcCaller
    }
  | { type: 'tool_result'; tool_use_id: string; content: string | ClaudeContentBlock[] }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } }
  /**
   * PTC "server tool" invocation — the Python code Claude wrote for the
   * sandbox. We store it on the transcript verbatim so the next request
   * can be replayed, and the renderer can surface the generated code to
   * the user for transparency.
   */
  | {
      type: 'server_tool_use'
      id: string
      name: 'code_execution'
      input: { code: string }
    }
  /**
   * PTC completion block — emitted once the code_execution stretch finishes.
   * `tool_use_id` matches the `server_tool_use.id` that kicked off the run.
   */
  | {
      type: 'code_execution_tool_result'
      tool_use_id: string
      content: CodeExecutionResultPayload
    }

export interface ClaudeTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface ClaudeRequest {
  model: string
  max_tokens?: number
  system?: string | ClaudeContentBlock[]
  messages: ClaudeMessage[]
  tools?: ClaudeTool[]
  tool_choice?: 'auto' | 'any' | { type: 'tool'; name: string }
  temperature?: number
  top_p?: number
  stream?: boolean
}

export interface ClaudeResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: ClaudeContentBlock[]
  model: string
  stop_reason: string
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

// ========== OpenAI Chat 格式 ==========

/** Vision/multimodal content part (OpenAI "image_url" / "text" variant). */
export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** string for plain chat, `OpenAIContentPart[]` for vision-capable models, null for tool-only turns. */
  content: string | null | OpenAIContentPart[]
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string // JSON 字符串
  }
}

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface OpenAIRequest {
  model: string
  max_completion_tokens?: number
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  tool_choice?: 'auto' | 'required' | { type: 'function'; function: { name: string } }
  temperature?: number
  top_p?: number
  stream?: boolean
  stream_options?: { include_usage: boolean }
}

export interface OpenAIResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: OpenAIMessage
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// ========== OpenAI2 (Responses API) 格式 ==========

/** Responses API content item (text + image variants). */
export type OpenAI2ContentItem =
  | { type: 'input_text' | 'output_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'low' | 'high' | 'auto' }

export interface OpenAI2InputItem {
  type: 'message' | 'tool_use' | 'tool_result'
  role?: 'user' | 'assistant'
  content?: OpenAI2ContentItem[]
  call_id?: string
  name?: string
  input?: Record<string, unknown>
  output?: string
}

export interface OpenAI2Tool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface OpenAI2Request {
  model: string
  max_output_tokens?: number
  instructions?: string
  input: OpenAI2InputItem[]
  tools?: OpenAI2Tool[]
  tool_choice?: 'auto' | 'required' | { type: 'tool'; name: string }
  temperature?: number
  top_p?: number
  stream?: boolean
  /**
   * F1 (2026-06) — stateless reasoning passthrough. `store: false` keeps the
   * Responses API from persisting the conversation server-side;
   * `include: ["reasoning.encrypted_content"]` asks it to return reasoning
   * items with an opaque encrypted payload we can replay on the next request
   * (OpenAI requires reasoning items to ride along with function_call_output
   * in tool loops, otherwise reasoning models lose their in-turn state).
   */
  store?: boolean
  include?: string[]
}

/**
 * Opaque reasoning payload captured from a Responses API stream and replayed
 * on subsequent requests. Travels on the Claude-shaped `tool_use` block as
 * `openai2Reasoning` — same precedent as Gemini's `thoughtSignature`.
 */
export interface OpenAI2ReasoningPayload {
  id?: string
  encrypted_content: string
}

export interface OpenAI2Response {
  id: string
  type: 'message'
  role: 'assistant'
  input: OpenAI2InputItem[]
  output: OpenAI2InputItem[]
  model: string
  stop_reason: string
  usage?: {
    input_tokens: number
    output_tokens: number
  }
}

// ========== Gemini 格式 ==========

export interface GeminiPart {
  text?: string
  /**
   * Gemini 3 思考模型：thought 签名在 **Part** 层，与 functionCall 同级（非嵌在 functionCall 内）。
   * @see https://ai.google.dev/gemini-api/docs/thought-signatures
   */
  thoughtSignature?: string
  thought_signature?: string
  inlineData?: {
    mimeType: string
    data: string
  }
  functionCall?: {
    name: string
    args: Record<string, unknown>
  }
  functionResponse?: {
    name: string
    response: Record<string, unknown>
  }
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiFunctionDeclaration {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface GeminiRequest {
  model: string
  generationConfig?: {
    maxOutputTokens?: number
    temperature?: number
    topP?: number
    /** 与 yunwu / 官方「思考」流式示例一致，见 thinkingConfig */
    thinkingConfig?: {
      includeThoughts?: boolean
      thinkingBudget?: number
    }
  }
  systemInstruction?: {
    parts: Array<{ text: string }>
  }
  contents: GeminiContent[]
  tools?: Array<{
    functionDeclarations: GeminiFunctionDeclaration[]
  }>
  stream?: boolean
}

export interface GeminiResponse {
  candidates: Array<{
    content: GeminiContent
    finishReason: string
    index: number
  }>
  usageMetadata?: {
    promptTokenCount: number
    candidatesTokenCount: number
    totalTokenCount: number
  }
}

// ========== 转换上下文 ==========

/**
 * Pending tool-call descriptor held while waiting for the gateway to return
 * a matching tool response. Queues are keyed by tool name because Gemini's
 * `functionResponse` payload only carries `name` (no call id), so we have to
 * FIFO-match responses back to calls by insertion order.
 *
 * Each entry records:
 *   - `id`: the Claude-side `tool_use.id` the model generated
 *   - `ordinal`: strictly increasing counter within a single turn
 */
export interface PendingToolCallEntry {
  id: string
  ordinal: number
}

export interface TransformContext {
  // `tool_use.id` → tool name, for stream-time lookup when assembling events.
  toolUseIDToName: Map<string, string>

  /**
   * Per-tool-name FIFO queue of unresolved calls. Populated when we serialize
   * a Claude `tool_use` onto the wire; consumed when we receive a matching
   * `tool_result` / `functionResponse` and need its tool_use_id back.
   *
   * Unlike a flat `Map<string, string>` (the previous shape), this queue
   * survives same-tool-name being called twice in one turn — e.g. two
   * consecutive `Read` calls — without the second call's id overwriting the
   * first. See upstream compat report §R3.
   */
  pendingToolCallsByName: Map<string, PendingToolCallEntry[]>

  /** Monotonic counter; used by the queue to stamp ordinals. */
  toolCallOrdinal: number

  // 用于流式响应的状态
  inThinkingTag: boolean
  thinkingBuffer: string

  // 用于 Token 估算
  estimatedInputTokens: number
  estimatedOutputTokens: number

  /**
   * F1 (2026-06) — when true, `claudeToOpenAI2` adds `store:false` +
   * `include:["reasoning.encrypted_content"]` to the request and replays
   * stored `openai2Reasoning` payloads from tool_use blocks back into the
   * `input` array. Set by `compatibleClient` after consulting the env kill
   * switch (`POLE_OPENAI2_REASONING`) and the per-baseUrl 400-fallback latch.
   */
  openai2ReasoningEnabled?: boolean
}

// ========== 转换结果 ==========

export interface TransformResult<T> {
  success: boolean
  data?: T
  error?: string
}
