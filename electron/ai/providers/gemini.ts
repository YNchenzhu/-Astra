/**
 * Google Gemini provider implementation.
 *
 * Extracted from `electron/ai/client.ts` — the dispatcher still lives there and
 * routes `providerId === 'gemini'` to {@link streamGemini}. Everything that
 * only Gemini cares about (`ensureArrayItemsSchema`, the function-declaration
 * shape conversion, the Gemini SDK usage) stays here so `client.ts` can shrink
 * to the cross-provider routing surface.
 *
 * No behavioural change from the original code path — this is a pure move.
 */

import {
  GoogleGenerativeAI,
  type ModelParams,
  type Part,
  type Tool,
} from '@google/generative-ai'
import type { ProviderConfig, StreamCallbacks } from '../client'
import { stripPoleContextUsageFromApiMessages } from '../../context/tokenUsageAccounting'
import {
  convertApiMessagesToGemini,
  type GeminiContent,
} from '../convertApiMessagesToGemini'
import {
  extractThoughtDeltaFromGeminiPart,
  geminiRequestsStructuredThoughtParts,
} from '../geminiNativeThinking'
import { createGeminiTextThoughtSplitter } from '../geminiTextThoughtSplitter'
import {
  computeApiRetryDelayMs,
  defaultStreamExtraRetries,
  isRetryableStreamHttpError,
  isUnattendedRetryModeEnabled,
  parseRetryAfterMsFromError,
  sleepAbortableChunked,
  unattendedWallClockExceeded,
} from '../withRetry'
import { isAbortLikeError } from '../abortLikeError'
import { mergeUserSignalWithStreamWatchdog } from '../streamWatchdog'
import { emitProviderErrorSignal } from '../loopSignalEmit'
import { sanitizeToolSchemaForWire } from '../toolSchemaSanitizer'
import { parseToolArguments } from '../transformer/parseToolArguments'
import { sanitizeMessagesForWire } from '../../utils/unicodeSanitize'
import { mapStopReasonToClaude } from '../stopReasonMap'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Convert Anthropic-format tool definitions to Gemini functionDeclarations format. */
function convertToolsToGeminiFormat(
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
): Array<{
  functionDeclarations: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
  }>
}> {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: sanitizeToolSchemaForWire(t.input_schema, 'gemini-native'),
      })),
    },
  ]
}

export async function streamGemini(
  config: ProviderConfig,
  params: {
    model: string
    messages: {
      role: 'user' | 'assistant'
      content: string | Array<Record<string, unknown>>
    }[]
    systemPrompt?: string
    maxTokens?: number
    tools?: Array<{
      name: string
      description: string
      input_schema: Record<string, unknown>
    }>
    apiMessages?: Array<Record<string, unknown>>
    alwaysThinking?: boolean
    thinkingBudgetTokens?: number
    streamRetries?: number
    contextLengthExceededRef?: { value: boolean }
    onStreamRetryKeepAlive?: () => void
    temperature?: number
    topP?: number
  },
  callbacks: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  let genAI: GoogleGenerativeAI
  try {
    genAI = new GoogleGenerativeAI(config.apiKey)
  } catch (error) {
    // P0 audit fix: client-init failure must also surface a typed envelope
    // so the stream phase's final-promotion (which keys off
    // `state.withheldStreamSignal`) can route this to a terminal
    // model_error instead of silently dropping to 'completed'.
    emitProviderErrorSignal(error, 'gemini', callbacks)
    callbacks.onError(`Failed to initialize Gemini client: ${getErrorMessage(error)}`)
    return
  }

  const retries = params.streamRetries ?? defaultStreamExtraRetries()
  const maxAttempts = Math.max(1, retries + 1)
  let unattendedStartMs: number | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const streamWatchdog = mergeUserSignalWithStreamWatchdog(
      signal,
      `[Gemini] generateContentStream model=${params.model}`,
    )
    try {
      // System prompt routing — IMPORTANT regression fix:
      //
      // The previous code path passed `params.systemPrompt` to
      // `convertApiMessagesToGemini`, which materialized it as a fake
      // `[user("system…"), model("Understood.")]` pair at the front of the
      // contents array. That was a workaround for Gemini 1.0 (no
      // `systemInstruction`), but every currently-shipping model — Gemini
      // 1.5+/2.0+/2.5 — accepts (and pays attention to) a real
      // `systemInstruction` field at the model level. The fake-turn route:
      //   1. Costs extra input tokens on every request (system prompt is
      //      typically 5–15 KB; encoded twice when prompt-caching also
      //      drains tokens).
      //   2. Pollutes the conversation with a fictional user utterance the
      //      model can be asked to repeat / quote.
      //   3. Loses Google's distinction between system constraints and user
      //      requests, e.g. it weakens safety guardrails the model attaches
      //      to system-level instructions specifically.
      // Now we strip systemPrompt from the contents builder and route it
      // through `modelConfig.systemInstruction` like the SDK expects.
      let contents: GeminiContent[]
      const geminiApi = stripPoleContextUsageFromApiMessages(params.apiMessages)
      if (geminiApi) {
        contents = convertApiMessagesToGemini(geminiApi)
      } else {
        contents = convertApiMessagesToGemini(
          params.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })) as Array<Record<string, unknown>>,
        )
      }

      contents = sanitizeMessagesForWire(contents) as GeminiContent[]

      // baseUrl must be passed via requestOptions (2nd arg of getGenerativeModel),
      // NOT via GoogleGenerativeAI constructor (which only accepts apiKey).
      const requestOptions = config.baseUrl ? { baseUrl: config.baseUrl } : undefined

      const genCfg: Record<string, unknown> = {
        maxOutputTokens: params.maxTokens || 8192,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.topP !== undefined ? { topP: params.topP } : {}),
      }
      if (
        callbacks.onThinkingDelta &&
        geminiRequestsStructuredThoughtParts(params.model, params.alwaysThinking)
      ) {
        const cap =
          typeof params.thinkingBudgetTokens === 'number' && params.thinkingBudgetTokens > 0
            ? params.thinkingBudgetTokens
            : 8192
        genCfg.thinkingConfig = {
          includeThoughts: true,
          thinkingBudget: Math.min(cap, 26240),
        }
      }

      const modelConfig: ModelParams = {
        model: params.model,
        generationConfig: genCfg as ModelParams['generationConfig'],
        ...(params.systemPrompt
          ? {
              systemInstruction: {
                role: 'system',
                parts: [{ text: params.systemPrompt }],
              },
            }
          : {}),
        ...(params.tools && params.tools.length > 0 && callbacks.onToolUse
          ? { tools: convertToolsToGeminiFormat(params.tools) as Tool[] }
          : {}),
      }

      const modelConfigForWire = sanitizeMessagesForWire(modelConfig) as ModelParams

      const model = genAI.getGenerativeModel(modelConfigForWire, requestOptions)

      const result = await model.generateContentStream(
        { contents },
        { signal: streamWatchdog.signal },
      )

      let totalChars = 0
      const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = []
      let lastStopReason: string | undefined
      let sawThought = false

      const useInlineTextThoughtSplit =
        Boolean(callbacks.onThinkingDelta) &&
        geminiRequestsStructuredThoughtParts(params.model, params.alwaysThinking)
      const textThoughtSplitter = useInlineTextThoughtSplit
        ? createGeminiTextThoughtSplitter({
            onThinkingDelta: callbacks.onThinkingDelta,
            onTextDelta: callbacks.onTextDelta,
          })
        : null

      for await (const chunk of result.stream) {
        streamWatchdog.touch()
        const candidate = chunk.candidates?.[0]
        if (typeof candidate?.finishReason === 'string' && candidate.finishReason.length > 0) {
          lastStopReason = mapStopReasonToClaude('gemini-native', candidate.finishReason, {
            hasToolUseBlocks: functionCalls.length > 0,
          })
        }
        if (!candidate?.content?.parts) continue

        for (const part of candidate.content.parts as Part[]) {
          const thoughtDelta = extractThoughtDeltaFromGeminiPart(part)
          if (thoughtDelta) {
            sawThought = true
          }
          if (thoughtDelta && callbacks.onThinkingDelta) {
            callbacks.onThinkingDelta(thoughtDelta)
          }
          if ('text' in part && part.text && typeof part.text === 'string') {
            totalChars += part.text.length
            if (textThoughtSplitter) {
              textThoughtSplitter.pushTextChunk(part.text)
            } else {
              callbacks.onTextDelta(part.text)
            }
          } else if ('functionCall' in part && part.functionCall && callbacks.onToolUse) {
            const fc = part.functionCall
            // Robust args extraction: official Gemini SDK delivers `args` as a
            // plain object, but several third-party Gemini-compat gateways
            // (Vertex proxies, self-hosted runtimes, some Chinese aggregators)
            // serialize it as a JSON string. The bare `typeof === 'object'`
            // check used to silently collapse those to `{}`, with the same
            // failure mode we hit on OpenAI2: tool calls land at the
            // registry with empty input → "expected string, received
            // undefined" / "prompt is required". Routing through
            // `parseToolArguments` accepts object / JSON-string / wrapped
            // `{ raw_arguments: ... }` / partial JSON repair paths uniformly.
            // `parseToolArguments` centrally stamps the lenient-repair marker
            // when `jsonrepair` was needed, so a malformed write/edit tool call
            // from a Gemini-compat gateway is refused by the schema rather than
            // executed with heuristically-repaired content.
            const args = parseToolArguments(fc.args)
            functionCalls.push({ name: fc.name, args })
            const p = part as unknown as Record<string, unknown>
            const sig =
              typeof p.thoughtSignature === 'string'
                ? p.thoughtSignature
                : typeof p.thought_signature === 'string'
                  ? p.thought_signature
                  : undefined
            callbacks.onToolUse({
              id: `gemini-${Date.now()}-${functionCalls.length}`,
              name: fc.name,
              input: args,
              ...(typeof sig === 'string' && sig.length > 0
                ? { thoughtSignature: sig }
                : {}),
            })
          }
        }
      }

      textThoughtSplitter?.flush()
      if (!lastStopReason && sawThought && totalChars === 0 && functionCalls.length === 0) {
        lastStopReason = 'max_tokens'
      } else if (lastStopReason === 'end_turn' && functionCalls.length > 0) {
        lastStopReason = 'tool_use'
      }

      // Gemini doesn't return token usage in streaming — approximate from chars.
      callbacks.onMessageEnd({
        inputTokens: 0,
        outputTokens: Math.ceil(totalChars / 4),
        ...(lastStopReason ? { stopReason: lastStopReason } : {}),
      })
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
        emitProviderErrorSignal(watchdogMessage, 'gemini', callbacks)
        callbacks.onError(watchdogMessage)
        return
      }
      // Phase 4 (upstream alignment): classify error into a typed LoopSignal
      // envelope, emit to `onLoopSignal`, and mirror PTL kind to the legacy
      // `contextLengthExceededRef`. Single classification — no regex.
      const { isPromptTooLong } = emitProviderErrorSignal(
        error,
        'gemini',
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
          `[Gemini] retryable API error (attempt ${attempt + 1}/${maxAttempts}), retry in ${delay}ms:`,
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
      if (err.status === 403)
        errorMessage = 'Gemini API key invalid or permissions insufficient.'
      else if (err.status === 429) errorMessage = 'Rate limited. Please wait and retry.'
      else if (err.status === 500 || err.status === 502 || err.status === 503) {
        errorMessage = 'Gemini server error.'
      }
      callbacks.onError(errorMessage)
      return
    } finally {
      streamWatchdog.dispose()
    }
  }
}
