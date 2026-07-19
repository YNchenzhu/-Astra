/**
 * Multi-provider AI client.
 * Adapted from upstream's services/api/client.ts pattern:
 *   - Anthropic direct / AWS Bedrock / GCP Vertex / Azure Foundry via @anthropic-ai/sdk variants
 *   - OpenAI via `openai` SDK
 *   - Google Gemini via `@google/generative-ai` SDK
 *
 * All providers expose a unified `streamText()` interface that yields text deltas.
 */

import {
  PROVIDER_ENTRIES,
  PROVIDER_ENTRY_BY_ID,
} from '../../src/data/providerRegistry'
import { normalizeApiKeyInput } from './diskCredentials'
import {
  adjustMaxTokensForEffort,
  type SkillEffort,
} from '../skills/skillEffort'
import type { AnthropicMessagePromptCacheOptions } from './anthropicMessagePromptCache'
import type { SystemPromptLayers } from './systemPrompt'
import { streamAnthropic } from './providers/anthropic'
import { streamGemini } from './providers/gemini'
import { streamOpenAI } from './providers/openai'
import { streamAnthropicCompatHttp } from './anthropicCompatHttp'
import { getProviderQuirks } from './providerQuirks'
import {
  classifyProviderError,
  emitProviderErrorTelemetryEvent,
} from '../telemetry/contextEvents'
import { getAgentContext } from '../agents/agentContext'

// ========== Provider Types ==========

import type { ProviderId } from '../../src/data/providerRegistry'
import type { AnthropicThinkingCapability } from '../../src/types/providerCapabilities'
/** Re-export so downstream consumers do not need to change imports. */
export type { ProviderId } from '../../src/data/providerRegistry'

export interface ProviderConfig {
  id: ProviderId
  name: string
  apiKey: string
  baseUrl?: string
  /** When true and baseUrl is set, route through compatible HTTP client (see `compatibleClient`) */
  autoDetectFormat?: boolean
  /** Custom Anthropic gateways: whether the endpoint accepts `thinking` request blocks. */
  anthropicThinkingCapability?: AnthropicThinkingCapability
  /** Anthropic-specific: model overrides per provider variant */
  awsRegion?: string
  projectId?: string
}

/** Params for `streamText` / `streamCompatibleFormat` */
export type StreamTextParams = {
  model: string
  messages: { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }[]
  systemPrompt?: string
  /**
   * AC-6.3 / §7.2 — when {@link mergeSystemPromptLayers} is used upstream, pass layers so native Anthropic
   * can emit multi-block `system` (default since Stage 1; opt-out via `POLE_ANTHROPIC_SYSTEM_BLOCKS_DISABLE=1`).
   */
  systemPromptLayers?: SystemPromptLayers
  /** §9.1 Anthropic message-level prompt cache (env `POLE_ANTHROPIC_MESSAGE_CACHE_CONTROL=1`). */
  anthropicMessagePromptCache?: AnthropicMessagePromptCacheOptions
  maxTokens?: number
  effort?: SkillEffort
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
  /** Optional forced tool-choice for structured side-queries / schema extraction. */
  toolChoice?: 'auto' | 'any' | { type: 'tool'; name: string }
  apiMessages?: Array<Record<string, unknown>>
  alwaysThinking?: boolean
  /** §7.5 — Gemini `thinkingConfig` / compatible Claude `thinking.budget_tokens` when supported. */
  thinkingBudgetTokens?: number
  /**
   * Native **OpenAI Chat** (`streamOpenAI`) only: these tools are sent with `function.strict: true`
   * and a JSON Schema subset that satisfies structured function calling when the model supports it.
   * Anthropic / Gemini / compatible gateways ignore this field.
   */
  openAiStrictToolNames?: string[]
  /**
   * Extra attempts on retryable HTTP / connection failures (§12.1) for native SDK paths.
   * Default: 2 extra (3 total), or 10 extra when `CLAUDE_CODE_UNATTENDED_RETRY` is set.
   * Set `0` to disable. Each retry resends the same payload; providers may still charge.
   */
  streamRetries?: number
  /**
   * When the API signals prompt/context too large, set `ref.value = true` and omit `onError`
   * so {@link runAgenticLoop} can compact and retry once.
   */
  contextLengthExceededRef?: { value: boolean }
  /** §12.4 — Anthropic `anthropic-beta: fast-mode-…` when enabled in settings. */
  anthropicFastMode?: boolean
  /**
   * §12.5 — after three consecutive HTTP 529 on a non-custom Opus model, set ref to this model id
   * and return without `onError` so the agentic loop can retry the turn.
   */
  anthropicOverloadFallbackModel?: string
  anthropicOverloadFallbackModelRef?: { value: string | null }
  /** §12.3 — optional pulse during long unattended backoff waits */
  onStreamRetryKeepAlive?: () => void
  /** Sampling temperature (0–2). Passes through to provider request. */
  temperature?: number
  /** Nucleus sampling top-p (0–1). Passes through to provider request. */
  topP?: number
}

export interface ModelOption {
  id: string
  name: string
  providerId: ProviderId
}

/** 流式一轮结束时的用量（Anthropic 可带 prompt cache 分项）。 */
export type StreamMessageUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  /** Anthropic `stop_reason` or OpenAI `finish_reason` when available (e.g. `max_tokens`, `length`). */
  stopReason?: string
}

/**
 * Anthropic Programmatic Tool Calling (PTC) caller annotation that may
 * accompany a `tool_use` block. Populated by the API when the tool was
 * invoked from inside the `code_execution_20260120` sandbox rather than a
 * direct model round-trip.
 *
 * When `type !== 'direct'`, downstream response-shape guards (see
 * {@link runAgenticToolUseBatch}) MUST ensure the user reply contains
 * only `tool_result` blocks — Anthropic's wire rejects mixed text content.
 */
export type PtcToolUseCaller =
  | { type: 'direct' }
  | { type: 'code_execution_20260120'; tool_id: string }

export interface StreamCallbacks {
  onTextDelta: (text: string) => void
  onMessageEnd: (usage?: StreamMessageUsage) => void
  onError: (error: string) => void
  /**
   * Phase 2 (upstream alignment) — structured-signal channel that runs in
   * parallel with the legacy stringified {@link onError}. Each provider
   * catch block classifies the raw error into a typed
   * {@link import('./loopSignal').LoopSignal} envelope and delivers it
   * here BEFORE the message is stringified for {@link onError}. The
   * envelope carries `kind` / `status` / `retryAfterMs` / `provider` so
   * downstream loop decision points can branch on typed fields instead
   * of running regex over the rendered error text (which was the
   * "regex guard" problem in `streamErrorClassification.ts` and
   * `contextLengthError.ts`).
   *
   * Optional and additive: existing consumers that don't wire this
   * field continue to work unchanged through `onError`. Phase 3 will
   * switch the agentic loop's stream phase to consume `LoopSignal`
   * instead of withholding the error string.
   */
  onLoopSignal?: (signal: import('./loopSignal').LoopSignal) => void
  /** Fired when the model requests a tool call */
  onToolUse?: (toolUse: {
    id: string
    name: string
    input: Record<string, unknown>
    /** Gemini 2.5+ 思考链路必填，必须在下一轮请求的 model 轮 functionCall 上回传 */
    thoughtSignature?: string
    /** F1 — OpenAI Responses API 加密 reasoning 负载，需在下一轮请求中回放（见 claudeToOpenAI2）。 */
    openai2Reasoning?: { id?: string; encrypted_content: string }
    /** Anthropic PTC: present when this call originated from the code_execution sandbox. */
    caller?: PtcToolUseCaller
    /**
     * Stream-time pre-baked rejection error (C-grade watcher path). Set only
     * by the synthetic tool_use the watcher emits when it has decided a
     * write_file call must be aborted BEFORE the model finishes streaming
     * its arguments — both the "content streamed before filePath" and the
     * "existing file" branches
     * (see {@link import('./streamWriteInputWatcher').StreamWriteInputWatcher}).
     *
     * When present, `streamingToolExecutor.addTool` MUST surface this error
     * as the tool_result directly and skip the disk-based preflight gate —
     * the watcher already decided on the verdict and B-grade's
     * `preflightWriteTool` would fail-open on the empty `input.filePath` we
     * deliberately leave behind for this case. `runAgenticToolUseBody`
     * does the same for the batch / orchestrated paths (which otherwise
     * Zod-validate the intentionally partial input and emit a misleading
     * "missing/empty required argument" error).
     */
    preflightError?: string
  }) => void
  /**
   * Fires while a `tool_use` content block is still streaming its JSON
   * arguments (Anthropic-compat `input_json_delta`). `partialJson` is the
   * **accumulated** buffer for this tool_use, not the per-event delta —
   * carrying it lets renderers do tolerant partial-JSON extraction without
   * re-stitching from scratch. The renderer can pull in-progress field
   * values (e.g. `content`, `newString`) to drive a "live writing" card
   * UI, analogous to the IDE's streaming diff view.
   *
   * Optional: providers that don't emit input deltas (eager `input` in
   * `content_block_start`) never fire this. Wired today only for the
   * anthropic-compat HTTP path — native SDK + Gemini + OpenAI paths can
   * follow in subsequent passes.
   */
  onToolInputDelta?: (delta: {
    toolUseId: string
    toolName: string
    partialJson: string
  }) => void
  /** Fired when the model produces thinking content (extended thinking) */
  onThinkingDelta?: (text: string) => void
  /** Optional hooks used by compatible streaming adapters */
  onThinkingStart?: () => void
  onThinkingComplete?: () => void
  /**
   * Fired once a complete `thinking` content block has been received
   * (deltas accumulated, signature attached if any). The agentic loop
   * captures these so they can be echoed back into the next request's
   * `messages[].content`. Required by:
   *   - DeepSeek Anthropic-compat: 400 "content[].thinking in the
   *     thinking mode must be passed back" if a prior assistant message
   *     omits a thinking block that was originally returned.
   *   - Official Anthropic when extended thinking + tool_use are mixed
   *     in the same turn: thinking blocks (with their `signature`) must
   *     be replayed verbatim on subsequent calls.
   */
  onThinkingBlock?: (block: { thinking: string; signature?: string; thinkingTimeMs?: number; thinkingTokens?: number }) => void
  /**
   * Plan Phase 4 — Anthropic `redacted_thinking` 块流式回调。
   *
   * 当服务端启用 `REDACT_THINKING` beta（plan §10.4），Anthropic 返回的
   * `content_block` 类型是 `redacted_thinking` 而非 `thinking`：
   *   - 内容是加密 blob（无 model-visible 文本）
   *   - 没有 `thinking_delta`，整块一次性到位（通常在 content_block_start
   *     就有完整 `data`）
   *   - 没有 `signature` 字段
   *
   * 收益：用户隐私 + "主模型读不到自己的旧推理"防幻觉链路。
   *
   * 调用方应该把 `data` 原样存进 assistant 消息的 blocks 数组，下一轮
   * `chatMessageToAgentApiRows` 会把它回灌给 API（如果不回灌，服务端会
   * 因 trajectory 不连续而拒签）。
   *
   * Optional: providers without REDACT 支持（OpenAI / Gemini / 其他 3P）
   * 永远不会触发。
   */
  onRedactedThinkingBlock?: (block: { data: string; startedAtMs?: number }) => void
  /**
   * Reasoning summary stream — provider-emitted TL;DR of the chain of
   * thought (currently sourced from OpenAI Responses API's
   * `response.reasoning_summary_text.*` events; mapped by the
   * `claudeToOpenAI2.ts` transformer to a pseudo-Claude SSE delta type
   * `reasoning_summary_delta`).
   *
   * Distinct from `onThinkingDelta` because summaries are short, safe to
   * show without raw chain-of-thought (OpenAI o-series raw thinking is
   * restricted by ToS), and carry NO signature — they don't round-trip
   * to the next turn. The renderer surfaces them as a separate
   * collapsible block (`reasoning_summary`), NOT merged into the regular
   * `thinking` row.
   *
   * Optional: providers without a summary channel (Anthropic native,
   * Chat Completions paths, DeepSeek) simply never fire these.
   */
  onReasoningSummaryDelta?: (text: string) => void
  onReasoningSummaryBlock?: (block: { text: string; thinkingTimeMs?: number; thinkingTokens?: number }) => void
  /**
   * §11.4 — Anthropic HTTP 529 (overloaded): invoked immediately before a non-streaming fallback
   * request; callers should discard partial stream state (e.g. tool batch) and tombstone UI.
   */
  onStreamingFallback?: (info: { status: number; reason: string }) => void
  /**
   * Anthropic PTC: fired when the model emits a `server_tool_use` block
   * containing the Python code it wants the sandbox to execute. Callers
   * typically surface this to the renderer (UI shows generated code) and
   * append the block verbatim to the assistant transcript for replay on
   * the next request.
   */
  onServerToolUse?: (block: {
    id: string
    name: 'code_execution'
    input: { code: string }
  }) => void
  /**
   * Anthropic PTC: fired when a `code_execution_tool_result` block closes a
   * sandbox execution (whether it called 0 or N tools). `toolUseId` matches
   * the originating `server_tool_use.id`.
   */
  onCodeExecutionResult?: (result: {
    toolUseId: string
    stdout: string
    stderr: string
    returnCode: number
  }) => void
}

export interface ToolUseBlock {
  id: string
  name: string
  input: Record<string, unknown>
  thoughtSignature?: string
  /** F1 — OpenAI Responses API 加密 reasoning 负载（回放用，见 claudeToOpenAI2）。 */
  openai2Reasoning?: { id?: string; encrypted_content: string }
  caller?: PtcToolUseCaller
  /**
   * Stream-time pre-baked rejection error. Mirrors the field on
   * {@link StreamCallbacks.onToolUse}'s argument; see that doc for usage.
   * Always undefined on tool_use blocks that came through normal model
   * streaming — only set by the C-grade watcher's synthetic rejection
   * path.
   */
  preflightError?: string
}

// Anthropic fast-mode process-lifetime state has moved to
// `./providers/anthropicFastModeState.ts`.

// ========== Provider Registry ==========

const PROVIDERS: { id: ProviderId; name: string; defaultModel: string }[] =
  PROVIDER_ENTRIES.map((e) => ({ id: e.id, name: e.name, defaultModel: e.defaultModel }))

export function getProviderList() {
  return PROVIDERS
}

export function getModelsForProvider(providerId: ProviderId): ModelOption[] {
  const entry = PROVIDER_ENTRY_BY_ID[providerId]
  if (!entry) return []
  return entry.models.map((m) => ({ id: m.id, name: m.name, providerId }))
}

/**
 * Anthropic SDK always POSTs to `{baseURL}/v1/messages`. Strip user-pasted `/v1` or `/v1/messages`
 * so we do not hit `.../v1/v1/messages` (often returns 401 from gateways).
 */
export function normalizeAnthropicCompatBaseUrl(raw: string, fallback: string): string {
  let u = raw.trim().replace(/\/+$/, '')
  if (!u) return fallback
  u = u.replace(/\/v1\/messages$/i, '')
  if (u.toLowerCase().endsWith('/v1')) {
    u = u.slice(0, -3)
  }
  u = u.replace(/\/+$/, '')
  return u || fallback
}

// `isAnthropicCompatThirdPartyGateway` moved to `./providers/anthropic.ts`
// (its only caller was `streamAnthropic`).

/** Default Base URLs for Anthropic-compatible providers (see provider docs). */
export function applyProviderDefaults(base: ProviderConfig): ProviderConfig {
  const config: ProviderConfig = { ...base, apiKey: normalizeApiKeyInput(base.apiKey) }

  // Anthropic is special-cased: when the user leaves baseUrl empty we let
  // the SDK use its own default (api.anthropic.com). Only when the user
  // explicitly pastes a custom URL do we normalize it.
  if (config.id === 'anthropic') {
    const raw = config.baseUrl?.trim()
    if (raw) {
      return { ...config, baseUrl: normalizeAnthropicCompatBaseUrl(raw, raw) }
    }
    return config
  }

  const entry = PROVIDER_ENTRY_BY_ID[config.id]
  if (!entry) return config

  const fb = entry.baseUrl
  const baseUrl = config.baseUrl?.trim()
  if (!baseUrl) return { ...config, baseUrl: fb }
  return { ...config, baseUrl: normalizeAnthropicCompatBaseUrl(baseUrl, fb) }
}

// ========== Unified Streaming Interface ==========

/**
 * Stream text from any provider. All providers produce text deltas via the same interface.
 * When `tools` and `apiMessages` are provided (Anthropic format), each completed `tool_use` block is
 * reported via `onToolUse` as soon as the SDK emits `contentBlock` (then deduped against the final message).
 */
/**
 * Wrap `callbacks.onError` once at the dispatcher so every provider error
 * (regardless of where it was raised inside the stream pipeline) emits a
 * classified telemetry event in exactly one place. Provider-specific
 * clients don't need to know about telemetry at all.
 */
function withTelemetryCallbacks(
  config: ProviderConfig,
  model: string,
  callbacks: StreamCallbacks,
): StreamCallbacks {
  const wire = getProviderQuirks(config).wire
  const originalOnError = callbacks.onError
  return {
    ...callbacks,
    onError: (message: string) => {
      try {
        const ctx = getAgentContext()
        emitProviderErrorTelemetryEvent({
          providerId: config.id,
          wire,
          model,
          errorKind: classifyProviderError(message),
          message,
          conversationId: ctx?.streamConversationId,
          agentId: ctx?.agentId,
        })
      } catch {
        /* telemetry must never interfere with error delivery */
      }
      originalOnError(message)
    },
  }
}

export async function streamText(
  config: ProviderConfig,
  params: StreamTextParams,
  callbacks: StreamCallbacks,
  signal: AbortSignal
): Promise<void> {
  const maxTokensAdjusted =
    config.id === 'openai' || config.id === 'gemini'
      ? adjustMaxTokensForEffort(params.maxTokens, params.effort)
      : params.maxTokens

  const forward = { ...params, maxTokens: maxTokensAdjusted }
  const cb = withTelemetryCallbacks(config, params.model, callbacks)

  if (process.env.ASTRA_AGENT_TOOL_E2E === '1') {
    const { runAgentToolE2EMockStream } = await import('./agentToolE2eMockStream')
    return runAgentToolE2EMockStream(config, forward, cb, signal)
  }

  const { shouldUseCompatibleClient, streamCompatibleFormat } = await import('./compatibleClient')

  const routedConfig: ProviderConfig = applyProviderDefaults(config)
  // openai2 baseUrl is already set by applyProviderDefaults via the registry
  // (defaults to https://api.openai.com/v1), so no extra hard-coded fallback needed.

  if (shouldUseCompatibleClient(routedConfig)) {
    if (routedConfig.id === 'compatible' && !routedConfig.baseUrl?.trim()) {
      cb.onError('兼容模式需要填写 Base URL')
      return
    }
    return streamCompatibleFormat(routedConfig, forward, cb, signal)
  }

  // Provider quirks decide whether third-party Anthropic-compatible gateways
  // (Zhipu, Kimi, DeepSeek, DashScope, MiniMax, or `anthropic` with a custom
  // baseUrl) go through our tolerant fetch-based HTTP client instead of the
  // strict Anthropic SDK. See `providerQuirks.useAnthropicCompatHttpClient`.
  const quirks = getProviderQuirks(routedConfig)
  if (quirks.useAnthropicCompatHttpClient) {
    return streamAnthropicCompatHttp(routedConfig, forward, cb, signal)
  }

  switch (routedConfig.id) {
    case 'anthropic':
    case 'bedrock':
    case 'vertex':
    case 'foundry':
      return streamAnthropic(routedConfig, forward, cb, signal)
    case 'openai':
      return streamOpenAI(routedConfig, forward, cb, signal)
    case 'gemini':
      return streamGemini(routedConfig, forward, cb, signal)
    case 'dashscope':
    case 'minimax':
    case 'zhipu':
    case 'kimi':
    case 'deepseek':
      // Quirks above should have routed these through the compat HTTP
      // client already; this fallback keeps the SDK path alive in case a
      // user deliberately overrode quirks to prefer the SDK.
      return streamAnthropic(routedConfig, forward, cb, signal)
    default:
      cb.onError(`Unknown provider: ${routedConfig.id}`)
  }
}

// Anthropic stream finalization helpers + `streamAnthropic` moved to
// `./providers/anthropic.ts`; the fast-mode state is owned by
// `./providers/anthropicFastModeState.ts`.

// OpenAI provider lives in `./providers/openai.ts`; `streamText` imports
// `streamOpenAI` from there.
// Google Gemini provider lives in `./providers/gemini.ts`.
// Anthropic (direct / Bedrock / Vertex / Foundry / Anthropic-compatible gateways)
// lives in `./providers/anthropic.ts`.
