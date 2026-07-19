/**
 * Declarative provider quirks — single source of truth for how each provider /
 * gateway differs from the reference Anthropic Messages wire.
 *
 * This file replaces the scattered per-provider `if (providerId === 'zhipu')`
 * / `compatThirdPartyAnthropic` heuristics across `providers/anthropic.ts`,
 * `compatibleClient.ts`, `zhipuToolGateway.ts`, and the various transformer
 * modules. To add a new gateway, add an entry to {@link BUILTIN_QUIRKS} (or
 * let {@link deriveQuirksFromConfig} infer defaults from the `ProviderId`).
 *
 * The goal: given a `ProviderConfig`, every part of the pipeline can ask
 * {@link getProviderQuirks} and get a uniform answer on:
 *   - which wire format to transmit/receive
 *   - which JSON-Schema features to strip from tool `input_schema`
 *   - whether we can send Anthropic-only fields (`cache_control`, `thinking`,
 *     `anthropic-beta` headers, `output_config.effort`)
 *   - tool `description` length caps (some gateways silently drop the tail)
 *   - `tool_choice` wire form (some gateways only accept strings, not objects)
 *   - whether `system` must be a string (vs an Anthropic-style text-block array)
 *   - `max_tokens` upper bound per gateway
 *   - how lenient the SSE parser must be (loose / NDJSON-tolerant vs strict)
 *
 * NOTE: this module is intentionally dependency-light — it must be importable
 * from both renderer and main-process code paths without pulling in provider
 * SDKs.
 */

import type { ProviderConfig, ProviderId } from './client'
import { normalizeAnthropicThinkingCapability } from '../../src/types/providerCapabilities'

// ─────────────────────────────────────────────────────────────────────────
// Wire families
// ─────────────────────────────────────────────────────────────────────────

/**
 * Wire format identifier. Used by {@link toolSchemaSanitizer} and the various
 * transformer modules to pick the right cleanup strategy.
 *
 * - `anthropic`                 — official api.anthropic.com / Bedrock / Vertex / Foundry
 * - `anthropic-compat`          — third-party Anthropic Messages-compatible gateways
 * - `openai-native`             — api.openai.com / Azure OpenAI (rich JSON Schema supported)
 * - `openai-compat`             — generic OpenAI-compatible endpoint (vLLM, Ollama, Chinese proxies)
 * - `openai2-native`            — OpenAI Responses API on api.openai.com
 * - `openai2-compat`            — Responses-API-compatible gateways
 * - `gemini-native`             — generativelanguage.googleapis.com
 * - `gemini-compat`             — Gemini-compatible gateways (rare)
 */
export type WireFormat =
  | 'anthropic'
  | 'anthropic-compat'
  | 'openai-native'
  | 'openai-compat'
  | 'openai2-native'
  | 'openai2-compat'
  | 'gemini-native'
  | 'gemini-compat'

/**
 * JSON-Schema feature subsets supported by each wire.
 *
 * - `full`       — keep `additionalProperties`, `$schema`, `$ref`, `$defs`,
 *                  `oneOf`/`anyOf`/`allOf`, `const`, `format`, `default`,
 *                  `examples`, `title` etc. Only the reference Anthropic wire
 *                  plus the native OpenAI Chat endpoint truly accept all of
 *                  these.
 * - `strict-subset` — strip everything the "lowest common denominator"
 *                  gateways may reject. Used for all `*-compat` wires and
 *                  Gemini (native or compat).
 */
export type ToolSchemaPolicy = 'full' | 'strict-subset'

/** `tool_choice` wire form supported by the gateway. */
export type ToolChoiceForm =
  | 'anthropic-object' // `{ type: 'auto' | 'any' | 'tool', name? }`
  | 'openai-object' // `{ type: 'function', function: { name } }` or `'auto' | 'required'`
  | 'openai2-object' // `'auto' | 'required'` or `{ type: 'tool', name }`
  | 'gemini' // set `tool_config.function_calling_config.mode`
  | 'string-only' // gateways that only understand the bare strings

/** SSE dialect tolerance. */
export type SseDialect =
  /** Strictly conforming — full Anthropic SDK parser works. */
  | 'strict-anthropic'
  /** Anthropic events but gateway may emit NDJSON or drop `event:` lines. */
  | 'loose-anthropic'
  /** OpenAI Chat Completions style (`data: {object: "chat.completion.chunk"}`). */
  | 'openai-chat'
  /** OpenAI Chat but gateway may omit the `object` field. */
  | 'loose-openai-chat'
  /** OpenAI Responses API events (`response.*`). */
  | 'openai2'
  /** Gemini `streamGenerateContent` (`data: {candidates:[...]}`). */
  | 'gemini'

// ─────────────────────────────────────────────────────────────────────────
// The Quirks shape
// ─────────────────────────────────────────────────────────────────────────

export interface ProviderQuirks {
  /** Stable identifier — mostly for logs. */
  id: ProviderId | 'custom-anthropic-compat' | 'custom-openai-compat'
  /** Which wire family this provider speaks. */
  wire: WireFormat

  // ── Tool schema handling ────────────────────────────────────────────
  /** How aggressively to strip JSON Schema features when serializing tools. */
  toolSchema: ToolSchemaPolicy
  /**
   * Per-tool `description` max length. Gateways with smaller limits silently
   * drop the tail (or drop the entire tool). Undefined = no cap.
   */
  maxToolDescriptionChars?: number
  /** If true, always emit a non-empty tool `description`. */
  requireToolDescription: boolean

  // ── Anthropic-only features ─────────────────────────────────────────
  /**
   * When false, the pipeline strips `cache_control` from both system blocks
   * and message content blocks before sending.
   */
  supportsCacheControl: boolean
  /**
   * When false, `thinking` / `redacted_thinking` history blocks are stripped
   * and the request `thinking` field is never set.
   */
  supportsThinkingBlocks: boolean
  /** `anthropic-beta` / `anthropic-version` headers — only on official. */
  supportsBetaHeaders: boolean
  /** `output_config.effort` and related fields. Only on official Anthropic. */
  supportsEffort: boolean

  // ── Shape constraints ───────────────────────────────────────────────
  /**
   * When true, `system` must be a string (not an array of text blocks).
   * Many Anthropic-compatible third-party gateways only accept the string form.
   */
  systemMustBeString: boolean
  /** `tool_choice` wire form. */
  toolChoiceForm: ToolChoiceForm

  // ── Size limits ─────────────────────────────────────────────────────
  /** Upper bound on `max_tokens` before the gateway 400s. Undefined = no cap. */
  maxTokensCap?: number

  // ── Streaming ───────────────────────────────────────────────────────
  sseDialect: SseDialect

  // ── Transport ───────────────────────────────────────────────────────
  /** True when the pipeline should POST via `fetch` instead of the SDK. */
  preferCompatibleHttp: boolean
  /** True when the `anthropicCompatHttp` client should handle this provider. */
  useAnthropicCompatHttpClient: boolean

  // ── Advanced tool use (2025-11 betas) ───────────────────────────────
  /**
   * True when the provider accepts Anthropic `input_examples` in tool
   * definitions. Beta `tool-examples-2025-10-29` is automatically attached
   * to the request when applicable. When false, examples are **folded into
   * the tool description** as a fallback so the accuracy bump still applies.
   *
   * Only truly safe on `wire === 'anthropic'` hitting api.anthropic.com /
   * Bedrock / Vertex / Foundry. Every compat gateway is assumed unsafe.
   */
  supportsToolExamples: boolean
  /**
   * True when the provider accepts Anthropic Programmatic Tool Calling:
   * `code_execution_20260120` server tool, tool-level `allowed_callers`,
   * and `server_tool_use` / `code_execution_tool_result` content blocks.
   *
   * Strictly Anthropic-native wire. `anthropic-compat` gateways (Zhipu,
   * Kimi, DeepSeek, …) do NOT implement the sandbox, so the schema layer
   * strips all PTC artifacts before sending.
   */
  supportsPTC: boolean

  // ── Thinking echo constraint ────────────────────────────────────────
  /**
   * When true, historical `thinking` / `redacted_thinking` blocks must be
   * echoed back to the gateway **verbatim** — the normalization pipeline skips
   * every pass that would delete, truncate, or append-to those blocks
   * (`strictThinkingEcho` in `normalizeMessagesForAPI`).
   *
   * Required by gateways that 400 / degrade when prior reasoning is altered:
   *   - DeepSeek (Anthropic-compat 400s when thinking blocks are stripped)
   *   - Kimi k2.6 / k2.7-code (Preserved Thinking is mandatory — historical
   *     `reasoning_content` must be passed back as-is)
   *   - MiniMax M-series (Interleaved Thinking — thinking blocks must be
   *     preserved unchanged across tool-use / multi-turn)
   *
   * Zhipu GLM and DashScope (Qwen) do NOT require this and leave it unset.
   */
  thinkingRequiresHistoryEcho?: boolean

  // ── Multimodal message content ──────────────────────────────────────
  /**
   * True when the provider accepts `type: 'image'` content blocks in user
   * messages. When false, the compat HTTP client strips them before POSTing
   * so the gateway doesn't 400 with "unknown content block type".
   *
   * Most Anthropic-compatible Chinese gateways currently do NOT support
   * vision through the Anthropic-compat endpoint (per DeepSeek / Kimi /
   * GLM docs), so we default them to false.
   */
  supportsImageBlocks: boolean
  /**
   * True when the provider accepts `type: 'document'` content blocks
   * (native PDF upload). Only official Anthropic / Bedrock / Vertex / Foundry
   * support this today. Everywhere else we strip these blocks and rely on
   * the sibling text preamble (pdfjs-extracted text) as the fallback.
   */
  supportsDocumentBlocks: boolean
}

// ─────────────────────────────────────────────────────────────────────────
// Built-in quirk tables
// ─────────────────────────────────────────────────────────────────────────

/**
 * Reference (official) Anthropic endpoint. All optional features enabled.
 */
const QUIRKS_ANTHROPIC_OFFICIAL: ProviderQuirks = {
  id: 'anthropic',
  wire: 'anthropic',
  toolSchema: 'full',
  requireToolDescription: false,
  supportsCacheControl: true,
  supportsThinkingBlocks: true,
  supportsBetaHeaders: true,
  supportsEffort: true,
  systemMustBeString: false,
  toolChoiceForm: 'anthropic-object',
  sseDialect: 'strict-anthropic',
  preferCompatibleHttp: false,
  useAnthropicCompatHttpClient: false,
  supportsToolExamples: true,
  supportsPTC: true,
  supportsImageBlocks: true,
  supportsDocumentBlocks: true,
}

/**
 * AWS Bedrock — Anthropic Messages, no `anthropic-beta` header, no 1h cache.
 *
 * Advanced Tool Use (examples + PTC) requires the `advanced-tool-use-2025-11-20`
 * beta token per Anthropic's docs; we disable both here until the Bedrock
 * transport learns how to carry that header safely. Examples still fall back
 * to description-injection (pure prompt change, wire-agnostic).
 */
const QUIRKS_BEDROCK: ProviderQuirks = {
  ...QUIRKS_ANTHROPIC_OFFICIAL,
  id: 'bedrock',
  supportsBetaHeaders: false,
  supportsEffort: false,
  supportsToolExamples: false,
  supportsPTC: false,
}

/** GCP Vertex — same rationale as Bedrock. */
const QUIRKS_VERTEX: ProviderQuirks = {
  ...QUIRKS_ANTHROPIC_OFFICIAL,
  id: 'vertex',
  supportsBetaHeaders: false,
  supportsEffort: false,
  supportsToolExamples: false,
  supportsPTC: false,
}

/** Azure Foundry — same rationale. */
const QUIRKS_FOUNDRY: ProviderQuirks = {
  ...QUIRKS_ANTHROPIC_OFFICIAL,
  id: 'foundry',
  supportsBetaHeaders: false,
  supportsEffort: false,
  supportsToolExamples: false,
  supportsPTC: false,
}

/**
 * Default `max_tokens` cap for third-party Anthropic-compatible gateways.
 *
 * Was historically 8192 (a conservative copy of vendor "quick start"
 * examples). That is far too small for thinking-heavy agent turns: with
 * `thinking` enabled + `reasoning_effort: max` (DeepSeek's own recommendation
 * for complex Agent scenarios), the model can spend the entire 8192 OUTPUT
 * budget on reasoning and get truncated mid-thought before producing any
 * visible answer or tool call — surfacing as a "thought then silently ended"
 * turn. It also neutralised the agentic loop's 8k→64k max-output escalation
 * recovery, because this cap clamped the escalated value straight back down.
 *
 * 64000 aligns with `getModelMaxOutputTokensBounds` upperLimit. The cap only
 * clamps the REQUESTED `max_tokens` down — normal first-turn requests (default
 * 8192) are unchanged; the higher ceiling only takes effect when the recovery
 * path escalates. Strict relays that 400 on large `max_tokens` can lower it
 * via `POLE_COMPAT_MAX_TOKENS_CAP` without a rebuild.
 */
export const DEFAULT_ANTHROPIC_COMPAT_MAX_TOKENS_CAP = ((): number => {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.POLE_COMPAT_MAX_TOKENS_CAP?.trim()
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 64_000
})()

/** Base quirks for any third-party Anthropic Messages-compatible gateway. */
const QUIRKS_ANTHROPIC_COMPAT_BASE: ProviderQuirks = {
  id: 'custom-anthropic-compat',
  wire: 'anthropic-compat',
  toolSchema: 'strict-subset',
  maxToolDescriptionChars: 14_000,
  requireToolDescription: true,
  supportsCacheControl: false,
  supportsThinkingBlocks: false,
  supportsBetaHeaders: false,
  supportsEffort: false,
  systemMustBeString: true,
  toolChoiceForm: 'anthropic-object',
  sseDialect: 'loose-anthropic',
  preferCompatibleHttp: false,
  useAnthropicCompatHttpClient: true,
  supportsToolExamples: false,
  supportsPTC: false,
  // DeepSeek / Kimi / GLM / DashScope / MiniMax Anthropic-compat endpoints
  // do not implement `type:'image'` or `type:'document'` content blocks
  // (confirmed per each vendor's Anthropic-compat docs). Sending either
  // returns 400 "unknown content block type". The compat HTTP client
  // strips these blocks based on these flags before POSTing; the sibling
  // `text` preamble (pdfjs-extracted text / attachment summary) carries
  // the payload for these gateways.
  supportsImageBlocks: false,
  supportsDocumentBlocks: false,
  // Shared output ceiling for all Anthropic-compat gateways. See
  // DEFAULT_ANTHROPIC_COMPAT_MAX_TOKENS_CAP for the rationale (thinking-heavy
  // turns + escalation recovery). Per-provider overrides may narrow it.
  maxTokensCap: DEFAULT_ANTHROPIC_COMPAT_MAX_TOKENS_CAP,
}

/**
 * 智谱 GLM — 工具描述截断 + 主动开启 thinking。
 *
 * `open.bigmodel.cn/api/anthropic` 支持 `thinking`（type: enabled/disabled），
 * GLM-5.2/5.1/5/4.7/4.6/4.5 系列均可深度思考（官方「深度思考」文档）。GLM 不
 * 强制历史 thinking 块原样回传，故沿用非严格 echo（不设 thinkingRequiresHistoryEcho）。
 */
const QUIRKS_ZHIPU: ProviderQuirks = {
  ...QUIRKS_ANTHROPIC_COMPAT_BASE,
  id: 'zhipu',
  maxToolDescriptionChars: 14_000,
  supportsThinkingBlocks: true,
}

/**
 * Kimi (Moonshot Anthropic compat) — 主动开启 thinking + 强制历史回传。
 *
 * `api.moonshot.cn/anthropic` 支持 `thinking`：kimi-k2.5/k2.6 默认开、可关，
 * kimi-k2-thinking / k2.7-code 恒开。关键约束：k2.6 / k2.7-code 的 Preserved
 * Thinking 强制开启 —— 历史 assistant 消息中的 reasoning/thinking 块必须原样
 * 回传，否则网关报错（官方「Using Thinking Models」文档），因此必须开启
 * strict echo。
 */
const QUIRKS_KIMI: ProviderQuirks = {
  ...QUIRKS_ANTHROPIC_COMPAT_BASE,
  id: 'kimi',
  supportsThinkingBlocks: true,
  thinkingRequiresHistoryEcho: true,
}

/**
 * DeepSeek Anthropic compat.
 *
 * Per https://api-docs.deepseek.com/zh-cn/guides/anthropic_api the gateway
 * differs from the typical Anthropic-compat baseline in two useful ways:
 *   - `thinking` is Supported (only `budget_tokens` is ignored) — including
 *     `type: "thinking"` content blocks in the message history.
 *   - `output_config.effort` is Supported (only `effort`, other subfields
 *     are ignored).
 * `cache_control`, `anthropic-beta`, `anthropic-version`, image/document
 * blocks remain unsupported and stay stripped via the compat base.
 */
const QUIRKS_DEEPSEEK: ProviderQuirks = {
  ...QUIRKS_ANTHROPIC_COMPAT_BASE,
  id: 'deepseek',
  supportsThinkingBlocks: true,
  supportsEffort: true,
  thinkingRequiresHistoryEcho: true,
}

/**
 * DashScope (Aliyun Qwen Anthropic compat) — 主动开启 thinking。
 *
 * `dashscope.aliyuncs.com/apps/anthropic` 支持 `thinking`
 * （type: enabled/disabled + budget_tokens）。注意：部分模型（Coder 系列、
 * qwen-long、旧版 qwen-vl-max/plus）不支持思考模式，对这类模型下发 thinking
 * 会报错。因此本 provider 在 `anthropicCompatHttp.ts` 里按模型名通过
 * {@link dashscopeModelSupportsThinking} 决定是否下发 thinking（区别于其它
 * 几家的 provider 级无条件开启）。千问不强制历史 thinking 块回传，故沿用
 * 非严格 echo。
 */
const QUIRKS_DASHSCOPE: ProviderQuirks = {
  ...QUIRKS_ANTHROPIC_COMPAT_BASE,
  id: 'dashscope',
  supportsThinkingBlocks: true,
}

/**
 * MiniMax Anthropic compat — 主动开启 thinking + 强制历史回传。
 *
 * `api.minimaxi.com/anthropic`「完全支持」`thinking`：M3 默认关、可用
 * enabled/adaptive 开启，M2.x 系列恒开不可关。官方明确要求多轮对话 / 工具
 * 调用中 thinking 块必须原样保留并回传，否则破坏 Interleaved Thinking 且可能
 * 出错，因此必须开启 strict echo。
 */
const QUIRKS_MINIMAX: ProviderQuirks = {
  ...QUIRKS_ANTHROPIC_COMPAT_BASE,
  id: 'minimax',
  supportsThinkingBlocks: true,
  thinkingRequiresHistoryEcho: true,
}

/** OpenAI native Chat Completions. */
const QUIRKS_OPENAI: ProviderQuirks = {
  id: 'openai',
  wire: 'openai-native',
  toolSchema: 'full',
  requireToolDescription: true,
  supportsCacheControl: false,
  supportsThinkingBlocks: false,
  supportsBetaHeaders: false,
  supportsEffort: false,
  systemMustBeString: true,
  toolChoiceForm: 'openai-object',
  sseDialect: 'openai-chat',
  preferCompatibleHttp: false,
  useAnthropicCompatHttpClient: false,
  supportsToolExamples: false,
  supportsPTC: false,
  // `claudeToOpenAI` transformer downgrades image → image_url and
  // document → text notice; the OpenAI Chat wire itself accepts images
  // via image_url but has no PDF equivalent.
  supportsImageBlocks: true,
  supportsDocumentBlocks: false,
}

/** OpenAI Responses API (openai2). */
const QUIRKS_OPENAI2: ProviderQuirks = {
  id: 'openai2',
  wire: 'openai2-native',
  toolSchema: 'full',
  requireToolDescription: true,
  supportsCacheControl: false,
  supportsThinkingBlocks: false,
  supportsBetaHeaders: false,
  supportsEffort: false,
  systemMustBeString: true,
  toolChoiceForm: 'openai2-object',
  sseDialect: 'openai2',
  preferCompatibleHttp: true,
  useAnthropicCompatHttpClient: false,
  supportsToolExamples: false,
  supportsPTC: false,
  // `claudeToOpenAI2` transformer handles image → input_image; document
  // is dropped (model reads sibling text).
  supportsImageBlocks: true,
  supportsDocumentBlocks: false,
}

/** Native Gemini (via `@google/generative-ai`). */
const QUIRKS_GEMINI: ProviderQuirks = {
  id: 'gemini',
  wire: 'gemini-native',
  toolSchema: 'strict-subset', // Gemini rejects `additionalProperties`, `$schema`, …
  requireToolDescription: true,
  supportsCacheControl: false,
  supportsThinkingBlocks: false,
  supportsBetaHeaders: false,
  supportsEffort: false,
  systemMustBeString: true,
  toolChoiceForm: 'gemini',
  sseDialect: 'gemini',
  preferCompatibleHttp: false,
  useAnthropicCompatHttpClient: false,
  supportsToolExamples: false,
  supportsPTC: false,
  // Gemini supports both image and document (PDF) via `inlineData`;
  // `claudeToGemini` transformer maps both types.
  supportsImageBlocks: true,
  supportsDocumentBlocks: true,
}

/** Generic `compatible` provider — default to lenient OpenAI-compat until user narrows. */
const QUIRKS_COMPATIBLE_DEFAULT: ProviderQuirks = {
  id: 'compatible',
  wire: 'openai-compat',
  toolSchema: 'strict-subset',
  maxToolDescriptionChars: 14_000,
  requireToolDescription: true,
  supportsCacheControl: false,
  supportsThinkingBlocks: false,
  supportsBetaHeaders: false,
  supportsEffort: false,
  systemMustBeString: true,
  toolChoiceForm: 'openai-object',
  sseDialect: 'loose-openai-chat',
  preferCompatibleHttp: true,
  useAnthropicCompatHttpClient: false,
  supportsToolExamples: false,
  supportsPTC: false,
  // Optimistically assume image support (the claudeToOpenAI transformer
  // downgrades to `image_url` which is the de-facto OpenAI-compat shape
  // across vLLM / Ollama / LocalAI / Chinese proxies). Document blocks
  // have no consistent downgrade target — strip.
  supportsImageBlocks: true,
  supportsDocumentBlocks: false,
}

/**
 * Exported for tests: the quirks table keyed by built-in ProviderId.
 */
export const BUILTIN_QUIRKS: Record<ProviderId, ProviderQuirks> = {
  anthropic: QUIRKS_ANTHROPIC_OFFICIAL,
  bedrock: QUIRKS_BEDROCK,
  vertex: QUIRKS_VERTEX,
  foundry: QUIRKS_FOUNDRY,
  zhipu: QUIRKS_ZHIPU,
  kimi: QUIRKS_KIMI,
  deepseek: QUIRKS_DEEPSEEK,
  dashscope: QUIRKS_DASHSCOPE,
  minimax: QUIRKS_MINIMAX,
  openai: QUIRKS_OPENAI,
  openai2: QUIRKS_OPENAI2,
  gemini: QUIRKS_GEMINI,
  compatible: QUIRKS_COMPATIBLE_DEFAULT,
}

// ─────────────────────────────────────────────────────────────────────────
// Runtime derivation
// ─────────────────────────────────────────────────────────────────────────

/**
 * True when a `providerId === 'anthropic'` config actually points at a
 * third-party Anthropic-compatible gateway (i.e. any baseUrl that is not
 * `api.anthropic.com`). Mirrors `providers/anthropic.ts#isAnthropicCompatThirdPartyGateway`.
 */
function isAnthropicProviderPointingAtThirdParty(config: Pick<ProviderConfig, 'id' | 'baseUrl'>): boolean {
  if (config.id !== 'anthropic') return false
  const u = config.baseUrl?.trim().toLowerCase() ?? ''
  return u.length > 0 && !u.includes('api.anthropic.com')
}

/**
 * Resolve the quirks profile for a given provider config.
 *
 * - `anthropic` with a custom baseUrl is detected as a third-party compat
 *   gateway (same heuristic as in the existing codebase).
 * - `compatible` is classified as Anthropic-compat only when the baseUrl has
 *   an obvious Anthropic shape (`/anthropic` path segment or a hostname we
 *   recognize as Anthropic-compat). Otherwise it stays OpenAI-compat.
 */
export function getProviderQuirks(
  config: Pick<ProviderConfig, 'id' | 'baseUrl' | 'anthropicThinkingCapability'>,
): ProviderQuirks {
  if (isAnthropicProviderPointingAtThirdParty(config)) {
    const thinkingCapability = normalizeAnthropicThinkingCapability(
      config.anthropicThinkingCapability,
    )
    return {
      ...QUIRKS_ANTHROPIC_COMPAT_BASE,
      id: 'custom-anthropic-compat',
      supportsThinkingBlocks: thinkingCapability !== 'unsupported',
    }
  }

  if (config.id === 'compatible') {
    const u = (config.baseUrl ?? '').trim().toLowerCase()
    if (u.includes('/anthropic') || /\banthropic\b/.test(u)) {
      const thinkingCapability = normalizeAnthropicThinkingCapability(
        config.anthropicThinkingCapability,
      )
      return {
        ...QUIRKS_ANTHROPIC_COMPAT_BASE,
        id: 'custom-anthropic-compat',
        supportsThinkingBlocks: thinkingCapability !== 'unsupported',
        preferCompatibleHttp: false,
        useAnthropicCompatHttpClient: true,
      }
    }
    if (u.includes('generativelanguage.googleapis.com')) {
      return {
        ...QUIRKS_GEMINI,
        id: 'compatible',
        wire: 'gemini-compat',
      }
    }
    return QUIRKS_COMPATIBLE_DEFAULT
  }

  return BUILTIN_QUIRKS[config.id]
}

/**
 * True for any provider config whose wire is Anthropic Messages (official or
 * compat).
 */
export function quirksUseAnthropicWire(q: ProviderQuirks): boolean {
  return q.wire === 'anthropic' || q.wire === 'anthropic-compat'
}

/** True when the provider is a third-party Anthropic-compatible gateway. */
export function quirksIsThirdPartyAnthropicCompat(q: ProviderQuirks): boolean {
  return q.wire === 'anthropic-compat'
}

// ─────────────────────────────────────────────────────────────────────────
// Advanced tool use — model white-lists (Anthropic "Advanced tool use" 2025-11-24)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Anthropic Tool Use Examples beta token (sent via `anthropic-beta` header
 * when a request carries any tool with `input_examples`).
 *
 * @see https://www.anthropic.com/engineering/advanced-tool-use
 */
export const ANTHROPIC_TOOL_EXAMPLES_BETA_TOKEN = 'tool-examples-2025-10-29'

/**
 * Anthropic combined Advanced Tool Use beta (Bedrock / Vertex / Foundry).
 * On first-party api.anthropic.com PTC is GA and no beta token is strictly
 * required; we nonetheless send it when the wire's `supportsBetaHeaders`
 * allows, to match the official docs.
 */
export const ANTHROPIC_ADVANCED_TOOL_USE_BETA_TOKEN = 'advanced-tool-use-2025-11-20'

/**
 * Model name prefixes known to support Tool Use Examples + PTC (Opus 4.5+,
 * Sonnet 4.5+). Matching is lenient: any model whose id starts with one of
 * these prefixes is considered supported. This keeps the check future-proof
 * for minor model version bumps.
 */
const ADVANCED_TOOL_USE_MODEL_PREFIXES: readonly string[] = [
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-7',
]

/**
 * True when `model` is in the Advanced Tool Use (Examples + PTC) white-list.
 * Empty / undefined model string → false (opt-out by default).
 */
export function modelSupportsAdvancedToolUse(model: string | undefined | null): boolean {
  const m = model?.trim().toLowerCase() ?? ''
  if (!m) return false
  return ADVANCED_TOOL_USE_MODEL_PREFIXES.some((p) => m.startsWith(p))
}

/**
 * Resolve whether a given `(quirks, model)` pair can use native Tool Use
 * Examples. This is the single decision point for both the schema layer
 * (whether to emit `input_examples`) and the beta-header latch (whether to
 * attach `tool-examples-2025-10-29`).
 */
export function resolveToolExamplesMode(
  quirks: ProviderQuirks,
  model: string | undefined | null,
): 'native' | 'description-fallback' | 'disabled' {
  if (!modelSupportsAdvancedToolUse(model)) {
    // Non-eligible models can still benefit from a prompt-level fallback.
    return 'description-fallback'
  }
  if (quirks.supportsToolExamples) return 'native'
  return 'description-fallback'
}

/**
 * Resolve whether a given `(quirks, model)` pair can use Programmatic Tool
 * Calling. When false, the schema layer strips `allowed_callers` and the
 * `code_execution_20260120` server tool from the request.
 *
 * Gated behind the `POLE_PTC_ENABLED` env flag so existing installs keep
 * current behaviour until explicitly opted in.
 */
export function resolvePtcEnabled(
  quirks: ProviderQuirks,
  model: string | undefined | null,
): boolean {
  if (process.env.POLE_PTC_ENABLED !== '1') return false
  if (!quirks.supportsPTC) return false
  return modelSupportsAdvancedToolUse(model)
}

// ─────────────────────────────────────────────────────────────────────────
// Vision / multimodal model detection
// ─────────────────────────────────────────────────────────────────────────

/**
 * Heuristic: does `model` look like a vision-capable / multimodal variant?
 *
 * Used to override `quirks.supportsImageBlocks` when the quirks table is
 * conservatively `false` for the whole provider family (every Anthropic-compat
 * gateway ships with `supportsImageBlocks: false` by default — see
 * {@link QUIRKS_ANTHROPIC_COMPAT_BASE}). When the user explicitly picks a
 * vision SKU (e.g. Qwen `qwen3-vl-plus` / DashScope `qwen3.6-plus`,
 * Zhipu `glm-4v*` / `glm-4.1v*`, MiniMax `*-vl*`, or any Claude / Gemini 1.5+
 * / GPT-4o* model reachable through the same gateway), stripping images
 * silently makes the assistant reply "I can't see any image" even though
 * the model would have accepted the block.
 *
 * Matching is deliberately lenient — a new vision variant that fits any of
 * the patterns below will automatically opt in without a code change. Known
 * false positives are limited to names that coincidentally contain `vl` /
 * `-4v` / `vision`; we accept that risk because the worst case is a 400
 * surfaced by the gateway (one turn fails) vs. today's silent data loss
 * (every image turn fails).
 */
/**
 * DashScope (Qwen) model-name gate for sending the Anthropic `thinking` param.
 *
 * DashScope's Anthropic-compat endpoint accepts `thinking` for most Qwen chat
 * / reasoning SKUs (qwen3 Max/Plus/Flash, QwQ, Qwen3-VL …), but a few families
 * do NOT support thinking mode (Aliyun docs: "部分模型不支持思考模式") and the
 * gateway errors / wastes a turn when `thinking:{type:'enabled'}` is sent:
 *   - `*-coder-*` — Qwen3-Coder models have no thinking mode.
 *   - `qwen-long`  — long-context model, no thinking.
 *   - legacy `qwen-vl-max` / `qwen-vl-plus` (Qwen2.x VL). NOTE: the Qwen3-VL
 *     line (`qwen3-vl-*`) DOES support thinking and stays `true`.
 *
 * Returns false ONLY for these known-unsupported families; everything else
 * defaults to true so a new thinking-capable Qwen SKU works without a code
 * change. Conservative by design — a false negative just means one model
 * silently skips thinking, vs. a false positive surfacing a gateway error.
 *
 * Used by `anthropicCompatHttp.ts` to drive `providerSupportsThinking` for the
 * `dashscope` provider specifically; other Anthropic-compat gateways keep the
 * unconditional `true` (their thinking support is provider-wide).
 */
export function dashscopeModelSupportsThinking(model: string | undefined | null): boolean {
  const m = model?.trim().toLowerCase() ?? ''
  if (!m) return false
  // Coder family — no thinking mode.
  if (/(^|[-_.])coder([-_.]|$)/.test(m)) return false
  // Long-context summarization model — no thinking.
  if (/(^|[-_.])long([-_.]|$)/.test(m)) return false
  // Legacy Qwen2.x VL (qwen-vl-max / qwen-vl-plus). Qwen3-VL (`qwen3-vl-*`)
  // is NOT matched by this prefix and keeps thinking enabled.
  if (/^qwen-vl-(max|plus)\b/.test(m)) return false
  return true
}

export function modelLikelySupportsVision(model: string | undefined | null): boolean {
  const m = model?.trim().toLowerCase() ?? ''
  if (!m) return false

  // Claude — every production Claude model reads images.
  if (m.startsWith('claude-') || m.startsWith('anthropic.claude')) return true

  // Gemini 1.5+ — all Flash / Pro / Lite variants are multimodal.
  if (/^gemini-(1\.5|2(\.|-)|3)/.test(m)) return true

  // DashScope Qwen 3.5+ Plus/Flash lineup is multimodal on the Anthropic-compat
  // surface (per Aliyun Model Studio vision-model docs: qwen3.7-plus /
  // qwen3.6-plus / qwen3.6-flash / qwen3.5-plus / qwen3.5-flash accept
  // image+video input).
  //
  // The Max family is deliberately EXCLUDED: qwen3.7-max (and qwen3-max /
  // qwen3.6-max-preview) are text-only — confirmed by Aliyun's vision-model
  // doc (Qwen3.7 section lists only qwen3.7-plus) and third-party coverage
  // ("text-only Qwen3.7-Max"). Community articles describe Max as "多模态增强"
  // but that refers to fused search/OCR product features, NOT image input on
  // the API. Forwarding images to Max gets HTTP 400 InvalidParameter
  // "Unexpected item type in content." from the DashScope gateway.
  if (/^qwen3\.[5-9]-(plus|flash)(?:[-_.]|$)/.test(m)) return true

  // OpenAI vision families: gpt-4o*, gpt-4-vision*, gpt-4.1*, gpt-5*, o1 / o3 / o4*.
  if (/^gpt-4o/.test(m)) return true
  if (/^gpt-4(\.|-)?1/.test(m)) return true
  if (/^gpt-4.*vision/.test(m)) return true
  if (/^gpt-5/.test(m)) return true
  if (/^o[134](-|$)/.test(m)) return true

  // Generic "vision" or "multimodal" token anywhere in the id.
  if (/(^|[-_.])vision([-_.]|$)/.test(m)) return true
  if (/(^|[-_.])multimodal([-_.]|$)/.test(m)) return true

  // `-vl-` / `-vl` / `vl-` — Qwen-VL, DeepSeek-VL, MiniMax-VL, …
  if (/(^|[-_.])vl([-_.]|$)/.test(m)) return true

  // MiniMax M3+ is natively multimodal (image + video input on the
  // Anthropic-compat endpoint with `type:'image'` blocks — per the
  // MiniMax M3 release docs, 2026-06). The M2.x family stays text-only
  // and must keep matching false.
  if (/^minimax-m([3-9]|\d{2,})/.test(m)) return true

  // GLM `4v`, `4.1v`, `5v` — multimodal suffix on digits.
  if (/glm-?\d+(\.\d+)?v/.test(m)) return true

  return false
}
