/**
 * OpenAI provider implementation.
 *
 * Extracted from `electron/ai/client.ts` (§ ========== OpenAI ==========). The
 * unified dispatcher routes `providerId === 'openai'` to {@link streamOpenAI}.
 * All OpenAI-specific tool schema conversion, apiMessages conversion and
 * streaming accumulation helpers live here so `client.ts` can remain the
 * cross-provider routing surface.
 *
 * No behavioural change from the original code path — this is a pure move
 * plus minor comment cleanup.
 */

import OpenAI from 'openai'
import type { ProviderConfig, StreamCallbacks, StreamTextParams } from '../client'
import type { ToolDefinition } from '../../tools/types'
import {
  buildSendMessageOpenAIStrictParameters,
  collectSendMessageRecipientEnum,
  readSendMessageToEnumFromDefinition,
} from '../../agents/sendMessageToolSchema'
import { stripPoleContextUsageFromApiMessages } from '../../context/tokenUsageAccounting'
import { mergeUserSignalWithStreamWatchdog } from '../streamWatchdog'
import { emitProviderErrorSignal } from '../loopSignalEmit'
import { isAbortLikeError } from '../abortLikeError'
import {
  computeApiRetryDelayMs,
  defaultStreamExtraRetries,
  isRetryableStreamHttpError,
  isUnattendedRetryModeEnabled,
  parseRetryAfterMsFromError,
  sleepAbortableChunked,
  unattendedWallClockExceeded,
} from '../withRetry'
import { ensureArrayItemsSchema } from './schemaUtils'
import {
  createToolInputDeltaThrottleState,
  hasPendingThrottledTail,
  shouldEmitToolInputDelta,
  type ToolInputDeltaThrottleState,
} from '../toolInputDeltaThrottle'
import { parseToolArguments, stringifyToolInputForOpenAi } from '../transformer/parseToolArguments'
import { sanitizeMessagesForWire } from '../../utils/unicodeSanitize'
import { mapStopReasonToClaude } from '../stopReasonMap'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Convert Anthropic-format tool definitions to OpenAI function calling format.
 * When {@link StreamTextParams.openAiStrictToolNames} includes a name, that tool gets `strict: true`
 * (SendMessage uses a dedicated schema built in {@link buildSendMessageOpenAIStrictParameters}).
 */
function convertToolsToOpenAIFormat(
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
  openAiStrictToolNames?: string[],
): OpenAI.Chat.ChatCompletionTool[] {
  const strictSet = new Set(openAiStrictToolNames ?? [])
  return tools.map((t) => {
    const useStrict = strictSet.has(t.name)
    let parameters: Record<string, unknown>
    if (t.name === 'SendMessage' && useStrict) {
      const asDef = t as ToolDefinition
      const recipients =
        readSendMessageToEnumFromDefinition(asDef) ?? collectSendMessageRecipientEnum()
      parameters = buildSendMessageOpenAIStrictParameters(recipients)
    } else {
      parameters = ensureArrayItemsSchema(t.input_schema)
    }
    const fn = {
      name: t.name,
      description: t.description,
      parameters,
      ...(useStrict ? { strict: true as const } : {}),
    }
    return {
      type: 'function' as const,
      function: fn,
    } as OpenAI.Chat.ChatCompletionTool
  })
}

/** Anthropic-style user blocks (text + image) → OpenAI Chat Completions multipart `content`. */
function openAiContentPartsFromAnthropicBlocks(
  blocks: Array<Record<string, unknown>>,
): OpenAI.Chat.ChatCompletionContentPart[] {
  const parts: OpenAI.Chat.ChatCompletionContentPart[] = []
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push({ type: 'text', text: b.text })
    } else if (b.type === 'image') {
      const src = b.source as Record<string, unknown> | undefined
      const data = src && typeof src.data === 'string' ? src.data : ''
      const mime = src && typeof src.media_type === 'string' ? src.media_type : 'image/png'
      if (data) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${data}` },
        })
      }
    }
  }
  return parts
}

function pushOpenAiUserFromParts(
  result: OpenAI.Chat.ChatCompletionMessageParam[],
  parts: OpenAI.Chat.ChatCompletionContentPart[],
): void {
  if (parts.length === 0) return
  if (parts.length === 1 && parts[0]!.type === 'text') {
    result.push({ role: 'user', content: parts[0]!.text })
  } else {
    result.push({ role: 'user', content: parts })
  }
}

const SYNTHETIC_TOOL_RESULT_CONTENT =
  'Error: Tool execution result was unavailable after context compaction (synthetic tool message inserted to satisfy OpenAI Chat protocol).'

function repairOpenAIToolMessageAdjacency(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
  let pendingToolIds: Set<string> | null = null

  const flushMissingToolResults = (): void => {
    if (!pendingToolIds || pendingToolIds.size === 0) return
    for (const id of pendingToolIds) {
      out.push({
        role: 'tool',
        tool_call_id: id,
        content: SYNTHETIC_TOOL_RESULT_CONTENT,
      })
    }
    pendingToolIds = null
  }

  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      flushMissingToolResults()
      out.push(msg)
      pendingToolIds = new Set(
        msg.tool_calls
          .map((tc) => tc.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      )
      continue
    }

    if (msg.role === 'tool') {
      const id = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : ''
      if (pendingToolIds?.has(id)) {
        out.push(msg)
        pendingToolIds.delete(id)
        if (pendingToolIds.size === 0) pendingToolIds = null
      }
      continue
    }

    flushMissingToolResults()
    out.push(msg)
  }

  flushMissingToolResults()
  return out
}

/**
 * Convert agentic loop's Anthropic-format apiMessages to OpenAI ChatCompletion format.
 *
 * Handles:
 *  - Simple string content → direct passthrough
 *  - Assistant messages with tool_use blocks → tool_calls array
 *  - User messages with tool_result blocks → role='tool' messages
 *  - User messages with image blocks → multipart content (`image_url`)
 */
function convertApiMessagesToOpenAI(
  apiMessages: Array<Record<string, unknown>>,
  systemPrompt?: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of apiMessages) {
    const role = msg.role as string
    const content = msg.content

    if (typeof content === 'string') {
      result.push({ role: role as 'user' | 'assistant', content })
      continue
    }

    if (Array.isArray(content)) {
      if (role === 'assistant') {
        const toolUseBlocks = content.filter(
          (b: Record<string, unknown>) => b.type === 'tool_use',
        )
        const textBlocks = content.filter(
          (b: Record<string, unknown>) => b.type === 'text',
        )

        if (toolUseBlocks.length > 0) {
          result.push({
            role: 'assistant',
            content:
              textBlocks.length > 0
                ? ((textBlocks[0] as Record<string, unknown>).text as string)
                : null,
            tool_calls: toolUseBlocks.map((b: Record<string, unknown>) => ({
              id: b.id as string,
              type: 'function' as const,
              function: {
                name: b.name as string,
                // Defends against double-encoding when history replay carries
                // an already-stringified `b.input`. Without this the model
                // sees `"\"{...}\""` for prior tool calls and either
                // hallucinates a re-call or replies with `null`.
                arguments: stringifyToolInputForOpenAi(b.input),
              },
            })),
          })
        } else if (textBlocks.length > 0) {
          result.push({
            role: 'assistant',
            content: (textBlocks[0] as Record<string, unknown>).text as string,
          })
        }
      } else if (role === 'user') {
        const toolResultBlocks = content.filter(
          (b: Record<string, unknown>) => b.type === 'tool_result',
        )
        const nonTool = content.filter(
          (b: Record<string, unknown>) => b.type !== 'tool_result',
        ) as Array<Record<string, unknown>>
        const userParts = openAiContentPartsFromAnthropicBlocks(nonTool)

        if (toolResultBlocks.length > 0) {
          for (const b of toolResultBlocks) {
            const resultContent =
              typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
            result.push({
              role: 'tool' as const,
              tool_call_id: b.tool_use_id as string,
              content: resultContent,
            })
          }
          pushOpenAiUserFromParts(result, userParts)
        } else {
          pushOpenAiUserFromParts(result, userParts)
        }
      }
    }
  }

  return result
}

type OpenAIToolCallAccumulator = {
  id: string
  name: string
  arguments: string
  /**
   * Shared throttle state for `onToolInputDelta` emission. Without
   * this, OpenAI users (and any OpenAI-compatible gateway routed
   * through this SDK path) would see Write/Edit cards only AFTER
   * `flushAccumulatedToolCalls` — i.e. once `finish_reason` lands.
   * That defeats the entire IDE-style live writing feature.
   */
  inputDeltaThrottle: ToolInputDeltaThrottleState
}

/**
 * Recover the tool-call arguments object. Delegates to the shared
 * {@link parseToolArguments} so the native OpenAI path gets the SAME treatment
 * as every other provider: strict parse → cheap repairs (fence / carve /
 * truncation auto-close) → `jsonrepair` last-ditch, plus the central write/edit
 * safety markers (lenient-repair and truncation) stamped on the recovered
 * object. Reads benefit from the repair; write/edit calls that needed it are
 * refused by the schema rather than executed with heuristically-repaired bytes.
 * Unrecoverable payloads surface under `__rawArguments` for the actionable hint.
 */
function parseOpenAIToolCallArguments(raw: string): Record<string, unknown> {
  return parseToolArguments(raw)
}

function openAiToolCallIndex(tc: { index?: number }): number {
  const i = tc.index
  return typeof i === 'number' && !Number.isNaN(i) ? i : 0
}

export async function streamOpenAI(
  config: ProviderConfig,
  params: StreamTextParams,
  callbacks: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  let client: OpenAI
  try {
    client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl && { baseURL: config.baseUrl }),
      timeout: 600_000,
    })
  } catch (error) {
    // P0 audit fix: client-init failure must also surface a typed envelope
    // so the stream phase's final-promotion (which keys off
    // `state.withheldStreamSignal`) can route this to a terminal
    // model_error instead of silently dropping to 'completed'.
    emitProviderErrorSignal(error, 'openai', callbacks)
    callbacks.onError(`Failed to initialize OpenAI client: ${getErrorMessage(error)}`)
    return
  }

  const retries = params.streamRetries ?? defaultStreamExtraRetries()
  const maxAttempts = Math.max(1, retries + 1)
  let unattendedStartMs: number | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const streamWatchdog = mergeUserSignalWithStreamWatchdog(
      signal,
      `[OpenAI] chat.completions model=${params.model}`,
    )
    try {
      const apiStripped = stripPoleContextUsageFromApiMessages(params.apiMessages)
      const rawRequestMessages = apiStripped
        ? convertApiMessagesToOpenAI(apiStripped, params.systemPrompt)
        : (() => {
            const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = []
            if (params.systemPrompt) {
              msgs.push({ role: 'system', content: params.systemPrompt })
            }
            for (const m of params.messages) {
              const c = m.content
              if (m.role === 'user' && Array.isArray(c)) {
                const parts = openAiContentPartsFromAnthropicBlocks(
                  c as Array<Record<string, unknown>>,
                )
                pushOpenAiUserFromParts(msgs, parts)
              } else {
                msgs.push({
                  role: m.role as 'user' | 'assistant',
                  content: c as string,
                })
              }
            }
            return msgs
          })()
      const requestMessages = repairOpenAIToolMessageAdjacency(rawRequestMessages)

      const createParams: OpenAI.Chat.ChatCompletionCreateParams = {
        model: params.model,
        messages: requestMessages,
        // upstream parity (anthropicToOpenaiChat.ts): omit `max_tokens` so the
        // upstream provider applies its own default/max. Sending an explicit
        // value either truncates thinking-heavy turns prematurely (too small,
        // e.g. 8192) or 400s gateways with lower ceilings (too large). Letting
        // the provider decide avoids both failure modes.
        stream: true,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.topP !== undefined ? { top_p: params.topP } : {}),
      }

      if (params.tools && params.tools.length > 0 && callbacks.onToolUse) {
        createParams.tools = convertToolsToOpenAIFormat(
          params.tools,
          params.openAiStrictToolNames,
        ) as OpenAI.Chat.ChatCompletionTool[]
        createParams.tool_choice =
          params.toolChoice === 'any'
            ? 'required'
            : params.toolChoice && typeof params.toolChoice === 'object'
              ? {
                  type: 'function',
                  function: { name: params.toolChoice.name },
                }
              : 'auto'
      }

      // Lone UTF-16 surrogates (from upstream `.slice` mid-surrogate-pair)
      // survive into `JSON.stringify` as `\uD8xx` escapes; strict serde_json
      // gateways 400. Sanitize the full wire payload — see `unicodeSanitize.ts`.
      const wireParams = sanitizeMessagesForWire(createParams)

      console.log('[StreamOpenAI] Request:', {
        model: params.model,
        messageCount: requestMessages.length,
        toolCount: wireParams.tools?.length || 0,
        hasApiMessages: !!params.apiMessages,
      })

      const stream = await client.chat.completions.create(wireParams, {
        signal: streamWatchdog.signal,
      })

      // Tool call fragments stream across chunks — must be accumulated & flushed
      // at finish_reason / stream end.
      const toolCallMap = new Map<number, OpenAIToolCallAccumulator>()
      let hasReceivedContent = false
      let sawText = false
      let sawThinking = false
      let emittedToolUse = false
      let lastStopReason: string | undefined
      // upstream holding pattern: `usage` frequently arrives in a trailing
      // chunk AFTER the one carrying `finish_reason`. Capture it from any
      // chunk and emit a single `onMessageEnd` once the stream drains, so we
      // never report 0 tokens just because finish_reason landed first.
      let capturedUsage: OpenAI.CompletionUsage | undefined
      let chunkCount = 0

      const flushAccumulatedToolCalls = (reason: string): void => {
        if (!callbacks.onToolUse || toolCallMap.size === 0) return
        const sortedCalls = [...toolCallMap.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => tc)
        for (const tc of sortedCalls) {
          if (!tc.name?.trim()) continue
          // Final force-flush of any throttled tail so the renderer's
          // live-writing card sees the complete partial JSON state
          // ONE frame before `tool_start` swaps in `tool_use.input`.
          // Mirrors the invariant the anthropic-compat path enforces.
          if (
            callbacks.onToolInputDelta &&
            tc.id &&
            hasPendingThrottledTail(tc.inputDeltaThrottle, tc.arguments.length)
          ) {
            callbacks.onToolInputDelta({
              toolUseId: tc.id,
              toolName: tc.name.trim(),
              partialJson: tc.arguments,
            })
          }
          callbacks.onToolUse({
            id: tc.id,
            name: tc.name.trim(),
            input: parseOpenAIToolCallArguments(tc.arguments),
          })
          emittedToolUse = true
        }
        toolCallMap.clear()
        console.log('[StreamOpenAI] Flushed tool calls:', {
          reason,
          count: sortedCalls.length,
        })
      }

      for await (const chunk of stream) {
        streamWatchdog.touch()
        chunkCount++
        if (chunk.usage) capturedUsage = chunk.usage
        const choice = chunk.choices[0]
        if (!choice) continue

        const delta = choice.delta

        if (delta?.content) {
          hasReceivedContent = true
          sawText = true
          callbacks.onTextDelta(delta.content)
        }

        // Some models & gateways stream a `thinking` field not on SDK `Delta` typings yet.
        const thinkingDeltaRaw = (delta as { thinking?: unknown } | undefined)?.thinking
        const thinkingDelta =
          typeof thinkingDeltaRaw === 'string' && thinkingDeltaRaw.length > 0
            ? thinkingDeltaRaw
            : undefined
        if (thinkingDelta) {
          hasReceivedContent = true
          sawThinking = true
          callbacks.onThinkingDelta?.(thinkingDelta)
        }

        if (delta?.tool_calls) {
          hasReceivedContent = true
          for (const tc of delta.tool_calls) {
            const idx = openAiToolCallIndex(tc)
            const existing = toolCallMap.get(idx) || {
              id: '',
              name: '',
              arguments: '',
              inputDeltaThrottle: createToolInputDeltaThrottleState(),
            }
            if (tc.id) existing.id = tc.id
            if (tc.function?.name) existing.name += tc.function.name
            if (tc.function?.arguments) existing.arguments += tc.function.arguments
            toolCallMap.set(idx, existing)
            // the IDE live writing — surface the running args buffer
            // through the same throttle as anthropic-compat. Requires
            // both `id` (some gateways send it only on the very first
            // delta chunk) and `name` to be present so the renderer
            // can seed a placeholder block correctly.
            if (
              callbacks.onToolInputDelta &&
              existing.id &&
              existing.name &&
              existing.arguments.length > 0
            ) {
              const now = Date.now()
              if (
                shouldEmitToolInputDelta(
                  existing.inputDeltaThrottle,
                  existing.arguments.length,
                  now,
                )
              ) {
                existing.inputDeltaThrottle.lastEmitAt = now
                existing.inputDeltaThrottle.lastEmittedLength = existing.arguments.length
                callbacks.onToolInputDelta({
                  toolUseId: existing.id,
                  toolName: existing.name,
                  partialJson: existing.arguments,
                })
              }
            }
          }
        }

        const finishReason = choice.finish_reason
        if (typeof finishReason === 'string' && finishReason.length > 0) {
          lastStopReason = mapStopReasonToClaude('openai-native', finishReason, {
            hasToolUseBlocks: toolCallMap.size > 0 || emittedToolUse,
          })
        }
        if (
          finishReason === 'stop' ||
          finishReason === 'tool_calls' ||
          finishReason === 'function_call' ||
          finishReason === 'length'
        ) {
          console.log('[StreamOpenAI] Stream ended:', {
            finishReason,
            chunkCount,
            hasContent: hasReceivedContent,
            toolCallCount: toolCallMap.size,
          })

          // Many OpenAI-compatible gateways (and occasional model quirks) end with finish_reason
          // `stop` while tool_calls were streamed — only flushing on `tool_calls` drops Agent/sub-agent.
          if (
            finishReason === 'tool_calls' ||
            finishReason === 'function_call' ||
            (toolCallMap.size > 0 && (finishReason === 'stop' || finishReason === 'length'))
          ) {
            flushAccumulatedToolCalls(`finish_reason=${finishReason}`)
            if (finishReason === 'stop' || finishReason === 'length') {
              lastStopReason = mapStopReasonToClaude('openai-native', finishReason, {
                hasToolUseBlocks: emittedToolUse,
              })
            }
          }

          // upstream holding pattern: do NOT emit `onMessageEnd` / `return` /
          // `break` here. `usage` typically rides a trailing chunk AFTER this
          // one; stopping now would drop it (0 tokens). We let the loop drain
          // the remaining chunk(s) — captured at the loop top — until the
          // stream closes, then the single post-loop `onMessageEnd` emits the
          // captured usage + stopReason together. (The idle watchdog guards
          // against a gateway that never closes.)
        }
      }

      console.log('[StreamOpenAI] Stream exhausted:', {
        chunkCount,
        hasContent: hasReceivedContent,
        toolCallCount: toolCallMap.size,
      })

      flushAccumulatedToolCalls('stream_exhausted')
      if (emittedToolUse) {
        lastStopReason = 'tool_use'
      } else if (!lastStopReason && sawThinking && !sawText) {
        lastStopReason = 'max_tokens'
      }

      // Single terminal emit (holding pattern): combine the captured usage —
      // which may have arrived in a trailing chunk after finish_reason — with
      // the resolved stopReason. If neither was seen, fall back to a bare
      // onMessageEnd() (matches the legacy "stop token without text" path).
      if (capturedUsage || lastStopReason) {
        callbacks.onMessageEnd({
          inputTokens: capturedUsage?.prompt_tokens || 0,
          outputTokens: capturedUsage?.completion_tokens || 0,
          ...(lastStopReason ? { stopReason: lastStopReason } : {}),
        })
      } else {
        callbacks.onMessageEnd()
      }
      return
    } catch (error) {
      if (isAbortLikeError(error)) {
        // Distinguish a user-initiated cancel from a watchdog-induced abort
        // (TTFB / idle timeout). Only the former leaves the user's `signal`
        // aborted; a watchdog abort fires on `streamWatchdog.signal` while
        // the user's `signal` is still live. Surfacing it as an error stops
        // the agentic loop from treating a dead/stalled stream as an empty
        // "completed" turn. Mirrors the fetch-based paths.
        if (signal.aborted) {
          callbacks.onMessageEnd()
          return
        }
        const watchdogMessage = `${config.name}: 流式连接被守卫中止（上游长时间未返回数据：首字节超时或流中途空闲超时；常见原因：网关排队/挂起、代理超时、网络不稳定）。请检查网络与 baseUrl 是否可达后重试。`
        emitProviderErrorSignal(watchdogMessage, 'openai', callbacks)
        callbacks.onError(watchdogMessage)
        return
      }
      // Phase 4 (upstream alignment): classify error into a typed LoopSignal
      // envelope, emit to `onLoopSignal`, and mirror PTL kind to the legacy
      // `contextLengthExceededRef`. Single classification — no regex.
      const { isPromptTooLong } = emitProviderErrorSignal(
        error,
        'openai',
        callbacks,
        params.contextLengthExceededRef,
      )
      if (isPromptTooLong) {
        return
      }
      const unattended = isUnattendedRetryModeEnabled()
      if (unattended && unattendedStartMs == null) unattendedStartMs = Date.now()
      if (
        isRetryableStreamHttpError(error) &&
        attempt < maxAttempts - 1 &&
        !(unattended && unattendedWallClockExceeded(unattendedStartMs))
      ) {
        const delay = computeApiRetryDelayMs(attempt, {
          retryAfterMs: parseRetryAfterMsFromError(error),
          unattended,
        })
        console.warn(
          `[OpenAI] retryable API error (attempt ${attempt + 1}/${maxAttempts}), retry in ${delay}ms:`,
          getErrorMessage(error),
        )
        try {
          await sleepAbortableChunked(delay, signal, unattended, params.onStreamRetryKeepAlive)
        } catch {
          callbacks.onMessageEnd()
          return
        }
        continue
      }
      const err = error as { message?: string; status?: number }
      let errorMessage = err.message || 'Unknown error'
      if (err.status === 401) errorMessage = 'Invalid OpenAI API key.'
      else if (err.status === 429) errorMessage = 'Rate limited. Please wait and retry.'
      else if (err.status === 500 || err.status === 502 || err.status === 503) {
        errorMessage = 'OpenAI server error.'
      }
      callbacks.onError(errorMessage)
      return
    } finally {
      streamWatchdog.dispose()
    }
  }
}
