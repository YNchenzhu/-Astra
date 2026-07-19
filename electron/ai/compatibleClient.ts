/**
 * 兼容格式 API 客户端 - 自动转换多种格式为 Claude 原生格式
 *
 * 使用场景：
 * - 用户配置了 OpenAI 兼容的端点（如 vLLM、Ollama、LocalAI）
 * - 用户配置了 OpenAI2 (Responses API) 端点
 * - 用户配置了 Gemini 兼容端点
 *
 * 此模块自动检测请求格式并转换为 Claude 格式，然后调用标准的 Anthropic 客户端
 */

import type { StreamCallbacks, ProviderConfig, StreamTextParams } from './client'
import { buildAnthropicSystemParam } from './anthropicSystemWire'
import { stripPoleContextUsageFromApiMessages } from '../context/tokenUsageAccounting'
import { emitProviderErrorSignal } from './loopSignalEmit'
import { sanitizeGeminiGeneratePayload } from './geminiRequestSanitize'
import { isAbortLikeError } from './abortLikeError'
import { mergeUserSignalWithStreamWatchdog, type StreamWatchdogHandle } from './streamWatchdog'
import { wrapCallbacksForEmissionTracking } from './streamWithMidStreamRetry'
import { isRetryableStreamHttpError, sleepAbortable } from './withRetry'
import { releaseFetchResponseBody } from './releaseStreamResources'
import { StreamWriteInputWatcher } from './streamWriteInputWatcher'
import {
  createToolInputDeltaThrottleState,
  hasPendingThrottledTail,
  shouldEmitToolInputDelta,
  type ToolInputDeltaThrottleState,
} from './toolInputDeltaThrottle'
import {
  detectResponseFormat,
  detectStreamFormat,
  transformRequest,
  transformResponse,
  transformStreamEvent,
  createTransformContext,
  estimateTokens,
  type APIFormat,
} from './transformer'
import { parseToolArgumentsWithMeta } from './transformer/parseToolArguments'
import {
  TRUNCATED_TOOL_ARGS_MARKER_KEY,
  WRITE_EDIT_TOOL_NAMES_FOR_TRUNCATION_GUARD,
} from '../tools/toolInputZod'
import { sanitizeMessagesForWire } from '../utils/unicodeSanitize'
import { mapStopReasonToClaude, type ClaudeStopReason } from './stopReasonMap'

/**
 * Per-SSE-event verbose logger. The previous unconditional `console.log` on
 * every `function_call_arguments.delta` chunk was shipping 50–200 lines per
 * second of streaming output to the Electron main-process stdout — and
 * `process.stdout` is **synchronous** in Node when bound to a TTY or to a
 * v8 inspector pipe (dev mode), so each line stalls the event loop just
 * long enough to back up IPC to the renderer. Production users observed
 * 5–10 second UI freezes that lined up exactly with bursts of these log
 * lines.
 *
 * This flag gates ONLY the high-frequency per-event logs. The
 * stream-lifecycle logs (request start, headers received, stream done,
 * errors) stay unconditional — they're at most a handful per request and
 * are essential for debugging.
 *
 * Enable with `POLE_COMPAT_VERBOSE=1` (or any truthy value) when you need
 * to inspect every chunk. Default is OFF so the steady-state path emits
 * one start log + one end log per stream + occasional event-format-lock /
 * error logs.
 */
const COMPAT_VERBOSE_LOG: boolean = (() => {
  const raw = process.env?.POLE_COMPAT_VERBOSE?.trim().toLowerCase() ?? ''
  return (
    raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
  )
})()

function extractCompatRawStopReason(
  event: Record<string, unknown>,
  format: APIFormat,
): string | undefined {
  if (format === 'openai') {
    const choices = event.choices
    if (!Array.isArray(choices)) return undefined
    const first = choices[0] as Record<string, unknown> | undefined
    const raw = first?.finish_reason
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined
  }
  if (format === 'openai2') {
    if (event.type === 'response.completed') return 'completed'
    if (event.type === 'response.incomplete') return 'incomplete'
    const response = event.response as Record<string, unknown> | undefined
    const status = response?.status ?? event.status
    return typeof status === 'string' && status.length > 0 ? status : undefined
  }
  if (format === 'gemini') {
    const candidates = event.candidates
    if (!Array.isArray(candidates)) return undefined
    const first = candidates[0] as Record<string, unknown> | undefined
    const raw = first?.finishReason
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined
  }
  if (format === 'claude' && event.type === 'message_delta') {
    const delta = event.delta as Record<string, unknown> | undefined
    const raw = delta?.stop_reason
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined
  }
  return undefined
}

function mapCompatStopReason(
  format: APIFormat,
  raw: string,
  hasToolUseBlocks: boolean,
): ClaudeStopReason {
  switch (format) {
    case 'openai':
      return mapStopReasonToClaude('openai-compat', raw, { hasToolUseBlocks })
    case 'openai2':
      return mapStopReasonToClaude('openai2-compat', raw, { hasToolUseBlocks })
    case 'gemini':
      return mapStopReasonToClaude('gemini-compat', raw, { hasToolUseBlocks })
    case 'claude':
    default:
      return mapStopReasonToClaude('anthropic-compat', raw, { hasToolUseBlocks })
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      signal.removeEventListener('abort', onAbort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 初始连接阶段常见可重试错误（流中途断开需整段重试，此处只覆盖 fetch 握手） */
function isTransientFetchFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === 'AbortError') return false
  const cause = (error as Error & { cause?: unknown }).cause
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = String((cause as NodeJS.ErrnoException).code || '')
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED'].includes(code)) {
      return true
    }
  }
  return /fetch failed/i.test(error.message)
}

/**
 * F1 (2026-06) — openai2 stateless-reasoning 400-fallback latch.
 *
 * Third-party Responses-compatible relays may reject `store` / `include` /
 * replayed `reasoning` input items with HTTP 400. On the first such failure
 * we retry once without the reasoning fields and remember the baseUrl here so
 * subsequent requests skip them entirely (behaviour parity with pre-F1).
 * Process-lifetime only; cleared on restart.
 */
const openai2ReasoningUnsupportedBaseUrls = new Set<string>()

function isOpenai2ReasoningEnabled(baseUrl: string): boolean {
  if (process.env.POLE_OPENAI2_REASONING === '0') return false
  return !openai2ReasoningUnsupportedBaseUrls.has(baseUrl.trim().toLowerCase())
}

function latchOpenai2ReasoningUnsupported(baseUrl: string): void {
  openai2ReasoningUnsupportedBaseUrls.add(baseUrl.trim().toLowerCase())
}

/** True when a 400 body plausibly complains about the reasoning fields. */
function looksLikeReasoningFieldRejection(errorText: string): boolean {
  return /store|include|reasoning|encrypted/i.test(errorText)
}

/** Strip the F1 reasoning fields from an already-transformed openai2 request. */
function stripOpenai2ReasoningFields(req: Record<string, unknown>): Record<string, unknown> {
  const next = { ...req }
  delete next.store
  delete next.include
  if (Array.isArray(next.input)) {
    next.input = (next.input as Array<Record<string, unknown>>).filter(
      (item) => item?.type !== 'reasoning',
    )
  }
  return next
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  label: string,
): Promise<Response> {
  const maxAttempts = 3
  const baseMs = 400
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetch(url, init)
    } catch (e) {
      lastError = e
      if (e instanceof Error && e.name === 'AbortError') throw e
      if (!isTransientFetchFailure(e) || attempt === maxAttempts) throw e
      const delay = baseMs * 2 ** (attempt - 1)
      console.warn(`[CompatibleClient] ${label} 第 ${attempt}/${maxAttempts} 次失败，${delay}ms 后重试`, e)
      await sleep(delay, signal)
    }
  }
  throw lastError
}

/**
 * Pre-flight validation of the resolved baseUrl.
 *
 * Without this check, a misconfigured `baseUrl` (e.g. user pasted their
 * API key into the "接口地址" field — common mistake because the form has
 * "接口地址" right above "API 密钥") flows all the way down to
 * `fetch(\`${baseUrl}/v1/responses\`)`, which throws the cryptic
 * `TypeError: Failed to parse URL from sk-.../v1/responses`. Users see
 * that opaque message in the chat error pane and have no way to figure
 * out which field needs fixing.
 *
 * Catching it here lets us surface a Chinese-language, actionable
 * diagnosis that names the offending field and the specific provider, and
 * offers concrete remediation. The error is non-retryable (no HTTP
 * status, no transient-network code) so `isRetryableStreamHttpError`
 * correctly reports it once and stops.
 */
function assertValidBaseUrl(baseUrl: string | undefined, providerId: string | undefined): void {
  const trimmed = (baseUrl ?? '').trim()
  if (!trimmed) {
    throw new Error(
      `接口地址（baseUrl）为空（provider=${providerId || 'unknown'}）。请在「设置 → API 配置」中填写完整的端点地址，例如 https://api.openai.com/v1，或留空以使用内置默认地址。`,
    )
  }
  let parsed: URL | null = null
  try {
    parsed = new URL(trimmed)
  } catch {
    parsed = null
  }
  if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    return
  }
  // Heuristic: API keys are almost always `sk-`/`sk-ant-`/`AIza`-prefixed
  // or a 20+ char alnum/`-`/`_` blob with no `://`. If the value matches,
  // tell the user explicitly which two fields they probably swapped.
  const looksLikeApiKey =
    /^sk-/i.test(trimmed) ||
    /^AIza[A-Za-z0-9_-]{10,}$/.test(trimmed) ||
    (!/[/:]/.test(trimmed) && /^[A-Za-z0-9_-]{20,}$/.test(trimmed))
  const preview =
    trimmed.length > 32
      ? `${trimmed.slice(0, 8)}…${trimmed.slice(-6)}`
      : trimmed
  const hint = looksLikeApiKey
    ? '看起来您把 API 密钥填到了「接口地址」字段里。请在「设置 → API 配置」中将该值移到「API 密钥」字段；「接口地址」请留空使用默认地址，或填写完整的 https:// 端点 URL。'
    : '请填写以 http:// 或 https:// 开头的完整 URL，或留空使用内置默认地址。'
  throw new Error(
    `接口地址不是有效 URL（provider=${providerId || 'unknown'}，当前值：${preview}）。${hint}`,
  )
}

function formatCompatibleClientNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error.name === 'AbortError') return error.message
  const cause = (error as Error & { cause?: unknown }).cause
  let code = ''
  if (cause && typeof cause === 'object' && 'code' in cause) {
    code = String((cause as NodeJS.ErrnoException).code || '')
  }
  const base = error.message || '未知错误'
  if (code === 'ECONNRESET' || /fetch failed/i.test(base)) {
    return `${base}（${code || '网络'}）。连接被对端或中间网络设备关闭，常见于代理/网关超时、TLS 中断或流式长连接被重置。请检查 baseUrl、系统代理与 API 服务状态后重试。`
  }
  if (code === 'ECONNREFUSED') {
    return `${base}。无法连接到服务器，请确认 baseUrl 与端口是否正确、服务是否已启动。`
  }
  if (code === 'ETIMEDOUT') {
    return `${base}。连接超时，请检查网络或更换更稳定的中转节点。`
  }
  return base
}

// ========== 兼容格式客户端 ==========

/**
 * 流式处理兼容格式的 API 请求
 *
 * 工作流程：
 * 1. 检测端点格式（OpenAI/OpenAI2/Gemini）
 * 2. 转换 Claude 请求为目标格式
 * 3. 发送请求到端点
 * 4. 接收响应并转换回 Claude 格式
 * 5. 处理流式事件
 */
export async function streamCompatibleFormat(
  config: ProviderConfig,
  params: StreamTextParams,
  userCallbacks: StreamCallbacks,
  signal: AbortSignal
): Promise<void> {
  let streamWatchdog: StreamWatchdogHandle | undefined
  // A1 — emission tracker + outer retry loop. The whole network-bearing
  // body retries on transient mid-stream failures provided NO callback
  // has fired yet (otherwise we'd double-emit user-visible output).
  // `hasEmittedAnything` is shared across attempts; once set it stays
  // set, locking out further retries. Retries are capped at 2 (3
  // attempts including initial), with the same exponential-backoff
  // schedule used by the central `withRetry` helper.
  let hasEmittedAnything = false
  const emissionTracker = {
    markEmitted: () => { hasEmittedAnything = true },
    hasEmitted: () => hasEmittedAnything,
  }
  const callbacks = wrapCallbacksForEmissionTracking(userCallbacks, emissionTracker)
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  try {
    console.log(`[CompatibleClient] 开始流式请求，baseUrl: ${config.baseUrl}`)

    // 将"baseUrl 是 API Key/相对路径/缺失协议"等用户配置错误从晦涩的
    // `TypeError: Failed to parse URL` 提前到一条说明哪个字段填错的中文报错。
    // 见 `assertValidBaseUrl` 的注释。
    assertValidBaseUrl(config.baseUrl, config.id)

    // 创建转换上下文
    const ctx = createTransformContext()

    // 构建 Claude 格式的请求
    // §10.2/§10.3：Claude 形 apiMessages 仅在 runAgenticLoop 内统一清洗（forceClaudeShapedMessages），此处不重复。
    const messagesForWire = params.apiMessages
      ? stripPoleContextUsageFromApiMessages(params.apiMessages) ?? params.apiMessages
      : params.messages.map((m) => ({
          role: m.role,
          content: m.content,
        }))
    const systemWire = buildAnthropicSystemParam(
      params.systemPrompt,
      params.systemPromptLayers,
    )

    const claudeRequest: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens || 8192,
      system: systemWire ?? params.systemPrompt,
      messages: messagesForWire,
      tools: params.tools,
      ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
      stream: true,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.topP !== undefined ? { top_p: params.topP } : {}),
    }

    if (params.alwaysThinking) {
      const fallback = Math.min((params.maxTokens || 8192) * 4, 32768)
      const budget =
        typeof params.thinkingBudgetTokens === 'number' && params.thinkingBudgetTokens > 0
          ? params.thinkingBudgetTokens
          : fallback
      claudeRequest.thinking = {
        type: 'enabled',
        budget_tokens: Math.min(budget, 32768),
      }
    }

    console.log(`[CompatibleClient] 构建 Claude 请求完成`)

    // 检测端点格式（优先根据 provider 类型，回退到 URL 启发式）
    const targetFormat = detectEndpointFormat(config.baseUrl || '', config.id)
    console.log(`[CompatibleClient] 检测到目标格式: ${targetFormat}`)

    // F1 — openai2 stateless reasoning passthrough gate (env + per-baseUrl latch).
    const openai2Reasoning =
      targetFormat === 'openai2' && isOpenai2ReasoningEnabled(config.baseUrl || '')
    if (openai2Reasoning) {
      ctx.openai2ReasoningEnabled = true
    }

    // 转换请求为目标格式 — compatibleClient builds a loose record; the
    // transformer is fed a ClaudeRequest-shaped structure at runtime, so
    // route through `unknown` at this boundary only.
    let transformedRequest = transformRequest(
      claudeRequest as unknown as import('./transformer/types').ClaudeRequest,
      targetFormat,
      ctx,
    ) as Record<string, unknown>
    if (targetFormat === 'gemini') {
      transformedRequest = sanitizeGeminiGeneratePayload(transformedRequest)
    }
    // OpenAI / Gemini / Claude wire: strip lone UTF-16 surrogates from every
    // string field before JSON.stringify — same serde_json 400 class as
    // anthropicCompatHttp. See `unicodeSanitize.ts`.
    transformedRequest = sanitizeMessagesForWire(transformedRequest)
    console.log(`[CompatibleClient] 请求转换完成`)
    // 根据目标格式选择正确的端点路径
    const endpointPath = getEndpointPath(config.baseUrl || '', targetFormat, params.model, true)
    console.log(`[CompatibleClient] 发送请求到 ${endpointPath}`)

    // Gemini 原生 API 使用 query param 认证；其他使用 Bearer token
    const fetchUrl = targetFormat === 'gemini'
      ? `${endpointPath}?key=${encodeURIComponent(config.apiKey)}&alt=sse`
      : endpointPath
    const fetchHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
    if (targetFormat !== 'gemini') {
      fetchHeaders['Authorization'] = `Bearer ${config.apiKey}`
    }

    streamWatchdog = mergeUserSignalWithStreamWatchdog(
      signal,
      `[CompatibleClient] ${targetFormat} stream`,
    )

    let response = await fetchWithRetry(
      fetchUrl,
      {
        method: 'POST',
        headers: fetchHeaders,
        body: JSON.stringify(transformedRequest),
        signal: streamWatchdog.signal,
      },
      streamWatchdog.signal,
      '流式请求',
    )

    if (!response.ok) {
      const errorText = await response.text()
      // F1 — graceful degradation: a 400 that names the reasoning fields means
      // this relay doesn't speak `store`/`include`/reasoning replay. Latch the
      // baseUrl, strip the fields, retry ONCE. Subsequent requests skip them
      // at build time via `isOpenai2ReasoningEnabled`.
      if (
        response.status === 400 &&
        openai2Reasoning &&
        looksLikeReasoningFieldRejection(errorText)
      ) {
        console.warn(
          `[CompatibleClient] openai2 网关拒绝 reasoning 字段（400），降级重试并记忆该 baseUrl`,
          errorText.slice(0, 300),
        )
        latchOpenai2ReasoningUnsupported(config.baseUrl || '')
        transformedRequest = stripOpenai2ReasoningFields(transformedRequest)
        response = await fetchWithRetry(
          fetchUrl,
          {
            method: 'POST',
            headers: fetchHeaders,
            body: JSON.stringify(transformedRequest),
            signal: streamWatchdog.signal,
          },
          streamWatchdog.signal,
          '流式请求（reasoning 降级）',
        )
        if (!response.ok) {
          const retryErrorText = await response.text()
          console.error(`[CompatibleClient] HTTP 错误: ${response.status}`, retryErrorText)
          throw new Error(`HTTP ${response.status}: ${retryErrorText}`)
        }
      } else {
        console.error(`[CompatibleClient] HTTP 错误: ${response.status}`, errorText)
        throw new Error(`HTTP ${response.status}: ${errorText}`)
      }
    }

    console.log(`[CompatibleClient] 收到响应，状态: ${response.status}`)

    // 处理流式响应
    let collectedText = ''
    let thinkingActive = false
    let sawThinking = false
    let lastStopReason: ClaudeStopReason | undefined
    let currentToolCall: {
      id: string
      name: string
      arguments: string
      thoughtSignature?: string
      openai2Reasoning?: { id?: string; encrypted_content: string }
      eagerInput?: Record<string, unknown>
      /** Shared throttle state for `onToolInputDelta` — see `./toolInputDeltaThrottle.ts`. */
      inputDeltaThrottle: ToolInputDeltaThrottleState
    } | null = null
    // F1 — reasoning item captured from the stream, waiting for the next
    // tool_use block to attach to (Responses emits reasoning BEFORE the
    // function_call it belongs to). Cleared once attached; discarded at
    // stream end when no tool call followed (final-text reasoning does not
    // need replay — the turn is over).
    let pendingOpenai2Reasoning: { id?: string; encrypted_content: string } | null = null
    let emittedToolUseFromStream = false
    // C-grade Write preflight watcher: provider-agnostic state machine that
    // surfaces a rejection the moment a `Write` tool_use's `filePath`
    // becomes extractable from partial JSON. When it fires we abort the
    // SSE reader to stop the gateway from streaming the bulky `content`
    // parameter. See `electron/ai/streamWriteInputWatcher.ts`.
    const writeWatcher = new StreamWriteInputWatcher()
    let cgradeWritePreflightAborted = false
    // Stream-level format lock: detect once on the first structured event and
    // keep using the same transformer for the rest of the stream. Re-detecting
    // per event causes state-machine corruption on gateways that occasionally
    // emit malformed chunks (R6). The `targetFormat` serves as a prior while
    // we wait for the first event.
    let lockedStreamFormat: APIFormat | null = null
    // Orphan `input_json_delta` buffer: some OpenAI-compatible gateways send
    // the first `function.arguments` chunk before (or without) the
    // accompanying `content_block_start`. We buffer the fragment and flush it
    // as soon as the matching tool_use block opens (R9).
    let pendingOrphanArgs: string = ''

    const flushToolCall = (reason: 'block_stop' | 'message_stop'): void => {
      void reason
      if (!currentToolCall || !callbacks.onToolUse) return
      let parsedInput: Record<string, unknown>
      if (currentToolCall.eagerInput) {
        parsedInput = currentToolCall.eagerInput
      } else {
        const { value, meta } = parseToolArgumentsWithMeta(currentToolCall.arguments)
        parsedInput = value
        // Truncated mid-stream (max_tokens cut the `content`/`newString`): tag
        // write/edit tools so the schema refuses to persist a partial file.
        // Two signals:
        //   (a) the argument JSON itself needed truncation repair;
        //   (b) the stream already reported `stop_reason: max_tokens` — some
        //       gateways auto-close a cut-off tool block into VALID-looking
        //       JSON, so a trailing write/edit flushed after that stop_reason
        //       is equally suspect even when it parses cleanly. Properly
        //       closed blocks flush at `content_block_stop`, BEFORE the
        //       stop_reason arrives, so (b) never tags those.
        if (
          (meta.truncationRepaired || lastStopReason === 'max_tokens') &&
          WRITE_EDIT_TOOL_NAMES_FOR_TRUNCATION_GUARD.has(currentToolCall.name)
        ) {
          parsedInput[TRUNCATED_TOOL_ARGS_MARKER_KEY] = true
        }
        // NOTE: the lenient-repair (`jsonrepair`) marker is stamped centrally
        // inside parseToolArgumentsWithMeta, so it already rides on `parsedInput`
        // here (and on every other emission path) — no per-emitter set needed.
      }
      callbacks.onToolUse({
        id: currentToolCall.id,
        name: currentToolCall.name,
        input: parsedInput,
        ...(typeof currentToolCall.thoughtSignature === 'string'
          ? { thoughtSignature: currentToolCall.thoughtSignature }
          : {}),
        ...(currentToolCall.openai2Reasoning
          ? { openai2Reasoning: currentToolCall.openai2Reasoning }
          : {}),
      })
      // ANY successful flush (regardless of whether the upstream sent an
      // explicit `content_block_stop` or only a terminating `message_stop`)
      // means a tool_use was already delivered to the consumer via
      // `onToolUse`. The fallback non-stream-refetch branch below
      // (`!emittedToolUseFromStream`) is a recovery path for upstreams that
      // emit a tool call only in the non-streaming response — flipping this
      // flag here is what prevents that path from re-issuing a request whose
      // response body has already been consumed.
      //
      // Before this fix: `block_stop` set the flag but `message_stop` did
      // not, which meant any transformer that didn't auto-emit
      // `content_block_stop` (notably `claudeToOpenAI.ts` after the
      // auto-stop removal) would fall through to the refetch and crash with
      // `Body is unusable: Body has already been read` because we'd already
      // drained the SSE reader above.
      emittedToolUseFromStream = true
      currentToolCall = null
    }

    if (response.body) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value && value.byteLength > 0) {
            streamWatchdog?.touch()
          }

          buffer += decoder.decode(value, { stream: true })

          // 处理 SSE 事件
          const lines = buffer.split('\n')
          buffer = lines[lines.length - 1]

          for (let i = 0; i < lines.length - 1; i++) {
            const rawLine = lines[i].replace(/\r$/, '')
            const line = rawLine.trim()
            if (!line || line.startsWith(':')) continue

            // SSE 标准允许 `data:` 后无空格；仅匹配 `data: ` 会导致大量网关下发的 JSON 行被跳过，流式文本长度为 0
            let payload: string | null = null
            if (line.startsWith('data:')) {
              payload = line.slice(5).trimStart()
            } else if (line.startsWith('{')) {
              // 部分代理直接输出 NDJSON，无 data: 前缀
              payload = line
            }
            if (payload === null) continue

            if (payload === '[DONE]') {
              console.log(`[CompatibleClient] 流完成`)
              break
            }

            try {
              const event = JSON.parse(payload)
              if (COMPAT_VERBOSE_LOG) {
                console.log(
                  `[CompatibleClient] 收到事件: type=${event.type || event.object}`,
                )
              }

              // Format lock: first structured event wins. On subsequent events
              // we only re-detect when the locked parser returns nothing (the
              // upstream likely switched dialects mid-stream — rare but seen
              // on mixed-format gateways).
              let eventFormat: APIFormat
              if (lockedStreamFormat === null) {
                const detected = detectStreamFormat(event)
                // Prefer the target we negotiated over a weak default when
                // the detector falls back to 'claude' (happens when the
                // gateway omits the `object` field on chunks).
                lockedStreamFormat = detected === 'claude' ? targetFormat : detected
                eventFormat = lockedStreamFormat
                console.log(`[CompatibleClient] 流格式锁定: ${eventFormat}`)
              } else {
                eventFormat = lockedStreamFormat
              }
              const rawStopReason = extractCompatRawStopReason(event, eventFormat)
              if (rawStopReason) {
                lastStopReason = mapCompatStopReason(
                  eventFormat,
                  rawStopReason,
                  emittedToolUseFromStream || Boolean(currentToolCall),
                )
              }

              // 转换事件为 Claude 格式（可能返回单个事件或事件数组）
              let rawResult = transformStreamEvent(event, eventFormat, ctx)
              if (!rawResult) {
                // Locked parser produced nothing. Re-detect once on this event
                // as a safety net; do NOT update the lock — keep the original.
                const redetected = detectStreamFormat(event)
                if (redetected !== eventFormat && redetected !== 'claude') {
                  rawResult = transformStreamEvent(event, redetected, ctx)
                }
              }
              const claudeEvents = Array.isArray(rawResult) ? rawResult : rawResult ? [rawResult] : []

              for (const claudeEvent of claudeEvents) {
                // F1 — opaque reasoning payload from a Responses stream.
                // Park it until the next tool_use block opens.
                if (claudeEvent.type === 'openai2_reasoning_item' && claudeEvent.reasoning) {
                  pendingOpenai2Reasoning = claudeEvent.reasoning as {
                    id?: string
                    encrypted_content: string
                  }
                  continue
                }

                // 文本增量
                if (claudeEvent.type === 'content_block_delta' && claudeEvent.delta?.type === 'text_delta') {
                  collectedText += claudeEvent.delta.text
                  callbacks.onTextDelta(claudeEvent.delta.text)
                }

                // 思考增量
                if (claudeEvent.type === 'content_block_delta' && claudeEvent.delta?.type === 'thinking_delta') {
                  if (!thinkingActive) {
                    thinkingActive = true
                    sawThinking = true
                    callbacks.onThinkingStart?.()
                  }
                  callbacks.onThinkingDelta?.(claudeEvent.delta.thinking)
                }

                // 工具调用开始 — 记录当前正在构建的工具
                if (claudeEvent.type === 'content_block_start' && claudeEvent.content_block?.type === 'tool_use') {
                  if (thinkingActive) { callbacks.onThinkingComplete?.(); thinkingActive = false }
                  // Implicit boundary flush: if the previous tool block didn't
                  // emit an explicit `content_block_stop` before this new
                  // `tool_use` start, close it now. This protects against
                  // upstream transformers (and gateways) that omit the stop —
                  // notably the now-removed auto-stop in `claudeToOpenAI.ts`,
                  // and any third-party OpenAI/OpenAI2 proxy that strings
                  // multiple tool_use blocks back-to-back without a
                  // `content_block_stop` between them. Without this, the
                  // assignment below would silently overwrite the previous
                  // `currentToolCall` and lose all of its accumulated args.
                  if (currentToolCall) {
                    flushToolCall('block_stop')
                  }
                  const cb = claudeEvent.content_block as {
                    id: string
                    name: string
                    input?: unknown
                    thoughtSignature?: string
                  }
                  // Capture eager input ONLY when the gateway packs the full
                  // args object into `content_block_start.content_block.input`
                  // (some Anthropic-compat dialects do this). The OpenAI Chat
                  // and OpenAI2 Responses transformers always emit
                  // `input: {}` as a placeholder and stream the real args via
                  // subsequent `input_json_delta` events
                  // (see `claudeToOpenAI.ts:486` and `claudeToOpenAI2.ts:420`),
                  // so an empty `{}` here is NOT eager data — it must NOT
                  // short-circuit `parseToolArguments(arguments)` in
                  // `flushToolCall`. Before this guard, every Write/Agent
                  // tool call routed through openai2-compat arrived with
                  // `{}` and surfaced as
                  // `InputValidationError (write_file): content: expected
                  // string, received undefined` (and the corresponding
                  // `Either prompt or task is required` for Agent), because
                  // the truthy `{}` won the conditional and the accumulated
                  // delta JSON was discarded. Match
                  // `anthropicCompatHttp.ts:727-730` which has the same
                  // non-empty-object guard.
                  let eagerInput: Record<string, unknown> | undefined
                  if (cb.input && typeof cb.input === 'object' && !Array.isArray(cb.input)) {
                    if (Object.keys(cb.input as Record<string, unknown>).length > 0) {
                      eagerInput = cb.input as Record<string, unknown>
                    }
                  } else if (typeof cb.input === 'string' && cb.input.trim()) {
                    try {
                      const parsed = JSON.parse(cb.input)
                      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
                        eagerInput = parsed as Record<string, unknown>
                      }
                    } catch { /* non-JSON */ }
                  }
                  currentToolCall = {
                    id: cb.id,
                    name: cb.name,
                    arguments: pendingOrphanArgs,
                    inputDeltaThrottle: createToolInputDeltaThrottleState(),
                    ...(eagerInput ? { eagerInput } : {}),
                    ...(typeof cb.thoughtSignature === 'string' ? { thoughtSignature: cb.thoughtSignature } : {}),
                    // F1 — attach the reasoning item that streamed just before
                    // this tool call; replayed on the next request.
                    ...(pendingOpenai2Reasoning ? { openai2Reasoning: pendingOpenai2Reasoning } : {}),
                  }
                  pendingOpenai2Reasoning = null
                  // C-grade Write preflight: register the new tool_use block
                  // with the watcher BEFORE its first `input_json_delta` so
                  // an early `filePath` chunk doesn't get dropped as
                  // "block unknown". Uses index 0 as the synthetic key —
                  // the gateway path doesn't carry the Anthropic
                  // `event.index` reliably; we route by tool_use_id via
                  // `feedInputJsonDeltaById` instead.
                  writeWatcher.registerToolUseBlock(0, {
                    id: cb.id,
                    name: cb.name,
                  })
                  // If the gateway packed the full args eagerly into
                  // `content_block_start.content_block.input`, the watcher
                  // never sees an `input_json_delta` — feed the eager args
                  // through `feedInputJsonDeltaById` once now so the
                  // preflight still fires in this dialect.
                  if (eagerInput && callbacks.onToolUse) {
                    const eagerJson = JSON.stringify(eagerInput)
                    const rej = writeWatcher.feedInputJsonDeltaById(cb.id, eagerJson)
                    if (rej) {
                      try {
                        callbacks.onToolUse(rej.toolUse)
                      } catch {
                        /* listener errors must not survive into the abort path */
                      }
                      emittedToolUseFromStream = true
                      currentToolCall = null
                      cgradeWritePreflightAborted = true
                    }
                  }
                  pendingOrphanArgs = ''
                }

                // 工具参数增量
                if (claudeEvent.type === 'content_block_delta' && claudeEvent.delta?.type === 'input_json_delta') {
                  const fragment = claudeEvent.delta.partial_json || ''
                  if (currentToolCall) {
                    currentToolCall.arguments += fragment
                    // Defensive downgrade: if we previously thought the input
                    // was eager (gateway sent a non-empty object in
                    // `content_block_start`) but deltas still arrive, the
                    // eager object was incomplete — drop it so the flush
                    // path uses the fully-streamed arguments instead. Same
                    // pattern as `anthropicCompatHttp.ts:798-800`.
                    if (currentToolCall.eagerInput && fragment.length > 0) {
                      currentToolCall.eagerInput = undefined
                    }
                    // C-grade Write preflight: feed the watcher; if it
                    // surfaces a rejection (any existing file on disk), emit
                    // the synthetic tool_use NOW with just the parsed
                    // `filePath`, mark the stream as "tool already emitted"
                    // so the non-stream refetch fallback below is skipped,
                    // and cancel the SSE reader to stop the gateway from
                    // streaming the bulky `content` arg.
                    if (fragment.length > 0 && callbacks.onToolUse) {
                      const rej = writeWatcher.feedInputJsonDeltaById(
                        currentToolCall.id,
                        fragment,
                      )
                      if (rej) {
                        try {
                          callbacks.onToolUse(rej.toolUse)
                        } catch {
                          /* listener errors must not survive into the abort path */
                        }
                        emittedToolUseFromStream = true
                        currentToolCall = null
                        cgradeWritePreflightAborted = true
                        break
                      }
                    }
                    // IDE-style live writing: surface the running
                    // partial-JSON buffer to the renderer through the
                    // shared throttle. We do this AFTER the preflight
                    // gate above — if the watcher already aborted, the
                    // gateway is being torn down and a final
                    // `tool_input_delta` would just race the synthetic
                    // tool_use error. Gated by `onToolInputDelta`
                    // presence so paths that don't subscribe pay no
                    // overhead.
                    if (callbacks.onToolInputDelta && currentToolCall) {
                      const now = Date.now()
                      if (
                        shouldEmitToolInputDelta(
                          currentToolCall.inputDeltaThrottle,
                          currentToolCall.arguments.length,
                          now,
                        )
                      ) {
                        currentToolCall.inputDeltaThrottle.lastEmitAt = now
                        currentToolCall.inputDeltaThrottle.lastEmittedLength =
                          currentToolCall.arguments.length
                        callbacks.onToolInputDelta({
                          toolUseId: currentToolCall.id,
                          toolName: currentToolCall.name,
                          partialJson: currentToolCall.arguments,
                        })
                      }
                    }
                  } else {
                    // Orphan delta — gateway streamed arguments before (or
                    // without) the content_block_start. Buffer; flushed when
                    // the next `tool_use` start event arrives.
                    pendingOrphanArgs += fragment
                  }
                }

                // 内容块结束 — 如果有正在构建的工具调用，报告它
                if (claudeEvent.type === 'content_block_stop') {
                  // Final force-flush of the throttled partial-JSON
                  // tail BEFORE `flushToolCall` ships `tool_start` —
                  // mirrors the anthropic-compat-http behaviour so the
                  // last `tool_input_delta` carries a fully-closed
                  // object and the live-writing card transitions
                  // smoothly into the canonical `tool_use.input`.
                  if (
                    callbacks.onToolInputDelta &&
                    currentToolCall &&
                    hasPendingThrottledTail(
                      currentToolCall.inputDeltaThrottle,
                      currentToolCall.arguments.length,
                    )
                  ) {
                    callbacks.onToolInputDelta({
                      toolUseId: currentToolCall.id,
                      toolName: currentToolCall.name,
                      partialJson: currentToolCall.arguments,
                    })
                  }
                  flushToolCall('block_stop')
                }

                // 消息结束
                if (claudeEvent.type === 'message_stop') {
                  if (thinkingActive) { callbacks.onThinkingComplete?.(); thinkingActive = false }
                  // Same force-flush invariant for gateways that elide
                  // `content_block_stop` and only signal `message_stop`.
                  if (
                    callbacks.onToolInputDelta &&
                    currentToolCall &&
                    hasPendingThrottledTail(
                      currentToolCall.inputDeltaThrottle,
                      currentToolCall.arguments.length,
                    )
                  ) {
                    callbacks.onToolInputDelta({
                      toolUseId: currentToolCall.id,
                      toolName: currentToolCall.name,
                      partialJson: currentToolCall.arguments,
                    })
                  }
                  flushToolCall('message_stop')
                }
              }
            } catch (e) {
              console.warn(`[CompatibleClient] 事件解析失败:`, e)
            }
            if (cgradeWritePreflightAborted) break
          }
          if (cgradeWritePreflightAborted) break
        }
      } finally {
        reader.releaseLock()
      }
      releaseFetchResponseBody(response)

      // Flush any remaining tool call (EOS without explicit message_stop).
      // Suppressed on a C-grade abort: the synthetic tool_use is already in
      // flight via `callbacks.onToolUse`, and `currentToolCall` was nulled
      // when the watcher fired, so flushing here would no-op anyway — the
      // explicit guard documents the intent and prevents a future change
      // from accidentally re-emitting.
      if (!cgradeWritePreflightAborted) {
        if (
          callbacks.onToolInputDelta &&
          currentToolCall &&
          hasPendingThrottledTail(
            currentToolCall.inputDeltaThrottle,
            currentToolCall.arguments.length,
          )
        ) {
          callbacks.onToolInputDelta({
            toolUseId: currentToolCall.id,
            toolName: currentToolCall.name,
            partialJson: currentToolCall.arguments,
          })
        }
        flushToolCall('message_stop')
      }

      console.log(`[CompatibleClient] 流处理完成，收集文本长度: ${collectedText.length}`)
    }

    // 流式处理已完成；如果流中包含了工具调用，需要获取完整响应来解析
    // 只有在流中没有收到文本且可能有工具调用时才发送非流式请求
    if (
      !collectedText &&
      callbacks.onToolUse &&
      !emittedToolUseFromStream &&
      lastStopReason !== 'max_tokens'
    ) {
      console.log(`[CompatibleClient] 流中未收到文本，尝试非流式请求获取完整响应`)
      const nonStreamPath = getEndpointPath(config.baseUrl || '', targetFormat, params.model, false)
      const nonStreamUrl = targetFormat === 'gemini'
        ? `${nonStreamPath}?key=${encodeURIComponent(config.apiKey)}`
        : nonStreamPath
      const finalResponse = await fetchWithRetry(
        nonStreamUrl,
        {
          method: 'POST',
          headers: fetchHeaders,
          body: JSON.stringify({ ...transformedRequest, stream: false }),
          signal: streamWatchdog.signal,
        },
        streamWatchdog.signal,
        '非流式补拉',
      )

      if (finalResponse.ok) {
        const finalData = await finalResponse.json()
        const responseFormat = detectResponseFormat(finalData)
        // `transformResponse` returns `ClaudeResponse | unknown` (the
        // pass-through branch when source is already Claude); narrow here.
        const claudeResponse = transformResponse(finalData, responseFormat, ctx) as
          | import('./transformer/types').ClaudeResponse
          | undefined
        if (claudeResponse?.content) {
          if (typeof claudeResponse.stop_reason === 'string' && claudeResponse.stop_reason.length > 0) {
            lastStopReason = claudeResponse.stop_reason as ClaudeStopReason
          }
          for (const block of claudeResponse.content) {
            if (block.type === 'tool_use') {
              console.log(`[CompatibleClient] 报告工具调用: ${block.name}`)
              const tu = block as { id: string; name: string; input: unknown; thoughtSignature?: string }
              callbacks.onToolUse({
                id: tu.id,
                name: tu.name,
                input: tu.input as Record<string, unknown>,
                ...(typeof tu.thoughtSignature === 'string' ? { thoughtSignature: tu.thoughtSignature } : {}),
              })
            } else if (block.type === 'text' && block.text) {
              collectedText += block.text
              callbacks.onTextDelta(block.text)
            }
          }
        }
      }
    }

    // 报告消息结束
    const tokens = estimateTokens(
      JSON.stringify(transformedRequest),
      collectedText,
      0,
      0
    )

    if (emittedToolUseFromStream) {
      lastStopReason = 'tool_use'
    } else if (!lastStopReason && sawThinking && collectedText.length === 0) {
      lastStopReason = 'max_tokens'
    }

    callbacks.onMessageEnd({
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      ...(lastStopReason ? { stopReason: lastStopReason } : {}),
    })

    console.log(`[CompatibleClient] 流处理完成`)
    return
  } catch (error) {
    console.error(`[CompatibleClient] 错误:`, error)
    // First-activity (TTFB) timeout is *technically* an abort, but it must
    // NOT be silently swallowed as a clean `onMessageEnd` — it means the
    // gateway never even sent headers, so the sub-agent / main turn would
    // appear to "succeed with empty output" and the parent loop would
    // happily continue with no signal that the model never replied.
    //
    // Detect it via the marker text we put in the abort reason. The
    // marker can show up in either `error.message` (when fetch surfaces
    // `signal.reason` directly) or `error.cause.message` (when fetch
    // wraps the abort in its own AbortError and stashes the original
    // reason in `cause`, which is the more common shape under Node fetch
    // / undici). Checking both keeps the diagnosis correct regardless of
    // how the runtime surfaces the abort.
    const errorMsgPreview =
      error instanceof Error ? error.message : String(error ?? '')
    const errorCause = (error as { cause?: unknown } | null)?.cause
    const causeMsgPreview =
      errorCause instanceof Error
        ? errorCause.message
        : typeof errorCause === 'string'
          ? errorCause
          : ''
    const FIRST_ACTIVITY_RE = /first-activity timeout/i
    const isFirstActivityTimeout =
      FIRST_ACTIVITY_RE.test(errorMsgPreview) ||
      FIRST_ACTIVITY_RE.test(causeMsgPreview)
    if (isAbortLikeError(error) && !isFirstActivityTimeout) {
      console.log(`[CompatibleClient] 请求被中止`)
      userCallbacks.onMessageEnd()
      return
    }

    // Phase 4 (upstream alignment): classify error into a typed LoopSignal
    // envelope, emit to `onLoopSignal`, and mirror PTL kind to the legacy
    // `contextLengthExceededRef` so the loop's reactive-compact block
    // sees `result.contextLengthExceeded === true`. Single classification
    // — no regex on the rendered error message.
    const { isPromptTooLong } = emitProviderErrorSignal(
      error,
      'compat',
      userCallbacks,
      params.contextLengthExceededRef,
    )
    if (isPromptTooLong) {
      return
    }

    // A1 — mid-stream retry decision. We only retry when:
    //   1. No callback has fired yet (no double-emission risk).
    //   2. Attempts left.
    //   3. The error fits the broadened transient-failure predicate, OR
    //      the error is a first-activity (TTFB) timeout — the upstream
    //      gateway is queueing the request and a backoff retry has a
    //      reasonable chance to land on a freed slot.
    const retryable =
      !hasEmittedAnything &&
      attempt < maxAttempts &&
      (isFirstActivityTimeout || isRetryableStreamHttpError(error))
    if (retryable) {
      const delay = Math.min(600 * 2 ** (attempt - 1), 5_000)
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(
        `[CompatibleClient] mid-stream retry attempt ${attempt}/${maxAttempts} after ${delay}ms — ${reason}`,
      )
      streamWatchdog?.dispose()
      streamWatchdog = undefined
      try {
        await sleepAbortable(delay, signal)
      } catch {
        userCallbacks.onMessageEnd()
        return
      }
      continue
    }

    const err = error as { message?: string; status?: number }
    let errorMessage = formatCompatibleClientNetworkError(error)
    if (err.status === 401) errorMessage = '无效的 API 密钥'
    else if (err.status === 429) errorMessage = '请求过于频繁，请稍后重试'
    else if (err.status === 500 || err.status === 503) errorMessage = '服务器错误'
    else if (isFirstActivityTimeout) {
      // Override the generic 'Aborted' / 'AbortError' surface that
      // `formatCompatibleClientNetworkError` produces — a TTFB timeout
      // means the gateway never sent headers, and the user/agentic loop
      // need that diagnostic to retry sensibly. Pulling the exact reason
      // out of `error.cause` (the watchdog's authored message) keeps
      // the actionable advice visible all the way up to the UI.
      const rawReason =
        causeMsgPreview ||
        (FIRST_ACTIVITY_RE.test(errorMsgPreview) ? errorMsgPreview : '')
      errorMessage =
        rawReason ||
        '上游网关未在阈值内开始返回响应（first-activity timeout）。' +
          '常见于第三方网关同 API Key 并发过多被排队，请稍后重试或降低并发。'
    }

    console.error(`[CompatibleClient] 最终错误消息: ${errorMessage}`)
    userCallbacks.onError(errorMessage)
    return
  } finally {
    streamWatchdog?.dispose()
    streamWatchdog = undefined
  }
  }
}

/**
 * 根据目标格式和 baseUrl 构造完整的端点 URL
 *
 * 参考 ccNexus getTargetPath：
 * - openai  → /v1/chat/completions
 * - openai2 → /v1/responses
 * - gemini  → /v1beta/models/{model}:streamGenerateContent
 */
function getEndpointPath(baseUrl: string, format: APIFormat, model?: string, isStreaming = true): string {
  const base = baseUrl.replace(/\/+$/, '')

  switch (format) {
    case 'openai':
      return base.endsWith('/v1')
        ? `${base}/chat/completions`
        : `${base}/v1/chat/completions`
    case 'openai2':
      return base.endsWith('/v1')
        ? `${base}/responses`
        : `${base}/v1/responses`
    case 'gemini': {
      const action = isStreaming ? 'streamGenerateContent' : 'generateContent'
      return `${base}/v1beta/models/${model || 'gemini-2.5-pro'}:${action}`
    }
    default:
      return base.endsWith('/v1')
        ? `${base}/chat/completions`
        : `${base}/v1/chat/completions`
  }
}

/**
 * 检测端点格式
 *
 * 参考 ccNexus 架构：第三方中转通常同时支持所有格式
 * （/v1/chat/completions、/v1/responses、/v1beta/models/{model}:streamGenerateContent）
 * 因此直接尊重用户选择的 provider 类型作为目标格式。
 * 只有 provider=compatible 时才从 URL 启发式推断。
 */
function detectEndpointFormat(baseUrl: string, providerId?: string): APIFormat {
  // 用户明确选择的 provider 直接映射到对应格式
  if (providerId === 'openai' || providerId === 'openai2' || providerId === 'gemini') {
    return providerId as APIFormat
  }

  // compatible / 其他：从 URL 启发式推断
  const url = (baseUrl || '').toLowerCase()

  if (url.includes('generativelanguage.googleapis.com')) {
    return 'gemini'
  }

  // 默认为 OpenAI Chat（最广泛兼容的格式）
  return 'openai'
}

/**
 * 没有原生 SDK 处理器的 provider，必须走兼容格式客户端
 */
const PROVIDERS_REQUIRING_COMPATIBLE: Set<string> = new Set(['openai2', 'compatible'])

/**
 * 必须使用 `client.ts` 里 @anthropic-ai/sdk 的 `messages.stream`（Anthropic Messages 协议），
 * 绝不能走 `streamCompatibleFormat`：
 * - 兼容层对非 Gemini 使用 `Authorization: Bearer` + `/v1/chat/completions`；
 *   Anthropic 兼容网关要 `X-Api-Key`（等）+ `/v1/messages`，否则会 401「无效 API Key」。
 * - 自建反代（如 `http://ip:port/v1`）若 provider 选 Anthropic 且开启「自动检测格式」，
 *   以前会误判走 OpenAI 形态 —— 仍必须走 SDK。
 */
const PROVIDERS_ANTHROPIC_MESSAGES_VIA_SDK: Set<string> = new Set([
  'anthropic',
  'bedrock',
  'vertex',
  'foundry',
  'dashscope',
  'minimax',
  'zhipu',
  'kimi',
  'deepseek',
])

/**
 * 检查是否应该使用兼容格式客户端
 *
 * 触发条件（满足任一即可）：
 * 1. provider 是 openai2 / compatible —— 没有原生 SDK 分支，必须走转换
 * 2. autoDetectFormat=true 且配置了非 Anthropic 官方的 baseUrl（且 provider 不是上表 Messages 系）
 */
export function shouldUseCompatibleClient(config: Pick<ProviderConfig, 'id' | 'autoDetectFormat' | 'baseUrl'>): boolean {
  const provider: string = config.id || ''
  console.log(`[shouldUseCompatibleClient] 检查条件: provider=${provider}, autoDetectFormat=${config.autoDetectFormat}, baseUrl=${config.baseUrl}`)

  if (PROVIDERS_ANTHROPIC_MESSAGES_VIA_SDK.has(provider)) {
    console.log(
      `[shouldUseCompatibleClient] provider "${provider}" 使用 Anthropic Messages SDK，不走兼容客户端`,
    )
    return false
  }

  if (PROVIDERS_REQUIRING_COMPATIBLE.has(provider)) {
    console.log(`[shouldUseCompatibleClient] provider "${provider}" 必须使用兼容客户端`)
    return true
  }

  if (config.autoDetectFormat && config.baseUrl && config.baseUrl.trim()) {
    const isCompatible = isCompatibleEndpoint(config.baseUrl)
    console.log(`[shouldUseCompatibleClient] autoDetectFormat 已启用，baseUrl 是兼容端点: ${isCompatible}`)
    return isCompatible
  }

  console.log(`[shouldUseCompatibleClient] 不需要兼容客户端，返回 false`)
  return false
}

/**
 * 检查 baseUrl 是否为兼容格式的端点
 * 任何非空的自定义 baseUrl 都被认为是兼容端点
 */
function isCompatibleEndpoint(baseUrl: string): boolean {
  if (!baseUrl || !baseUrl.trim()) return false

  // 排除官方 Anthropic 端点
  const url = baseUrl.toLowerCase()
  if (url.includes('api.anthropic.com')) return false

  // 任何其他 baseUrl 都被认为是兼容端点
  return true
}
