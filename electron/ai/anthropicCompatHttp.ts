/**
 * Anthropic Messages-compatible HTTP client for third-party gateways.
 *
 * Why this exists — the `@anthropic-ai/sdk` is strict about the SSE dialect
 * it accepts: `event: <name>` + `data: <json>` + blank-line frame. Nearly
 * every Chinese / self-hosted Anthropic-compatible gateway (云雾,
 * packycode, aicodemirror, yourapi, SiliconFlow's Anthropic surface, etc.)
 * has at least one dialect quirk:
 *   - Missing `event:` line, only `data: {...}`
 *   - Line-delimited JSON without `data:` prefix (NDJSON)
 *   - `content_block_start` that already contains the full `tool_use.input`
 *     instead of streaming it via `input_json_delta`
 *   - No `message_stop` — close-of-stream signals completion
 *   - `tool_use.input` serialized as a JSON string
 *   - Arbitrary non-Anthropic fields mixed in (silently ignored here)
 *
 * The SDK's parser drops dialect-ish frames on the floor, leading to the
 * observed symptom of "streams finish with no text and no tool_use visible".
 *
 * This module accepts all of the above. The request body / response shape
 * follows Anthropic Messages faithfully; only the wire parsing and dialect
 * tolerance differ.
 */

import type {
  ProviderConfig,
  StreamCallbacks,
  StreamMessageUsage,
  StreamTextParams,
} from './client'
import { buildAnthropicSystemParam } from './anthropicSystemWire'
import { stripMessageContentCacheControls } from './anthropicMessagePromptCache'
import { stripPoleContextUsageFromApiMessages } from '../context/tokenUsageAccounting'
import { emitProviderErrorSignal } from './loopSignalEmit'
import { applyAnthropicApiMessageInvariants } from '../context/apiMessageInvariants'
import { ensureToolUseResultPairing } from '../context/ensureToolUseResultPairing'
import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'
import { isAbortLikeError } from './abortLikeError'
import { mergeUserSignalWithStreamWatchdog, type StreamWatchdogHandle } from './streamWatchdog'
import {
  streamWithMidStreamRetry,
  wrapCallbacksForEmissionTracking,
} from './streamWithMidStreamRetry'
import { releaseFetchResponseBody } from './releaseStreamResources'
import { buildAnthropicThinkingForStreamRequest } from './anthropicExtendedThinking'
import { sanitizeToolsForWire } from './toolSchemaSanitizer'
import { sanitizeMessagesForWire } from '../utils/unicodeSanitize'
import { parseToolArgumentsWithMeta } from './transformer/parseToolArguments'
import {
  TRUNCATED_TOOL_ARGS_MARKER_KEY,
  WRITE_EDIT_TOOL_NAMES_FOR_TRUNCATION_GUARD,
} from '../tools/toolInputZod'
import {
  createToolInputDeltaThrottleState,
  hasPendingThrottledTail,
  shouldEmitToolInputDelta,
  type ToolInputDeltaThrottleState,
} from './toolInputDeltaThrottle'
import {
  dashscopeModelSupportsThinking,
  getProviderQuirks,
  modelLikelySupportsVision,
} from './providerQuirks'
import { mapStopReasonToClaude } from './stopReasonMap'
import { StreamWriteInputWatcher } from './streamWriteInputWatcher'
import { createThinkingStreamAccumulator } from './thinkingBlockAccumulator'
import { AnthropicCompatStreamNormalizer } from './anthropicCompatStreamNormalizer'
import {
  anthropicModelLikelySupportsEffort,
  type SkillEffort,
} from '../skills/skillEffort'

/**
 * Walk every user message and drop any `image` / `document` content block
 * the gateway doesn't support. A short `[system note]` text block is
 * substituted so the model still sees that an attachment was part of the
 * turn — otherwise a dropped PDF looks identical to the user never having
 * attached anything, and the model hallucinates instead of referencing the
 * sibling text preamble.
 *
 * Exported for unit tests.
 */
export function stripUnsupportedMultimodalBlocks(
  messages: Array<Record<string, unknown>>,
  opts: { stripImage: boolean; stripDocument: boolean },
): Array<Record<string, unknown>> {
  if (!opts.stripImage && !opts.stripDocument) return messages
  const out = messages.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg
    const rewritten: Array<Record<string, unknown>> = []
    let droppedImages = 0
    let droppedDocuments = 0
    for (const raw of msg.content as Array<Record<string, unknown>>) {
      const blockType = typeof raw?.type === 'string' ? raw.type : ''
      if (opts.stripImage && blockType === 'image') {
        droppedImages++
        continue
      }
      if (opts.stripDocument && blockType === 'document') {
        droppedDocuments++
        continue
      }
      rewritten.push(raw)
    }
    // v2/H1 fix — wrap stripped-attachment notices in `<system-reminder>`
    // so the model treats them as side-channel context rather than user
    // statements. Previously the bare `[system note] N image attachments
    // were omitted...` text bled into the user turn body, and the model
    // answered "please switch to a vision-capable provider" instead of
    // engaging with the user's actual question. The reminder envelope is
    // exactly what the standing system prompt teaches the model to read
    // as system noise.
    const notes: string[] = []
    if (droppedImages > 0) {
      notes.push(
        `${droppedImages} image attachment${droppedImages > 1 ? 's were' : ' was'} omitted because the selected provider does not accept image content blocks through its Anthropic-compat endpoint. Use a vision-capable provider (e.g. api.anthropic.com / Gemini) to see the picture${droppedImages > 1 ? 's' : ''}.`,
      )
    }
    if (droppedDocuments > 0) {
      notes.push(
        `${droppedDocuments} PDF document block${droppedDocuments > 1 ? 's were' : ' was'} omitted because the selected provider does not support native PDF. The sibling text preamble above still contains the extracted text content of the file.`,
      )
    }
    if (notes.length > 0) {
      rewritten.push({
        type: 'text',
        text: wrapSideChannelBody(
          SIDE_CHANNEL_KIND.attachmentCompat,
          `[Provider attachment compatibility]\n${notes.join('\n')}`,
        ),
      })
    }
    // If stripping wiped the user turn clean, inject a minimal text block so
    // the Anthropic wire validator (requires `content` non-empty) doesn't 400.
    if (rewritten.length === 0) {
      rewritten.push({
        type: 'text',
        text: wrapSideChannelBody(
          SIDE_CHANNEL_KIND.attachmentCompat,
          '[Provider attachment compatibility]\nattachment payload omitted for this provider',
        ),
      })
    }
    return { ...msg, content: rewritten }
  })
  return out
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

function groupAssistantToolUseBlocksAtEnd(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return messages.map((msg) => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg
    const blocks = msg.content as Array<Record<string, unknown>>
    if (!blocks.some((b) => b?.type === 'tool_use')) return msg

    const nonToolUse = blocks.filter((b) => b?.type !== 'tool_use')
    const toolUse = blocks.filter((b) => b?.type === 'tool_use')
    return { ...msg, content: [...nonToolUse, ...toolUse] }
  })
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
      console.warn(
        `[AnthropicCompatHttp] ${label} 第 ${attempt}/${maxAttempts} 次失败，${delay}ms 后重试`,
        e,
      )
      await sleep(delay, signal)
    }
  }
  throw lastError
}

/** `{baseUrl}/v1/messages` — strips user-pasted trailing `/v1` or `/v1/messages`. */
function buildMessagesEndpoint(baseUrl: string): string {
  let u = baseUrl.trim().replace(/\/+$/, '')
  u = u.replace(/\/v1\/messages$/i, '')
  if (u.toLowerCase().endsWith('/v1')) u = u.slice(0, -3)
  u = u.replace(/\/+$/, '')
  return `${u}/v1/messages`
}

// ─── Tolerant SSE / NDJSON parser ──────────────────────────────────────

/**
 * Parsed frame emitted by the tolerant reader. We don't retain the `event:`
 * name — the downstream dispatcher uses the `type` inside the JSON body.
 */
interface ParsedFrame {
  data: string
}

/**
 * Read a stream body as a sequence of JSON payload strings. Accepts:
 *   - Standard SSE (`event: …\ndata: {…}\n\n`)
 *   - NDJSON (`{…}\n{…}\n`)
 *   - Multi-line `data:` continuations (per SSE spec)
 *   - `[DONE]` terminator
 *   - Leading BOM / stray whitespace
 */
async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  watchdog: StreamWatchdogHandle | undefined,
): AsyncGenerator<ParsedFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) watchdog?.touch()
      buffer += decoder.decode(value, { stream: true })

      // Process complete lines; retain the trailing fragment.
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''

      let dataAccum = ''
      for (const raw of lines) {
        const line = raw.replace(/\uFEFF/g, '').trim()
        if (line.length === 0) {
          // Blank line: SSE frame boundary. Flush accumulated data.
          if (dataAccum.length > 0) {
            yield { data: dataAccum }
            dataAccum = ''
          }
          continue
        }
        if (line.startsWith(':')) continue // SSE comment
        if (line.startsWith('event:')) continue // ignore event name — type lives inside the JSON

        if (line.startsWith('data:')) {
          // Preserve the SSE "multi-line data" joining semantics.
          const payload = line.slice(5).replace(/^ /, '')
          dataAccum = dataAccum.length > 0 ? `${dataAccum}\n${payload}` : payload
          continue
        }

        // Dialect: NDJSON without `data:` prefix. Treat each `{…}` / `[…]` as
        // its own frame immediately.
        if (line.startsWith('{') || line.startsWith('[')) {
          if (dataAccum.length > 0) {
            yield { data: dataAccum }
            dataAccum = ''
          }
          yield { data: line }
          continue
        }

        // Unknown line — skip.
      }
      if (dataAccum.length > 0) {
        yield { data: dataAccum }
      }
    }

    // Stream closed: flush residual buffer if it's a complete JSON object.
    const tail = buffer.trim()
    if (tail.length > 0 && (tail.startsWith('{') || tail.startsWith('['))) {
      yield { data: tail }
    }
  } finally {
    reader.releaseLock()
  }
}

async function* readNormalizedAnthropicEvents(
  body: ReadableStream<Uint8Array>,
  watchdog: StreamWatchdogHandle | undefined,
): AsyncGenerator<Record<string, unknown>> {
  const normalizer = new AnthropicCompatStreamNormalizer()
  for await (const frame of readSseFrames(body, watchdog)) {
    const payload = frame.data.trim()
    if (payload.length === 0) continue
    if (payload === '[DONE]') break

    let rawEvent: Record<string, unknown>
    try {
      rawEvent = JSON.parse(payload) as Record<string, unknown>
    } catch {
      continue
    }

    for (const event of normalizer.normalize(rawEvent)) yield event
  }
}

// ─── Core stream entry ─────────────────────────────────────────────────

/**
 * Stream a request to an Anthropic Messages-compatible third-party gateway
 * using a fetch-based client with a tolerant SSE parser.
 *
 * Usage is identical to `streamAnthropic` / `streamCompatibleFormat` —
 * callbacks fire for text / tool_use / thinking / message_end, signal is
 * merged with the stream watchdog, transient fetch failures retry with
 * exponential backoff.
 */
export async function streamAnthropicCompatHttp(
  config: ProviderConfig,
  params: StreamTextParams,
  callbacks: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  // A1 — `streamWatchdog` is now allocated per attempt INSIDE the
  // mid-stream retry closure so a watchdog-induced abort on attempt N
  // doesn't poison the merged signal for attempt N+1.
  let streamWatchdog: StreamWatchdogHandle | undefined
  try {
    const quirks = getProviderQuirks(config)
    const baseUrl = (config.baseUrl ?? '').trim()
    if (!baseUrl) {
      // P0 audit fix: pre-stream config-validation failure must also surface
      // a typed envelope so the stream phase's final-promotion (which keys
      // off `state.withheldStreamSignal`) can route this to a terminal
      // model_error. Classify against the synthesised message — there is
      // no underlying SDK error to inspect.
      const msg = `${config.name}: 需要 baseUrl 才能使用 Anthropic 兼容端点`
      emitProviderErrorSignal(msg, 'compat', callbacks)
      callbacks.onError(msg)
      return
    }

    // Build messages list. The agentic loop has already run the pairing +
    // thinking normalization; we only strip pole-tracking metadata here.
    const messages = params.apiMessages
      ? (stripPoleContextUsageFromApiMessages(params.apiMessages) ?? params.apiMessages)
      : params.messages.map((m) => ({
          role: m.role,
          content: m.content,
        }))

    // Always strip `cache_control` for compat gateways — they don't implement
    // prompt caching and passing the field usually errors with "unknown key".
    let scrubbedMessages = JSON.parse(JSON.stringify(messages)) as Array<Record<string, unknown>>
    stripMessageContentCacheControls(scrubbedMessages as unknown as Parameters<typeof stripMessageContentCacheControls>[0])

    // Multimodal stripping policy.
    //
    // **Images (`type:'image'`): model-aware decision.**
    //
    // Earlier this file followed a hard "always strip when
    // `supportsImageBlocks` is false" rule, then swung to "always forward
    // and let the gateway 400". Both extremes hit production failures:
    //   - Always-strip silently dropped images on Qwen-VL / GLM-4V /
    //     Moonshot-Vision (the user would say "look at the screenshot"
    //     and the assistant replied "I can't see anything" even though
    //     the gateway would have accepted the bytes).
    //   - Always-forward made the symptoms WORSE on DashScope's
    //     Anthropic-compat endpoint: instead of the documented HTTP 400
    //     "unknown content block type", the upstream simply RST'd the
    //     TLS connection (ECONNRESET) on the first attempt and then HUNG
    //     for 90s on the retry — the retry never got headers back, only
    //     the new TTFB watchdog rescued the call. Users saw a multi-
    //     minute freeze with no actionable error.
    //
    // The fix splits the decision by `quirks.supportsImageBlocks` AND
    // the active model name:
    //   - quirks say native support → forward.
    //   - quirks say no native support, but `modelLikelySupportsVision`
    //     recognises the model id (claude-* / *-vl* / *vision* /
    //     gpt-4o / glm-?Nv / etc.) → forward (gateway probably routes it
    //     correctly even though the quirks table is conservative).
    //   - otherwise → strip and let
    //     `stripUnsupportedMultimodalBlocks` insert a `<system-reminder>`
    //     so the model knows what happened. Strip is the only safe
    //     choice for "non-vision model on a non-vision-default gateway"
    //     because the upstream may hang instead of surfacing a clean 4xx.
    //
    // **Documents (`type:'document'`, native PDF): strip when unsupported.**
    //
    // Unchanged from before — the sibling text preamble (pdfjs / Office
    // extract) carries the content for every compat gateway.
    const modelMaybeVision = modelLikelySupportsVision(params.model)
    const forwardImages = quirks.supportsImageBlocks || modelMaybeVision
    const effectiveStripImage = !forwardImages
    if (effectiveStripImage || !quirks.supportsDocumentBlocks) {
      scrubbedMessages = stripUnsupportedMultimodalBlocks(scrubbedMessages, {
        stripImage: effectiveStripImage,
        stripDocument: !quirks.supportsDocumentBlocks,
      })
    }
    // Outer-scoped so the 400 image-rejection fallback (below the stream
    // pass) knows whether this request actually carried image blocks.
    let forwardedImageCount = 0
    if (forwardImages) {
      const imageCount = scrubbedMessages.reduce((n, m) => {
        const c = (m as { content?: unknown }).content
        if (!Array.isArray(c)) return n
        return n + (c as Array<Record<string, unknown>>).filter((b) => b.type === 'image').length
      }, 0)
      forwardedImageCount = imageCount
      if (imageCount > 0 && !quirks.supportsImageBlocks) {
        // We're forwarding *despite* the quirks table being conservative —
        // it relied on `modelLikelySupportsVision` to override. Keep the
        // log so a 400 from the gateway is easy to diagnose.
        console.log(
          `[AnthropicCompatHttp] forwarding ${imageCount} image block(s) to ${config.id} gateway (model=${params.model ?? '?'}, vision-heuristic=true). If the gateway returns 400 "unknown content block type", the selected model probably doesn't support vision on this endpoint.`,
        )
      }
    } else {
      // Strip-path notice: tell developers the image was dropped and why,
      // so the symptom "model says it can't see the image" is debuggable
      // from the terminal alone.
      const inputImageCount = (messages as Array<Record<string, unknown>>).reduce(
        (n, m) => {
          const c = (m as { content?: unknown }).content
          if (!Array.isArray(c)) return n
          return (
            n +
            (c as Array<Record<string, unknown>>).filter((b) => b.type === 'image')
              .length
          )
        },
        0,
      )
      if (inputImageCount > 0) {
        console.log(
          `[AnthropicCompatHttp] stripping ${inputImageCount} image block(s) for ${config.id} gateway (model=${params.model ?? '?'}) — gateway lacks native image support and model name does not look like a vision SKU. The model receives a <system-reminder> noting the strip; switch to a vision-capable model (e.g. qwen-vl-* / glm-4v / claude-* / gpt-4o) or a vision-native provider to send the image.`,
        )
      }
    }

    // Defensive last-mile invariants. Upstream `agenticLoop` already runs
    // these, but this client is exported as a general-purpose streaming
    // surface; callers that bypass the loop (tests, one-shot side queries,
    // future refactors) would otherwise send messages that fail basic
    // Anthropic validation. Applying them here is cheap and idempotent
    // (audit Bug 9).
    //
    // DeepSkip strict echo: when `thinkingRequiresHistoryEcho` is true we
    // must NOT append trailing empty text blocks to historical thinking
    // turns — the gateway 400s if thinking blocks are altered.
    scrubbedMessages = ensureToolUseResultPairing(scrubbedMessages)
    scrubbedMessages = applyAnthropicApiMessageInvariants(
      scrubbedMessages,
      quirks.thinkingRequiresHistoryEcho,
    )
    scrubbedMessages = groupAssistantToolUseBlocksAtEnd(scrubbedMessages)

    // Wire-boundary backstop for lone UTF-16 surrogates. Any string field
    // anywhere in `scrubbedMessages` that contains an unpaired surrogate
    // (typically produced by a `.slice()` upstream that cut between the
    // high and low halves of an emoji / CJK-Extension-B character) is
    // rewritten to use U+FFFD instead. Without this, strict serde_json
    // gateways reject the request with HTTP 400 "unexpected end of hex
    // escape" the moment they read the lone `\uD8xx` in our body — even
    // though our JSON is itself spec-compliant. See `unicodeSanitize.ts`.
    // No-op when the tree is already clean (returns the same reference).
    scrubbedMessages = sanitizeMessagesForWire(scrubbedMessages)

    // System: quirks.systemMustBeString is true for compat gateways; coerce
    // the text-block array form to a joined string.
    let systemField: string | Array<Record<string, unknown>> | undefined
    const systemWire = buildAnthropicSystemParam(
      params.systemPrompt,
      params.systemPromptLayers,
    )
    if (Array.isArray(systemWire)) {
      if (quirks.systemMustBeString) {
        systemField =
          systemWire
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('\n\n')
            .trim() || undefined
      } else {
        systemField = systemWire as unknown as Array<Record<string, unknown>>
      }
    } else {
      systemField = systemWire ?? params.systemPrompt?.trim() ?? undefined
      if (!systemField) systemField = undefined
    }

    // max_tokens — honour the quirks cap.
    const requestedMaxTokens = params.maxTokens || 8192
    const effectiveMaxTokens =
      quirks.maxTokensCap && requestedMaxTokens > quirks.maxTokensCap
        ? quirks.maxTokensCap
        : requestedMaxTokens

    // Build tools per wire policy.
    const sanitizedTools =
      params.tools && params.tools.length > 0
        ? sanitizeToolsForWire(params.tools, quirks.wire, quirks.maxToolDescriptionChars)
        : undefined

    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: effectiveMaxTokens,
      messages: scrubbedMessages,
      stream: true,
    }
    if (systemField !== undefined) body.system = systemField
    if (sanitizedTools) body.tools = sanitizedTools
    if (params.temperature !== undefined) body.temperature = params.temperature
    if (params.topP !== undefined) body.top_p = params.topP
    if (params.toolChoice) {
      body.tool_choice =
        params.toolChoice === 'auto' || params.toolChoice === 'any'
          ? { type: params.toolChoice }
          : { type: 'tool', name: (params.toolChoice as { name: string }).name }
    }

    let anthropicEffort: SkillEffort | undefined = quirks.supportsEffort ? params.effort : undefined
    if (anthropicEffort && !anthropicModelLikelySupportsEffort(params.model)) {
      anthropicEffort = undefined
    }
    if (anthropicEffort) {
      body.output_config = {
        ...((body.output_config as Record<string, unknown> | undefined) ?? {}),
        effort: anthropicEffort,
      }
    }

    if (quirks.supportsThinkingBlocks) {
      // Most Anthropic-compat gateways advertise thinking provider-wide, so
      // `providerSupportsThinking` is unconditionally true. DashScope is the
      // exception: a few Qwen families (Coder / qwen-long / legacy VL) reject
      // the `thinking` param, so gate it by model name. When the gate says no,
      // `providerSupportsThinking` is false AND the model-name heuristic in
      // `buildAnthropicThinkingForStreamRequest` doesn't recognise Qwen ids
      // either, so no `thinking` field is sent — exactly what we want.
      const providerSupportsThinking =
        quirks.id === 'dashscope' ? dashscopeModelSupportsThinking(params.model) : true
      const thinkingParam = buildAnthropicThinkingForStreamRequest({
        model: params.model,
        maxOutputTokens: effectiveMaxTokens,
        alwaysThinking: params.alwaysThinking,
        providerSupportsThinking,
      })
      if (thinkingParam) body.thinking = thinkingParam
    }
    const url = buildMessagesEndpoint(baseUrl)
    // Most gateways accept either `x-api-key` or `Authorization: Bearer`;
    // send both to maximize compatibility (official Anthropic ignores the
    // Bearer; gateways that expect Bearer ignore the x-api-key).
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': config.apiKey,
      Authorization: `Bearer ${config.apiKey}`,
    }

    // Per-attempt fetch + body-consume cycle. Wrapped in
    // `streamWithMidStreamRetry` so a transient mid-stream disconnect
    // (TCP RST, gateway hiccup) on attempt N gets re-issued from
    // scratch — provided no callback has emitted yet (the wrapper
    // inhibits retry after first emission to avoid double-output).
    //
    // Extracted as a callable pass (2026-06) so the image-rejection
    // fallback below can re-run the whole cycle once with images
    // stripped — see `IMAGE_CONTENT_REJECTED_RE`.
    type FatalNonRetryable =
      | { kind: 'http'; status: number; message: string }
      | { kind: 'no_body'; message: string }
    const runStreamPass = async (): Promise<FatalNonRetryable | null> => {
      let fatalNonRetryable: FatalNonRetryable | null = null
      await streamWithMidStreamRetry({
        signal,
        label: `AnthropicCompatHttp:${config.name}`,
        runOnce: async (tracker) => {
          // Fresh watchdog per attempt — the merged signal from a
          // previous (aborted) attempt would otherwise be permanently
          // aborted and the next fetch would never start.
          if (streamWatchdog) streamWatchdog.dispose()
          streamWatchdog = mergeUserSignalWithStreamWatchdog(
            signal,
            `[AnthropicCompatHttp] ${config.name} stream`,
          )

          const requestJson = JSON.stringify(body)

          const response = await fetchWithRetry(
            url,
            {
              method: 'POST',
              headers,
              body: requestJson,
              signal: streamWatchdog.signal,
            },
            streamWatchdog.signal,
            '流式请求',
          )

          if (!response.ok) {
            // HTTP-level errors are not mid-stream issues — surface them
            // outside the retry loop so the caller sees a deterministic
            // single message instead of N retries of an auth failure.
            const errorText = await response.text()
            fatalNonRetryable = {
              kind: 'http',
              status: response.status,
              message: formatHttpError(response.status, errorText, config.name),
            }
            return
          }

          if (!response.body) {
            fatalNonRetryable = {
              kind: 'no_body',
              message: `${config.name}: 响应没有 body`,
            }
            return
          }

          const wrappedCallbacks = wrapCallbacksForEmissionTracking(callbacks, tracker)
          await consumeAnthropicStream(response, wrappedCallbacks, streamWatchdog)
        },
      })
      return fatalNonRetryable
    }

    let fatalCheck = await runStreamPass()

    // ── Vision false-positive fallback (2026-06) ─────────────────────────
    // `modelLikelySupportsVision` is deliberately lenient, so a text-only
    // model can occasionally receive image blocks the gateway rejects
    // (production case: DashScope qwen3.7-max → HTTP 400 InvalidParameter
    // "Unexpected item type in content."). Before this fallback the raw
    // HTTP 400 surfaced to the user as the assistant turn. Now: strip the
    // image blocks (which injects the standard `<system-reminder>` notice)
    // and re-run the stream ONCE, so the user gets a real answer plus the
    // model's own explanation that it couldn't see the picture. Safe to
    // re-run: an HTTP-level 400 means zero callbacks have emitted yet.
    if (
      fatalCheck?.kind === 'http' &&
      fatalCheck.status === 400 &&
      forwardedImageCount > 0 &&
      IMAGE_CONTENT_REJECTED_RE.test(fatalCheck.message)
    ) {
      console.warn(
        `[AnthropicCompatHttp] ${config.id} gateway rejected image content blocks ` +
          `(model=${params.model ?? '?'}, HTTP 400). The model is probably text-only on ` +
          `this endpoint — retrying once with ${forwardedImageCount} image block(s) ` +
          `stripped. Pick a vision SKU (e.g. qwen3.7-plus / qwen3-vl-plus / glm-4v) to ` +
          `actually send images.`,
      )
      scrubbedMessages = stripUnsupportedMultimodalBlocks(scrubbedMessages, {
        stripImage: true,
        stripDocument: false,
      })
      body.messages = scrubbedMessages
      fatalCheck = await runStreamPass()
    }

    if (fatalCheck) {
      // Phase 2 (upstream alignment): emit a typed-error envelope so
      // consumers can route HTTP-status-based recovery decisions
      // (e.g. 413 → reactive compact, 401 → auth_failed) without
      // parsing `fatalCheck.message`. For the http branch we synthesize
      // a duck-typed error carrying the raw `response.status`, so the
      // classifier hits its status-first decision path (most reliable).
      const errForSignal =
        fatalCheck.kind === 'http'
          ? { status: fatalCheck.status, message: fatalCheck.message }
          : fatalCheck.message
      emitProviderErrorSignal(errForSignal, 'compat', callbacks)
      callbacks.onError(fatalCheck.message)
      return
    }
  } catch (error) {
    if (isAbortLikeError(error)) {
      // Distinguish user-initiated abort from internal aborts (most
      // commonly the stream watchdog firing after `idleAbortMs` of no
      // activity, e.g. while DNS keeps failing or the upstream gateway
      // hangs on a long retry chain).
      //
      // - User abort: outer `signal` is aborted → silent `onMessageEnd`
      //   is correct (the user explicitly cancelled, they don't need a
      //   red error banner about it).
      // - Internal abort: outer `signal` is NOT aborted (only the
      //   merged signal owned by `streamWatchdog` aborted). Without
      //   surfacing this, the agentic loop sees an empty stream with
      //   neither tools nor text nor `onError`, falls through to the
      //   noTools branch, and terminates as `completed`. The user
      //   perceives this as "main process suddenly disconnected" —
      //   no error, no result, just silence.
      if (signal.aborted) {
        callbacks.onMessageEnd()
        return
      }
      // Watchdog-driven idle abort emits a SYNTHETIC error message (not the
      // raw `error` value, which is just an AbortError). Classify against
      // the synthesized message so the envelope reflects what the consumer
      // actually sees on `onError`.
      const watchdogMessage = `${config.name}: 流式连接被空闲守卫中止（上游长时间无响应；常见原因：DNS 不可解析、网关挂起、代理超时）。请检查网络与 baseUrl 是否可达后重试。`
      emitProviderErrorSignal(watchdogMessage, 'compat', callbacks)
      callbacks.onError(watchdogMessage)
      return
    }
    // Phase 4 (upstream alignment): classify error into a typed LoopSignal
    // envelope, emit to `onLoopSignal`, and mirror PTL kind to the legacy
    // `contextLengthExceededRef`. Single classification — no regex.
    const { isPromptTooLong } = emitProviderErrorSignal(
      error,
      'compat',
      callbacks,
      params.contextLengthExceededRef,
    )
    if (isPromptTooLong) {
      return
    }
    callbacks.onError(formatNetworkError(error, config.name))
  } finally {
    streamWatchdog?.dispose()
  }
}

// ─── Stream consumer ───────────────────────────────────────────────────

interface ToolCallAccumulator {
  id: string
  name: string
  arguments: string
  /**
   * Eager `input` carried by `content_block_start` (some gateways pack part or
   * all of the tool input here instead of streaming it via `input_json_delta`).
   * Retained for the whole block and merged with the parsed delta at flush so
   * mixed-mode gateways (Zhipu / GLM) don't lose eager-only fields.
   */
  eagerInput?: Record<string, unknown>
  thoughtSignature?: string
  /**
   * Coalescing state for `onToolInputDelta` emission (IDE-style
   * live writing). Implementation lives in
   * {@link ./toolInputDeltaThrottle.ts} so the SDK / compat / native
   * Anthropic paths share one source of truth for the window logic.
   */
  inputDeltaThrottle: ToolInputDeltaThrottleState
}

/**
 * Per-block thinking accumulation moved to {@link createThinkingStreamAccumulator}
 * (see `./thinkingBlockAccumulator.ts`) so the SDK path
 * (`providers/anthropic.ts`) can share the same implementation — historically
 * they had divergent inline logic and the SDK path emitted `onThinkingBlock`
 * in a burst at `finalMessage()` resolution, which mis-targeted the
 * renderer's "walk backwards" matching in multi-thinking responses. Both
 * paths now route through the same per-index accumulator.
 */

/**
 * Approximate token count for a thinking block's accumulated text.
 *
 * Why not a real tokenizer: Anthropic's wire format doesn't break out
 * per-block thinking_tokens (it lumps into aggregate `output_tokens`),
 * and bundling tiktoken / a multi-vendor BPE for one cosmetic display
 * field would inflate the renderer bundle by several hundred KB for
 * little gain. The `chars / 4` heuristic is the industry-standard
 * order-of-magnitude estimate; the UI surfaces it with a `~` prefix so
 * users read it as approximate.
 *
 * The denominator deliberately ignores CJK / code-density skew — getting
 * within ±30% is enough to communicate "this was a 100-token quick
 * pondering" vs "this was a 5000-token deliberation". Honest billing
 * estimates need real tokenizers anyway.
 */
function estimateThinkingTokens(text: string): number {
  const len = text.length
  if (len === 0) return 0
  return Math.max(1, Math.round(len / 4))
}

/**
 * Per-content-block reasoning-summary accumulator. Mirrors
 * {@link ThinkingBlockAccumulator} but for the **summary** channel —
 * OpenAI Responses API's safe-to-show TL;DR of the chain of thought.
 *
 * Surfaced as a separate {@link StreamCallbacks.onReasoningSummaryBlock}
 * (not merged into `onThinkingBlock`) because the two streams have
 * different cross-turn semantics: thinking signatures need round-tripping
 * for DeepSeek's Anthropic-compat 400 invariant, summaries never do.
 */
interface ReasoningSummaryAccumulator {
  text: string
  startedAtMs: number
}

async function consumeAnthropicStream(
  response: Response,
  callbacks: StreamCallbacks,
  watchdog: StreamWatchdogHandle | undefined,
): Promise<void> {
  const toolAccumulators = new Map<number, ToolCallAccumulator>()
  const reasoningSummaryAccumulators = new Map<number, ReasoningSummaryAccumulator>()
  // Per-index thinking-block accumulator shared with the SDK path.
  const thinkingAcc = createThinkingStreamAccumulator(callbacks)
  let inputTokens = 0
  let outputTokens = 0
  let cacheCreationInputTokens = 0
  let cacheReadInputTokens = 0
  let stopReason: string | undefined
  let sawMessageStop = false
  let sawText = false
  let sawToolUse = false
  let sawThinking = false

  // C-grade Write preflight: the instant a `write_file` tool_use's `filePath`
  // resolves to an existing file, abort the rest of the stream so the bulky
  // `content` arg never streams (saves output tokens + wall-clock). This path
  // (Anthropic-compat HTTP, used by many domestic gateways) previously had NO
  // early gate — the doomed Write only got rejected at disk-write time after
  // the model had already authored the entire file body. Mirrors the SDK
  // (`providers/anthropic.ts`) and OpenAI-compat (`compatibleClient.ts`) wiring.
  const writeWatcher = new StreamWriteInputWatcher()
  let cgradeWriteAborted = false

  const flushToolCall = (acc: ToolCallAccumulator): void => {
    if (!callbacks.onToolUse) return
    sawToolUse = true
    // Prefer eager `input` when it was a real object (common dialect); fall
    // back to accumulated json-delta text parsed through `parseToolArguments`
    // which preserves raw bytes on parse failure.
    let parsed: Record<string, unknown>
    const deltaText = acc.arguments.trim()
    if (deltaText.length === 0) {
      // Pure eager: the gateway packed the whole tool `input` into
      // `content_block_start` and streamed no `input_json_delta`. Use it
      // verbatim ({} if it somehow had neither — schema validation reports it).
      parsed = acc.eagerInput ?? {}
    } else {
      const { value, meta } = parseToolArgumentsWithMeta(acc.arguments)
      // Merge eager + delta rather than discarding the eager half.
      //
      // Some Anthropic-compat gateways (notably Zhipu / GLM) are *mixed-mode*:
      // they put part of the tool input in `content_block_start` (e.g. just
      // `filePath`) AND stream the remainder — or a partial restatement — via
      // `input_json_delta`. The previous code dropped `acc.eagerInput` the
      // instant any delta arrived, so eager-only fields were lost. Observed
      // production failure: `write_file` arriving with only `{filePath}` (the
      // `content` lived in the eager half and was discarded), surfacing as
      // "missing required argument(s)" even though nothing was truncated.
      //
      // Eager is the base; delta values win on overlapping keys because the
      // streamed delta is the more authoritative / complete source.
      parsed =
        acc.eagerInput && value && typeof value === 'object' && !Array.isArray(value)
          ? { ...acc.eagerInput, ...value }
          : value
      // Truncated mid-stream (max_tokens cut the `content`/`newString`): tag
      // write/edit tools so the schema refuses to persist a partial file.
      // Two signals:
      //   (a) the argument JSON itself needed truncation repair;
      //   (b) `message_delta` already reported `stop_reason: max_tokens` —
      //       some gateways auto-close a cut-off tool block into
      //       VALID-looking JSON, so an accumulator flushed after that
      //       stop_reason (EOS fallback drain) is equally suspect even when
      //       it parses cleanly. Properly closed blocks flush at
      //       `content_block_stop`, BEFORE `message_delta` carries the
      //       stop_reason, so (b) never tags those.
      if (
        (meta.truncationRepaired || stopReason === 'max_tokens') &&
        WRITE_EDIT_TOOL_NAMES_FOR_TRUNCATION_GUARD.has(acc.name)
      ) {
        parsed[TRUNCATED_TOOL_ARGS_MARKER_KEY] = true
      }
      // The lenient-repair (`jsonrepair`) marker is stamped centrally inside
      // parseToolArgumentsWithMeta, so it already rides on `parsed` here.
    }
    callbacks.onToolUse({
      id: acc.id,
      name: acc.name,
      input: parsed,
      ...(typeof acc.thoughtSignature === 'string' && acc.thoughtSignature.length > 0
        ? { thoughtSignature: acc.thoughtSignature }
        : {}),
    })
  }

  try {
    for await (const event of readNormalizedAnthropicEvents(response.body!, watchdog)) {
      const type = typeof event.type === 'string' ? event.type : ''

      // Route every parsed event through the shared per-index thinking
      // accumulator BEFORE the switch. The helper filters internally —
      // non-thinking event types are no-ops — but it must see every
      // `content_block_start/delta/stop` so onThinkingDelta /
      // onThinkingBlock / onThinkingStart / onThinkingComplete fire on
      // the same wire boundaries as the SDK path (which routes
      // `streamEvent` through the same helper). The legacy inline
      // thinking branches in the switch below have been removed; only
      // tool / reasoning_summary / text bookkeeping remains there.
      thinkingAcc.handle(event)

      switch (type) {
        case 'message_start': {
          const message = event.message as Record<string, unknown> | undefined
          const usage = message?.usage as Record<string, unknown> | undefined
          if (usage) {
            if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens
            if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens
            if (typeof usage.cache_creation_input_tokens === 'number') {
              cacheCreationInputTokens = usage.cache_creation_input_tokens
            }
            if (typeof usage.cache_read_input_tokens === 'number') {
              cacheReadInputTokens = usage.cache_read_input_tokens
            }
          }
          break
        }

        case 'content_block_start': {
          const index = typeof event.index === 'number' ? event.index : 0
          const block = event.content_block as Record<string, unknown> | undefined
          if (!block) break
          if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            sawThinking = true
          }
          // Plan Phase 4 — `redacted_thinking` 块（启用 REDACT_THINKING beta）。
          // 与 thinking 不同：无 delta，无 stop 还要再补；content_block_start
          // 直接带完整 `data`。在这里就 emit 一次到 onRedactedThinkingBlock。
          if (block.type === 'redacted_thinking' && callbacks.onRedactedThinkingBlock) {
            const data = block.data
            if (typeof data === 'string' && data.length > 0) {
              callbacks.onRedactedThinkingBlock({
                data,
                startedAtMs: Date.now(),
              })
            }
            break
          }
          // Thinking blocks are seeded by `thinkingAcc.handle(event)` above;
          // only tool_use bookkeeping remains here.
          if (block.type === 'tool_use') {
            // Dialect handling: some gateways put the *full* tool input here
            // instead of streaming it via `input_json_delta`. Detect by
            // checking whether `input` is a non-empty object or a non-empty
            // JSON string. We still accept later deltas in case the gateway
            // is mixed-mode.
            const rawInput = block.input
            let eagerInput: Record<string, unknown> | undefined
            let fallbackArguments = ''
            if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
              if (Object.keys(rawInput as Record<string, unknown>).length > 0) {
                eagerInput = rawInput as Record<string, unknown>
              }
            } else if (typeof rawInput === 'string' && rawInput.trim()) {
              // Fix: some DeepSeek-compatible gateways serialise block.input
              // as a JSON string. Parse it so tool parameters are not lost.
              fallbackArguments = rawInput
              try {
                const parsed = JSON.parse(rawInput)
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  eagerInput = parsed as Record<string, unknown>
                }
              } catch {
                /* non-JSON string — keep as text */
              }
            }
            toolAccumulators.set(index, {
              id: String(block.id ?? ''),
              name: String(block.name ?? ''),
              arguments: fallbackArguments,
              eagerInput,
              inputDeltaThrottle: createToolInputDeltaThrottleState(),
              ...(typeof block.thoughtSignature === 'string'
                ? { thoughtSignature: block.thoughtSignature }
                : {}),
            })
            // C-grade Write preflight — register the block, then (for eager
            // dialects that pack the full `input` into `content_block_start`)
            // feed it once so a doomed Write is rejected before the pipeline
            // runs, instead of only at disk-write time.
            const blockId = String(block.id ?? '')
            const blockName = String(block.name ?? '')
            if (blockId && callbacks.onToolUse) {
              writeWatcher.registerToolUseBlock(index, { id: blockId, name: blockName })
              if (eagerInput) {
                const rej = writeWatcher.feedInputJsonDelta(index, JSON.stringify(eagerInput))
                if (rej) {
                  try {
                    callbacks.onToolUse(rej.toolUse)
                  } catch {
                    /* listener errors must not survive into the abort path */
                  }
                  sawToolUse = true
                  toolAccumulators.delete(index)
                  cgradeWriteAborted = true
                }
              }
            }
          }
          break
        }

        case 'content_block_delta': {
          const index = typeof event.index === 'number' ? event.index : 0
          const delta = event.delta as Record<string, unknown> | undefined
          if (!delta) break
          const dType = typeof delta.type === 'string' ? delta.type : ''
          if (dType === 'text_delta' && typeof delta.text === 'string') {
            if (delta.text.length > 0) sawText = true
            callbacks.onTextDelta(delta.text)
          } else if (dType === 'thinking_delta' || dType === 'signature_delta') {
            if (dType === 'thinking_delta') sawThinking = true
            // Handled by `thinkingAcc.handle(event)` above the switch.
          } else if (dType === 'reasoning_summary_delta' && typeof delta.text === 'string') {
            // Pseudo-Claude extension carrying OpenAI Responses
            // `response.reasoning_summary_text.delta` translated payloads
            // (see `claudeToOpenAI2.ts#openAI2StreamToClaude`). Surface
            // through a dedicated channel so the UI can show it as a
            // distinct ChatBlock — `thinking` block plumbing handles
            // signatures + extended-thinking echo invariants that
            // summaries don't share.
            callbacks.onReasoningSummaryDelta?.(delta.text)
            const acc =
              reasoningSummaryAccumulators.get(index) ??
              (() => {
                const fresh: ReasoningSummaryAccumulator = { text: '', startedAtMs: Date.now() }
                reasoningSummaryAccumulators.set(index, fresh)
                return fresh
              })()
            acc.text += delta.text
          } else if (dType === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const acc = toolAccumulators.get(index)
            if (acc) {
              acc.arguments += delta.partial_json
              // Mixed-mode gateways (Zhipu / GLM) send eager input in
              // `content_block_start` AND stream deltas. We KEEP the eager
              // object and merge it with the parsed delta at flush time (see
              // `flushToolCall`) so eager-only fields (e.g. `filePath`) survive
              // a partial delta restatement instead of being discarded.
              // C-grade Write preflight: feed the watcher the raw delta. The
              // moment `filePath` resolves to an existing file, emit the
              // synthetic "use edit_file" tool_use and abort the stream so the
              // bulky `content` arg never finishes streaming.
              if (delta.partial_json.length > 0 && callbacks.onToolUse) {
                const rej = writeWatcher.feedInputJsonDelta(index, delta.partial_json)
                if (rej) {
                  try {
                    callbacks.onToolUse(rej.toolUse)
                  } catch {
                    /* listener errors must not survive into the abort path */
                  }
                  sawToolUse = true
                  toolAccumulators.delete(index)
                  cgradeWriteAborted = true
                  break
                }
              }
              // Surface the running buffer to the UI so a card can render
              // the in-progress `content` / `newString` while the model
              // is still typing. Sending the full accumulated string
              // (not just the delta) lets renderers run tolerant partial
              // JSON extraction without keeping their own ordering state.
              //
              // Coalesce with the shared time-window OR byte-window
              // gate — see `./toolInputDeltaThrottle.ts` for rationale.
              // Final emit is force-flushed below on `content_block_stop`
              // so the renderer always sees the complete partial JSON
              // state immediately before `tool_start`.
              if (callbacks.onToolInputDelta) {
                const now = Date.now()
                if (shouldEmitToolInputDelta(acc.inputDeltaThrottle, acc.arguments.length, now)) {
                  acc.inputDeltaThrottle.lastEmitAt = now
                  acc.inputDeltaThrottle.lastEmittedLength = acc.arguments.length
                  callbacks.onToolInputDelta({
                    toolUseId: acc.id,
                    toolName: acc.name,
                    partialJson: acc.arguments,
                  })
                }
              }
            }
          }
          break
        }

        case 'content_block_stop': {
          const index = typeof event.index === 'number' ? event.index : 0
          const acc = toolAccumulators.get(index)
          if (acc) {
            // Final partial-JSON flush, ignoring both throttle gates.
            // Two reasons we need this even though `tool_start` (fired
            // inside `flushToolCall` next) will replace the renderer's
            // `streamingInput` anyway:
            //   1. The throttle may have suppressed the very last
            //      delta (sub-50ms, sub-256B tail). Without this, the
            //      renderer's last observable partial state is stale,
            //      and on `tool_start` the card visually jumps from
            //      "~95% typed" to the canonical full content.
            //   2. Invariant for `partialToolInputExtract`: the last
            //      `partialJson` we emit must be a fully-closed object
            //      (closing braces present), so the tolerant extractor
            //      returns `complete: true` and the UI drops the
            //      blinking caret one frame before the card swaps to
            //      `input.*`. Smoother transition.
            if (
              callbacks.onToolInputDelta &&
              hasPendingThrottledTail(acc.inputDeltaThrottle, acc.arguments.length)
            ) {
              callbacks.onToolInputDelta({
                toolUseId: acc.id,
                toolName: acc.name,
                partialJson: acc.arguments,
              })
            }
            flushToolCall(acc)
            toolAccumulators.delete(index)
          }
          // Thinking block flush + onThinkingComplete bracket are handled
          // by `thinkingAcc.handle(event)` above the switch.
          const rAcc = reasoningSummaryAccumulators.get(index)
          if (rAcc) {
            if (rAcc.text.length > 0 && callbacks.onReasoningSummaryBlock) {
              callbacks.onReasoningSummaryBlock({
                text: rAcc.text,
                thinkingTimeMs: Math.max(0, Date.now() - rAcc.startedAtMs),
                thinkingTokens: estimateThinkingTokens(rAcc.text),
              })
            }
            reasoningSummaryAccumulators.delete(index)
          }
          break
        }

        case 'message_delta': {
          const delta = event.delta as Record<string, unknown> | undefined
          if (delta && typeof delta.stop_reason === 'string') {
            stopReason = delta.stop_reason
          }
          const usage = event.usage as Record<string, unknown> | undefined
          if (usage && typeof usage.output_tokens === 'number') {
            outputTokens = usage.output_tokens
          }
          break
        }

        case 'message_stop':
          sawMessageStop = true
          break

        case 'ping':
          break

        case 'error': {
          // P0 audit fix: mid-stream SSE error events are a non-throw
          // error path. Surface them as a typed envelope so the stream
          // phase's final-promotion can route this to a terminal
          // model_error. We pass the raw `err` (which may carry `type`
          // / `status` fields from the gateway) so the classifier can
          // use them when present, falling back to message substring.
          const err = event.error as Record<string, unknown> | undefined
          const msg = typeof err?.message === 'string' ? err.message : 'unknown gateway error'
          emitProviderErrorSignal(err ?? msg, 'compat', callbacks)
          callbacks.onError(msg)
          return
        }

        default:
          // Unknown event — skip. Many gateways inject their own telemetry
          // events (`ping`, `heartbeat`, etc.); dropping them is safe.
          break
      }

      // C-grade Write preflight tripped inside the switch — stop consuming SSE
      // frames now so the gateway tears down the HTTP read and the model's
      // bulky `content` arg never finishes streaming. The synthetic tool_use
      // has already been emitted; releasing the body (finally) cancels the read.
      if (cgradeWriteAborted) break
    }
  } finally {
    releaseFetchResponseBody(response)
  }

  // EOS without explicit message_stop: flush any remaining tool accumulators.
  if (!sawMessageStop && toolAccumulators.size > 0) {
    for (const acc of toolAccumulators.values()) flushToolCall(acc)
  }
  // Same fallback for thinking blocks — gateways that close the stream
  // without `content_block_stop` would otherwise drop the assembled block.
  // The shared accumulator owns this drain.
  thinkingAcc.flushAll()
  if (reasoningSummaryAccumulators.size > 0 && callbacks.onReasoningSummaryBlock) {
    for (const rAcc of reasoningSummaryAccumulators.values()) {
      if (rAcc.text.length > 0) {
        callbacks.onReasoningSummaryBlock({
          text: rAcc.text,
          thinkingTimeMs: Math.max(0, Date.now() - rAcc.startedAtMs),
          thinkingTokens: estimateThinkingTokens(rAcc.text),
        })
      }
    }
    reasoningSummaryAccumulators.clear()
  }
  // onThinkingComplete trailing bracket is fired inside `thinkingAcc.flushAll()`
  // above when the stream closed without a wire-level content_block_stop.

  // DeepSeek Anthropic-compat can produce a thinking-only stream with no
  // `message_delta.stop_reason` when the visible answer/tool call is cut off.
  // Treat that structurally-incomplete shape as max_tokens so the existing
  // max-output recovery path resumes instead of silently ending as completed.
  if (!stopReason && sawThinking && !sawText && !sawToolUse) {
    stopReason = 'max_tokens'
  }

  const usage: StreamMessageUsage = {
    inputTokens,
    outputTokens,
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
    ...(stopReason ? { stopReason: mapStopReasonToClaude('anthropic-compat', stopReason) } : {}),
  }
  callbacks.onMessageEnd(usage)
}

// ─── Error formatters ──────────────────────────────────────────────────

/**
 * Gateway error texts that mean "this model rejected the image/multimodal
 * content blocks" (as opposed to any other 400). Matched against the
 * formatted HTTP-400 message to trigger the one-shot strip-images retry.
 *
 * Known wordings:
 *   - DashScope: `InternalError.Algo.InvalidParameter: The provided messages
 *     input is invalid. The error info is [Unexpected item type in content.]`
 *   - Several compat gateways: `unknown content block type` / variants.
 */
const IMAGE_CONTENT_REJECTED_RE =
  /unexpected item type in content|unknown content block|content block type .{0,40}(not |un)supported|does not support image/i

function formatHttpError(status: number, body: string, name: string): string {
  if (status === 401) {
    return `HTTP 401 — ${name} 鉴权失败。检查 API key 与 baseUrl 是否匹配该服务商的 Anthropic 兼容端点。`
  }
  if (status === 429) return `${name}: 请求过于频繁，请稍后重试 (HTTP 429)`
  if (status === 500 || status === 503) return `${name}: 网关错误 (HTTP ${status})`
  if (status === 529) return `${name}: 服务暂时过载 (HTTP 529)`
  const snippet = body.length > 300 ? `${body.slice(0, 300)}…` : body
  return `HTTP ${status}: ${snippet}`
}

function formatNetworkError(error: unknown, name: string): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as Error & { cause?: unknown }).cause
  let code = ''
  if (cause && typeof cause === 'object' && 'code' in cause) {
    code = String((cause as NodeJS.ErrnoException).code || '')
  }
  const base = error.message || '未知错误'
  if (code === 'ECONNRESET' || /fetch failed/i.test(base)) {
    return `${name}: ${base}（${code || '网络'}）。常见于代理 / 网关超时或流式长连接被重置。`
  }
  if (code === 'ECONNREFUSED') return `${name}: 无法连接到服务器，请确认 baseUrl 与端口`
  if (code === 'ETIMEDOUT') return `${name}: 连接超时`
  return `${name}: ${base}`
}
