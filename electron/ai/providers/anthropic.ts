/**
 * Anthropic provider implementation.
 *
 * Covers the four SDK variants that share `@anthropic-ai/sdk`'s
 * `messages.stream` / `messages.create` surface:
 *   - Anthropic direct
 *   - AWS Bedrock (`@anthropic-ai/bedrock-sdk`)
 *   - GCP Vertex AI (`@anthropic-ai/vertex-sdk`)
 *   - Azure Foundry (`@anthropic-ai/foundry-sdk`)
 * plus Anthropic-compatible third-party gateways (Kimi / Zhipu / arbitrary
 * Base URL pointing to an Anthropic-compatible endpoint) that reuse the
 * Anthropic SDK with adjusted auth headers.
 *
 * Extracted from `electron/ai/client.ts`. The dispatcher still lives in
 * `client.ts` and routes
 *   providerId ∈ { anthropic, bedrock, vertex, foundry,
 *                  dashscope, minimax, zhipu, kimi, deepseek }
 * to `streamAnthropic`. Process-lifetime fast-mode state lives in the
 * sibling `./anthropicFastModeState.ts` — this module treats it as an
 * opaque dependency.
 */

import Anthropic, { APIError } from '@anthropic-ai/sdk'
import type { ProviderConfig, StreamCallbacks, StreamMessageUsage, StreamTextParams } from '../client'
import { FAST_MODE_BETA_HEADER } from '../../constants/betas'
import {
  ANTHROPIC_EFFORT_BETA_HEADER,
  buildAnthropicStreamBetaHeaders,
  recordAnthropicStreamSuccessForThinkingClearLatch,
  registerAnthropicEffortBetaLatch,
} from '../anthropicBetaHeaderLatch'
import {
  anthropicThinkingRequestBetaTokens,
  buildAnthropicThinkingForStreamRequest,
} from '../anthropicExtendedThinking'
import {
  getAnthropicThinkingApiContext,
  recordAnthropicThinkingStreamSuccess,
} from '../anthropicThinkingApiContext'
import {
  applyAnthropicSingleMessagePromptCache,
  anthropicSystemWireUsesMessageLevelStyleCache,
} from '../anthropicMessagePromptCache'
import { buildAnthropicSystemParam } from '../anthropicSystemWire'
import { applyAnthropicApiMessageInvariants } from '../../context/apiMessageInvariants'
import {
  buildPromptCacheFingerprint,
  logPromptCacheBreakIfChanged,
  serializeSystemForFingerprint,
} from '../promptCacheFingerprint'
import { emitProviderErrorSignal } from '../loopSignalEmit'
import { getAgentContext } from '../../agents/agentContext'
import { suggestReducedMaxTokensForContextError } from '../contextMaxTokensAdjust'
import { mergeUserSignalWithStreamWatchdog } from '../streamWatchdog'
import { releaseStreamResources } from '../releaseStreamResources'
import { mergeConsecutiveUserMessages } from '../../context/mergeConsecutiveUserMessages'
import { stripPoleContextUsageFromApiMessages } from '../../context/tokenUsageAccounting'
import {
  sanitizeToolsForZhipuGateway,
  applyZhipuToolSurfaceToSystem,
} from '../zhipuToolGateway'
import {
  anthropicModelLikelySupportsEffort,
  type SkillEffort,
} from '../../skills/skillEffort'
import {
  computeApiRetryDelayMs,
  defaultStreamExtraRetries,
  isFastModeNotEnabledError,
  isNonCustomOpusModel,
  isRetryableStreamHttpError,
  isUnattendedRetryModeEnabled,
  parseRetryAfterMsFromError,
  readHttpStatus,
  sleepAbortableChunked,
  unattendedWallClockExceeded,
} from '../withRetry'
import { isAbortLikeError } from '../abortLikeError'
import {
  prepareToolsForWire,
  toolsContainInputExamples,
  toolsRequirePtcServerTool,
  defaultExamplesPolicyForWire,
} from '../toolSchemaSanitizer'
import {
  getProviderQuirks,
  quirksIsThirdPartyAnthropicCompat,
  resolveToolExamplesMode,
  resolvePtcEnabled,
  ANTHROPIC_TOOL_EXAMPLES_BETA_TOKEN,
} from '../providerQuirks'
import { stripMessageContentCacheControls } from '../anthropicMessagePromptCache'
import { StreamWriteInputWatcher } from '../streamWriteInputWatcher'
import {
  createToolInputDeltaThrottleState,
  hasPendingThrottledTail,
  shouldEmitToolInputDelta,
  type ToolInputDeltaThrottleState,
} from '../toolInputDeltaThrottle'
import {
  applyLongRetryAfterCooldown,
  disableFastModeGlobally,
  shouldSendFastModeBeta,
} from './anthropicFastModeState'
import { attachThinkingAccumulatorToSdkStream } from '../thinkingBlockAccumulator'

/** Bedrock / Vertex / Foundry clients expose the same `messages.stream` / `messages.create` surface we use. */
type AnthropicStreamingClient = {
  messages: Pick<Anthropic['messages'], 'stream' | 'create'>
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Hosts that speak Anthropic wire but are not api.anthropic.com: they often reject
 * first-party-only `anthropic-beta`, `thinking`, and `output_config.effort`, and may
 * flag repeated 401 retries as abuse.
 *
 * Formerly lived in `client.ts`; moved here because `streamAnthropic` is the sole
 * caller.
 */
function isAnthropicCompatThirdPartyGateway(config: Pick<ProviderConfig, 'id' | 'baseUrl'>): boolean {
  switch (config.id) {
    case 'dashscope':
    case 'minimax':
    case 'zhipu':
    case 'kimi':
    case 'deepseek':
      return true
    case 'anthropic': {
      const u = config.baseUrl?.trim().toLowerCase() ?? ''
      return u.length > 0 && !u.includes('api.anthropic.com')
    }
    default:
      return false
  }
}

function snapshotAnthropicUsageExtras(message: Anthropic.Message): Pick<
  StreamMessageUsage,
  'cacheCreationInputTokens' | 'cacheReadInputTokens'
> {
  const rawUsage = message.usage as unknown as Record<string, unknown> | undefined
  const cc =
    typeof rawUsage?.cache_creation_input_tokens === 'number'
      ? rawUsage.cache_creation_input_tokens
      : undefined
  const cr =
    typeof rawUsage?.cache_read_input_tokens === 'number'
      ? rawUsage.cache_read_input_tokens
      : undefined
  return {
    ...(cc != null && cc > 0 ? { cacheCreationInputTokens: cc } : {}),
    ...(cr != null && cr > 0 ? { cacheReadInputTokens: cr } : {}),
  }
}

/**
 * upstream report §11.1–§11.2 / 附录 A 阶段四：native path streams `text` / `thinking` deltas;
 * each completed `tool_use` content block is surfaced via `onToolUse` as soon as the SDK emits
 * `contentBlock` (StreamingToolExecutor-style **visibility**). The final message pass still drives
 * `onMessageEnd` / usage and **re-emits** any `tool_use` not yet seen (e.g. non-streaming fallback).
 */
/**
 * Extract a normalized PTC `caller` descriptor from a `tool_use` block, if
 * present. Anthropic may shape `caller` as `{ type: 'direct' }` or
 * `{ type: 'code_execution_20260120', tool_id: '...' }`; anything else is
 * treated as absent.
 */
function readPtcCallerFromToolUse(
  block: Record<string, unknown>,
): { type: 'direct' } | { type: 'code_execution_20260120'; tool_id: string } | undefined {
  const c = block.caller
  if (!c || typeof c !== 'object') return undefined
  const obj = c as Record<string, unknown>
  if (obj.type === 'direct') return { type: 'direct' }
  if (obj.type === 'code_execution_20260120' && typeof obj.tool_id === 'string') {
    return { type: 'code_execution_20260120', tool_id: obj.tool_id }
  }
  return undefined
}

function finishAnthropicStreamFromFinalMessage(
  message: Anthropic.Message,
  callbacks: StreamCallbacks,
  opts: {
    anthropicEffort?: SkillEffort
    convId: string | undefined
    /** IDs already delivered via `MessageStream` `contentBlock` in this request attempt. */
    emittedToolUseIds?: Set<string>
    /** PTC `server_tool_use` IDs already surfaced via `contentBlock`. */
    emittedServerToolUseIds?: Set<string>
    /** PTC `code_execution_tool_result` IDs already surfaced. */
    emittedCodeExecResultIds?: Set<string>
    /**
     * Walk `message.content` for `type:'thinking'` blocks and emit them via
     * `onThinkingBlock`. ONLY set this on the non-streaming fallback path
     * (HTTP 529 → `messages.create` retry); the streaming path subscribes
     * to `MessageStream.on('streamEvent', ...)` through
     * {@link createThinkingStreamAccumulator}, which already fires
     * `onThinkingBlock` at each wire-level `content_block_stop` — re-emitting
     * here would double-deliver and risk the renderer's walk-backwards
     * targeting mis-applying a later block's payload to an earlier one.
     */
    emitThinkingBlocksFromFinalMessage?: boolean
  },
): void {
  const emitted = opts.emittedToolUseIds ?? new Set<string>()
  const emittedServer = opts.emittedServerToolUseIds ?? new Set<string>()
  const emittedExecResult = opts.emittedCodeExecResultIds ?? new Set<string>()
  for (const block of message.content) {
    const b = block as unknown as Record<string, unknown> & { type?: string }
    if (
      b.type === 'thinking' &&
      callbacks.onThinkingBlock &&
      opts.emitThinkingBlocksFromFinalMessage === true
    ) {
      // Non-streaming fallback only: replay the assembled block so callers
      // see the same `onThinkingBlock(...)` signal they would on a normal
      // stream. The streaming path skips this branch entirely.
      const th = (block as Anthropic.ThinkingBlock).thinking
      const sig = (block as { signature?: unknown }).signature
      if (typeof th === 'string' && th.length > 0) {
        callbacks.onThinkingBlock({
          thinking: th,
          ...(typeof sig === 'string' && sig.length > 0 ? { signature: sig } : {}),
        })
      }
    } else if (
      // Plan Phase 4 — `redacted_thinking` 块（启用 REDACT_THINKING beta 时
      // 服务端返回的加密 chain-of-thought）的非流式 fallback 路径回放，与
      // thinking 同条件（emitThinkingBlocksFromFinalMessage = true）。
      b.type === 'redacted_thinking' &&
      callbacks.onRedactedThinkingBlock &&
      opts.emitThinkingBlocksFromFinalMessage === true
    ) {
      const data = (b as { data?: unknown }).data
      if (typeof data === 'string' && data.length > 0) {
        callbacks.onRedactedThinkingBlock({
          data,
          startedAtMs: Date.now(),
        })
      }
    } else if (b.type === 'tool_use' && callbacks.onToolUse) {
      const tu = block as Anthropic.ToolUseBlock
      if (emitted.has(tu.id)) continue
      emitted.add(tu.id)
      const sig = (tu as { thoughtSignature?: string }).thoughtSignature
      const caller = readPtcCallerFromToolUse(b)
            callbacks.onToolUse({
        id: tu.id,
        name: tu.name,
        input: (tu.input != null ? tu.input : {}) as Record<string, unknown>,
        ...(typeof sig === 'string' && sig.length > 0 ? { thoughtSignature: sig } : {}),
        ...(caller ? { caller } : {}),
      })
    } else if (b.type === 'server_tool_use' && callbacks.onServerToolUse) {
      // PTC — Claude wrote Python for the sandbox. Surface verbatim.
      const id = typeof b.id === 'string' ? b.id : ''
      if (!id || emittedServer.has(id)) continue
      emittedServer.add(id)
      const rawInput = b.input as Record<string, unknown> | undefined
      const code = typeof rawInput?.code === 'string' ? rawInput.code : ''
      callbacks.onServerToolUse({ id, name: 'code_execution', input: { code } })
    } else if (b.type === 'code_execution_tool_result' && callbacks.onCodeExecutionResult) {
      const tuId = typeof b.tool_use_id === 'string' ? b.tool_use_id : ''
      if (!tuId || emittedExecResult.has(tuId)) continue
      emittedExecResult.add(tuId)
      const content = (b.content ?? {}) as Record<string, unknown>
      callbacks.onCodeExecutionResult({
        toolUseId: tuId,
        stdout: typeof content.stdout === 'string' ? content.stdout : '',
        stderr: typeof content.stderr === 'string' ? content.stderr : '',
        returnCode: typeof content.return_code === 'number' ? content.return_code : 0,
      })
    }
  }
  const extras = snapshotAnthropicUsageExtras(message)
  callbacks.onMessageEnd({
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    stopReason: message.stop_reason == null ? undefined : String(message.stop_reason),
    ...extras,
  })
  if (opts.anthropicEffort) {
    registerAnthropicEffortBetaLatch(opts.convId)
  }
  recordAnthropicStreamSuccessForThinkingClearLatch(opts.convId)
  // Independent timestamp for the upstream-style 1h-idle thinking-clear
  // latch (`anthropicThinkingApiContext.ts`). The upstream-flavoured
  // call above is env-gated; this one runs unconditionally so the
  // server-side `clear_thinking_20251015` strategy switches to the
  // tighter `keep: 1` mode automatically after a long pause.
  //
  // ONLY records on top-level main-agent stream completions — sub-agents
  // inherit the parent's `streamConversationId`, so a long-running sub-
  // agent's mid-task completions would otherwise perpetually refresh
  // the parent's idle timestamp and prevent the latch from ever flipping
  // for the parent. Mirrors the `isAgenticQuery` gate used when the
  // latch is consulted (see `getAnthropicThinkingApiContext` call site).
  recordAnthropicThinkingStreamSuccess(
    opts.convId,
    getAgentContext()?.agentId === 'main',
  )
}

/** §11.4 — non-stream replay after 529 so in-memory transcript matches a normal turn. */
function emitAnthropicNonStreamMessageAsStreamCallbacks(
  message: Anthropic.Message,
  callbacks: StreamCallbacks,
  opts: { anthropicEffort?: SkillEffort; convId: string | undefined },
): void {
  for (const block of message.content) {
    if (block.type === 'text') {
      callbacks.onTextDelta((block as Anthropic.TextBlock).text)
    } else if (block.type === 'thinking' && callbacks.onThinkingDelta) {
      const th = (block as Anthropic.ThinkingBlock).thinking
      if (typeof th === 'string' && th.length > 0) {
        callbacks.onThinkingDelta(th)
      }
    }
  }
  // The non-streaming fallback has no `streamEvent` channel to drive the
  // shared thinking accumulator, so we must replay thinking blocks via
  // the final-message walk. The streaming path passes `false` (default)
  // and lets the accumulator own those emissions.
  finishAnthropicStreamFromFinalMessage(message, callbacks, {
    ...opts,
    emitThinkingBlocksFromFinalMessage: true,
  })
}

function isAnthropic529Overloaded(error: unknown): boolean {
  if (error instanceof APIError) return error.status === 529
  return readHttpStatus(error) === 529
}

export async function streamAnthropic(
  config: ProviderConfig,
  params: StreamTextParams,
  callbacks: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  let client: AnthropicStreamingClient

  try {
    switch (config.id) {
      case 'bedrock': {
        const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
        client = new AnthropicBedrock({
          awsRegion: config.awsRegion || 'us-east-1',
          timeout: 600_000,
        }) as AnthropicStreamingClient
        break
      }
      case 'vertex': {
        const { AnthropicVertex } = await import('@anthropic-ai/vertex-sdk')
        const { GoogleAuth } = await import('google-auth-library')
        const googleAuth = new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          ...(config.projectId && { projectId: config.projectId }),
        })
        client = new AnthropicVertex({
          region: 'us-east5',
          googleAuth,
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          timeout: 600_000,
        }) as AnthropicStreamingClient
        break
      }
      case 'foundry': {
        const { AnthropicFoundry } = await import('@anthropic-ai/foundry-sdk')
        client = new AnthropicFoundry({
          ...(config.baseUrl && { baseURL: config.baseUrl }),
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          timeout: 600_000,
        }) as AnthropicStreamingClient
        break
      }
      case 'kimi': {
        // Moonshot Anthropic 兼容：与 upstream 一致使用 ANTHROPIC_AUTH_TOKEN（SDK: authToken）
        client = new Anthropic({
          apiKey: null,
          authToken: config.apiKey,
          ...(config.baseUrl && { baseURL: config.baseUrl }),
          timeout: 600_000,
        }) as AnthropicStreamingClient
        break
      }
      case 'zhipu': {
        // GLM 编码套餐 / upstream 文档要求 ANTHROPIC_AUTH_TOKEN（Bearer）：
        // https://docs.bigmodel.cn/cn/coding-plan/tool/claude
        // 通用 Claude 兼容示例使用 apiKey（X-Api-Key）：
        // https://docs.bigmodel.cn/cn/guide/develop/claude/introduction#typescript
        // 两类账户密钥相同，网关校验方式不同 — 同时附带两种头以兼容。
        const key = config.apiKey
        client = new Anthropic({
          apiKey: key,
          authToken: key,
          ...(config.baseUrl && { baseURL: config.baseUrl }),
          timeout: 600_000,
        }) as AnthropicStreamingClient
        break
      }
      default: {
        const isThirdPartyBaseUrl =
          config.baseUrl &&
          config.baseUrl.trim().length > 0 &&
          !config.baseUrl.toLowerCase().includes('api.anthropic.com')
        if (isThirdPartyBaseUrl) {
          // Third-party Anthropic-compatible gateways may expect either
          // `X-Api-Key` or `Authorization: Bearer` — send both so either works.
          client = new Anthropic({
            apiKey: config.apiKey,
            authToken: config.apiKey,
            baseURL: config.baseUrl,
            timeout: 600_000,
          }) as AnthropicStreamingClient
        } else {
          client = new Anthropic({
            apiKey: config.apiKey,
            ...(config.baseUrl && { baseURL: config.baseUrl }),
            timeout: 600_000,
          })
        }
      }
    }
  } catch (error) {
    // P0 audit fix: client-init failure must also surface a typed envelope
    // so the stream phase's final-promotion (which now keys off
    // `state.withheldStreamSignal`) can route this to a terminal model_error
    // instead of silently dropping to 'completed' in the noTools branch.
    emitProviderErrorSignal(error, 'anthropic', callbacks)
    callbacks.onError(`Failed to initialize ${config.name} client: ${getErrorMessage(error)}`)
    return
  }

  const retries = params.streamRetries ?? defaultStreamExtraRetries()
  const maxAttempts = Math.max(1, retries + 1)
  let effectiveMaxTokens = params.maxTokens || 8192
  let unattendedStartMs: number | null = null
  let anthropic529Streak = 0

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const streamWatchdog = mergeUserSignalWithStreamWatchdog(
      signal,
      `[${config.name}] anthropic model=${params.model}`,
    )
    let activeStream: ReturnType<AnthropicStreamingClient['messages']['stream']> | null = null
    try {
      const apiForRequest = params.apiMessages
        ? stripPoleContextUsageFromApiMessages(params.apiMessages)
        : undefined
      let requestMessages: Anthropic.MessageParam[] = apiForRequest
        ? (apiForRequest as unknown as Anthropic.MessageParam[])
        : (params.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })) as unknown as Anthropic.MessageParam[])

      if (config.id === 'bedrock') {
        requestMessages = mergeConsecutiveUserMessages(
          requestMessages as unknown as Record<string, unknown>[],
        ) as unknown as Anthropic.MessageParam[]
      }

      // Defensive last-mile invariants. `agenticLoop` normally runs
      // `normalizeMessagesForAPI` which already applies these, but this
      // function is also reachable via direct `streamText` calls that
      // bypass the loop (e.g. side queries, compact LLM calls). All three
      // operations here are idempotent, so running them again is safe
      // (audit Bug 12 — kept as intentional safety net, matching the
      // pattern used in `anthropicCompatHttp`).
      requestMessages = applyAnthropicApiMessageInvariants(
        requestMessages as unknown as Record<string, unknown>[],
      ) as unknown as Anthropic.MessageParam[]

      const systemWire = buildAnthropicSystemParam(
        params.systemPrompt,
        params.systemPromptLayers,
      )

      const skipForkCacheWrite = getAgentContext()?.skipPromptCacheWrite === true
      if (
        !skipForkCacheWrite &&
        process.env.POLE_ANTHROPIC_MESSAGE_CACHE_CONTROL === '1' &&
        !anthropicSystemWireUsesMessageLevelStyleCache(systemWire)
      ) {
        requestMessages = applyAnthropicSingleMessagePromptCache(requestMessages, {
          secondToLastBreakpoint:
            params.anthropicMessagePromptCache?.secondToLastBreakpoint === true,
          providerId: config.id,
        })
      }

      const toolNamesForFp = (params.tools ?? []).map((t) => t.name)
      const fp = buildPromptCacheFingerprint({
        providerId: config.id,
        model: params.model,
        systemSerialized: serializeSystemForFingerprint(
          params.systemPrompt,
          params.systemPromptLayers,
        ),
        toolNames: toolNamesForFp,
      })
      logPromptCacheBreakIfChanged(fp)

      const quirks = getProviderQuirks(config)
      const compatThirdPartyAnthropic =
        isAnthropicCompatThirdPartyGateway(config) || quirksIsThirdPartyAnthropicCompat(quirks)

      // Third-party Anthropic-compatible gateways don't implement prompt
      // caching; passing through `cache_control` either errors (`unknown
      // field`) or wastes compute. Strip it unconditionally on the compat
      // path, even if the caller (env var) asked for it — the request
      // cannot benefit from it anyway.
      if (compatThirdPartyAnthropic) {
        stripMessageContentCacheControls(requestMessages as unknown as Anthropic.MessageParam[])
      }

      // System: most Anthropic-compatible gateways reject the text-block
      // array form. Coerce to a string when quirks say so.
      let effectiveSystem: string | Anthropic.TextBlockParam[] | undefined = systemWire
      if (quirks.systemMustBeString && Array.isArray(effectiveSystem)) {
        effectiveSystem = (effectiveSystem as Anthropic.TextBlockParam[])
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n\n')
          .trim()
        if (!effectiveSystem) effectiveSystem = undefined
      }

      const requestParams: Anthropic.MessageCreateParams = {
        model: params.model,
        max_tokens: effectiveMaxTokens,
        system: effectiveSystem as Anthropic.MessageCreateParams['system'],
        messages: requestMessages,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.topP !== undefined ? { top_p: params.topP } : {}),
      }

      let toolsCarryExamples = false
      let toolsCarryPtc = false
      if (params.tools && params.tools.length > 0) {
        // Preserve legacy Zhipu-specific description cap even when quirks
        // specify a higher one, since the gateway has additional hidden
        // limits the generic cap doesn't cover.
        const preSanitized =
          config.id === 'zhipu' ? sanitizeToolsForZhipuGateway(params.tools) : params.tools

        const examplesMode = resolveToolExamplesMode(quirks, params.model)
        const ptcActive = resolvePtcEnabled(quirks, params.model)

        const examplesPolicy =
          examplesMode === 'native'
            ? defaultExamplesPolicyForWire(quirks.wire, true)
            : examplesMode === 'description-fallback'
              ? 'description-fallback'
              : 'drop'

        const sanitized = prepareToolsForWire(preSanitized as unknown as Array<
          Anthropic.Tool & {
            description: string
            input_examples?: Array<Record<string, unknown>>
            allowed_callers?: string[]
          }
        >, quirks.wire, {
          maxToolDescriptionChars: quirks.maxToolDescriptionChars,
          examples: examplesPolicy,
          ptcEnabled: ptcActive,
        })
        toolsCarryExamples = toolsContainInputExamples(sanitized)
        toolsCarryPtc = toolsRequirePtcServerTool(sanitized)

        // PTC active → prepend the server-managed code_execution tool entry.
        // Its presence is what tells Anthropic's backend to spin up the Python
        // sandbox and execute tools flagged with `allowed_callers`.
        const wireTools: Array<Record<string, unknown>> = [...(sanitized as unknown as Array<Record<string, unknown>>)]
        if (toolsCarryPtc) {
          wireTools.unshift({
            type: 'code_execution_20260120',
            name: 'code_execution',
          })
        }
        requestParams.tools = wireTools as unknown as Anthropic.Tool[]

        if (params.toolChoice) {
          // PTC is incompatible with `tool_choice` forcing a specific tool.
          // When PTC is live we fall back to letting the model decide.
          if (toolsCarryPtc && typeof params.toolChoice !== 'string') {
            // Drop the object form silently; the auto-selection path is safest.
          } else {
            requestParams.tool_choice =
              params.toolChoice === 'auto' || params.toolChoice === 'any'
                ? { type: params.toolChoice }
                : { type: 'tool', name: params.toolChoice.name }
          }
        }

        // Zhipu / GLM hallucination guard — the model frequently "forgets" or
        // downplays non-core builtins (Edit, Agent, WebSearch, MCP bridges)
        // even when they are on the wire. Appending an explicit tool-name
        // whitelist to the system prompt eliminates that class of failure.
        // The helper existed all along but was never wired in; without it
        // users saw: "other providers see all tools, but Zhipu doesn't".
        if (config.id === 'zhipu') {
          const wireToolNames = (requestParams.tools ?? [])
            .map((t) => {
              const name = (t as { name?: unknown }).name
              return typeof name === 'string' ? name : ''
            })
            .filter(Boolean)
          effectiveSystem = applyZhipuToolSurfaceToSystem(
            effectiveSystem,
            wireToolNames,
          )
          requestParams.system =
            effectiveSystem as Anthropic.MessageCreateParams['system']
        }
      }

      let anthropicEffort: SkillEffort | undefined = quirks.supportsEffort ? params.effort : undefined
      if (anthropicEffort && !anthropicModelLikelySupportsEffort(params.model)) {
        anthropicEffort = undefined
      }
      if (anthropicEffort) {
        requestParams.output_config = {
          ...(requestParams.output_config ?? {}),
          effort: anthropicEffort,
        }
      }

      const thinkingParam = quirks.supportsThinkingBlocks
        ? buildAnthropicThinkingForStreamRequest({
            model: params.model,
            maxOutputTokens: effectiveMaxTokens,
            alwaysThinking: params.alwaysThinking,
            providerSupportsThinking: true,
          })
        : null
      if (thinkingParam) {
        ;(requestParams as Anthropic.MessageCreateParams & { thinking?: typeof thinkingParam }).thinking =
          thinkingParam
      }

      const convId = getAgentContext()?.streamConversationId
      const streamBetaTokens: string[] = []
      // upstream-style server-side thinking-context controls (P1/P2/P3 of
      // the "reduce historical thinking impact on hallucination"
      // initiative). Only first-party Anthropic API supports the
      // `anthropic-beta` header AND the `context_management` body field;
      // Bedrock/Vertex/Foundry would need extra_body / additional model
      // request fields plumbing — left for a follow-up. Third-party
      // Anthropic-compat gateways (DeepSeek/Zhipu/etc.) ignore betas.
      const apiThinkingContext =
        !compatThirdPartyAnthropic && quirks.supportsBetaHeaders
          ? getAnthropicThinkingApiContext({
              hasThinkingActiveOnRequest: !!thinkingParam,
              model: params.model,
              conversationId: convId,
              // `isAgenticQuery` heuristic: a stream that's part of a
              // top-level agent loop carries a `streamConversationId`.
              // Sub-agents and side queries either don't (`agentId !==
              // 'main'`) or are short-lived enough that gating by convId
              // presence is a sufficient proxy without threading a new
              // boolean through every call site.
              isAgenticQuery:
                getAgentContext()?.agentId === 'main' && !!convId?.trim(),
              disableInterleaved:
                process.env.POLE_DISABLE_INTERLEAVED_THINKING === '1',
            })
          : { extraBetas: [], contextManagement: undefined, isRedactThinkingActive: false }
      if (!compatThirdPartyAnthropic) {
        if (shouldSendFastModeBeta(params, convId)) {
          streamBetaTokens.push(FAST_MODE_BETA_HEADER)
        }
        if (anthropicEffort) streamBetaTokens.push(ANTHROPIC_EFFORT_BETA_HEADER)
        streamBetaTokens.push(...anthropicThinkingRequestBetaTokens(!!thinkingParam))
        // P1/P2/P3 betas — see `anthropicThinkingApiContext.ts` for the
        // per-token rationale. Order doesn't matter (header is comma-
        // separated); de-dup is handled by the latch builder downstream.
        streamBetaTokens.push(...apiThinkingContext.extraBetas)
        // Advanced tool use — attach the Examples beta when any tool carries
        // `input_examples` on the wire. (PTC is GA on the first-party API and
        // needs no beta token; Bedrock/Vertex/Foundry are disabled upstream.)
        if (toolsCarryExamples && quirks.supportsToolExamples) {
          streamBetaTokens.push(ANTHROPIC_TOOL_EXAMPLES_BETA_TOKEN)
        }
      }
      // P2: server-side `clear_thinking_20251015` strategy. Only set when
      // the helper produced one (currently means: thinking-active turn,
      // not redacted, on a model that supports the beta).
      if (apiThinkingContext.contextManagement) {
        ;(requestParams as Anthropic.MessageCreateParams & {
          context_management?: typeof apiThinkingContext.contextManagement
        }).context_management = apiThinkingContext.contextManagement
      }
      const streamBetaHeaders = buildAnthropicStreamBetaHeaders({
        conversationId: convId,
        requestBetaTokens: streamBetaTokens,
      })
      const streamOpts =
        Object.keys(streamBetaHeaders).length > 0
          ? { signal: streamWatchdog.signal, headers: streamBetaHeaders }
          : { signal: streamWatchdog.signal }

      
      activeStream = client.messages.stream(requestParams, streamOpts)

      // @anthropic-ai/sdk `MessageStream` will emit a bare `Promise.reject(error)`
      // on abort/error when NEITHER a promise-returning method (done/finalMessage/…)
      // has been awaited yet NOR any `error`/`abort` listener is attached. That
      // path fires between `.stream()` returning and our `await finalMessage()`
      // settling — specifically whenever an in-flight abort races the consumer
      // (e.g. tool-summary 10s timeout, parent abort during retry, stream end
      // with a trailing abort). Register no-op listeners to unconditionally
      // suppress the SDK's unhandled-rejection fallback; the real error path is
      // still delivered through `finalMessage()` / `#endPromise` into our
      // surrounding try/catch, so nothing gets swallowed silently.
      activeStream.on('error', () => {
        /* unhandled-rejection suppressor — real error flows through finalMessage() */
      })
      activeStream.on('abort', () => {
        /* unhandled-rejection suppressor — real abort flows through finalMessage() */
      })

      const emittedToolUseIds = new Set<string>()
      const emittedServerToolUseIds = new Set<string>()
      const emittedCodeExecResultIds = new Set<string>()

      // C-grade Write preflight: hook the low-level `streamEvent` channel
      // and watch for a `Write` tool_use whose `filePath` arrives early in
      // the input JSON. The moment we can prove the call will be rejected
      // (any existing file on disk), we:
      //   1. emit a synthetic `onToolUse` with just the parsed `filePath`,
      //      so the StreamingToolExecutor's B-grade gate generates the
      //      "use Edit" tool_result on the next loop iteration;
      //   2. mark the id in `emittedToolUseIds` so the SDK's eventual
      //      `contentBlock` / `finalMessage` re-emit (if any) is dropped;
      //   3. call `activeStream.abort()` to stop the underlying HTTP
      //      request, saving the bulky `content` token stream.
      // The abort flows through the existing `isAbortLikeError` catch and
      // ends the stream cleanly via `onMessageEnd()`.
      const writeWatcher = new StreamWriteInputWatcher()
      // Per-block accumulators for IDE-style live writing. The
      // SDK's `streamEvent` is the only place input_json_delta chunks
      // are surfaced (the `contentBlock` listener already has the
      // fully-assembled `input`). We keep our own accumulator instead
      // of asking the watcher for its internal `partialJson` because
      // the watcher's buffer can be cleared early (bailout / confirmed
      // safe) and would not carry the full args we need to forward.
      interface ToolInputAccumulator {
        id: string
        name: string
        args: string
        throttle: ToolInputDeltaThrottleState
      }
      const toolInputAccumulators = new Map<number, ToolInputAccumulator>()
      if (callbacks.onToolUse || callbacks.onToolInputDelta) {
        activeStream.on('streamEvent', (event: Record<string, unknown> | null | undefined) => {
          if (!event || typeof event !== 'object') return
          const t = (event as { type?: unknown }).type
          if (t === 'content_block_start') {
            const idx = (event as { index?: unknown }).index
            const cb = (event as { content_block?: Record<string, unknown> }).content_block
            if (typeof idx !== 'number' || !cb) return
            if (cb.type === 'tool_use' && typeof cb.id === 'string' && typeof cb.name === 'string') {
              writeWatcher.registerToolUseBlock(idx, { id: cb.id, name: cb.name })
              if (callbacks.onToolInputDelta) {
                toolInputAccumulators.set(idx, {
                  id: cb.id,
                  name: cb.name,
                  args: '',
                  throttle: createToolInputDeltaThrottleState(),
                })
              }
            }
            return
          }
          if (t === 'content_block_delta') {
            const idx = (event as { index?: unknown }).index
            const delta = (event as { delta?: Record<string, unknown> }).delta
            if (typeof idx !== 'number' || !delta) return
            if (
              delta.type === 'input_json_delta' &&
              typeof delta.partial_json === 'string' &&
              delta.partial_json.length > 0
            ) {
              const rej = writeWatcher.feedInputJsonDelta(idx, delta.partial_json)
              if (rej) {
                // Suppress any later re-emit of this id by the contentBlock
                // listener or the finalMessage replay path. The synthetic
                // tool_use we are about to emit IS the canonical record.
                emittedToolUseIds.add(rej.toolUse.id)
                // Also drop any pending input accumulator so we don't
                // race a late `onToolInputDelta` past the synthetic
                // tool_use ship — the synthetic record is canonical.
                toolInputAccumulators.delete(idx)
                try {
                  callbacks.onToolUse?.(rej.toolUse)
                } catch {
                  /* listener errors must not survive into the abort path */
                }
                try {
                  activeStream?.abort()
                } catch {
                  /* SDK abort is best-effort — stream may already be tearing down */
                }
                return
              }
              // the IDE live-writing surface: append + throttle.
              const acc = toolInputAccumulators.get(idx)
              if (acc && callbacks.onToolInputDelta) {
                acc.args += delta.partial_json
                const now = Date.now()
                if (shouldEmitToolInputDelta(acc.throttle, acc.args.length, now)) {
                  acc.throttle.lastEmitAt = now
                  acc.throttle.lastEmittedLength = acc.args.length
                  callbacks.onToolInputDelta({
                    toolUseId: acc.id,
                    toolName: acc.name,
                    partialJson: acc.args,
                  })
                }
              }
            }
            return
          }
          if (t === 'content_block_stop') {
            const idx = (event as { index?: unknown }).index
            if (typeof idx !== 'number') return
            writeWatcher.releaseBlock(idx)
            // Final force-flush of the throttled tail BEFORE the
            // `contentBlock` listener fires `onToolUse` (the SDK
            // emits `streamEvent` for content_block_stop first, then
            // the assembled `contentBlock` event). Mirrors the
            // anthropic-compat-http invariant: the last partialJson
            // observed by the renderer is always a fully-closed
            // object, so the live-writing card's
            // `parsePartialEditInput` returns `complete: true` and the
            // caret disappears one frame before the card swaps to
            // `tool_start.input`.
            const acc = toolInputAccumulators.get(idx)
            if (
              acc &&
              callbacks.onToolInputDelta &&
              hasPendingThrottledTail(acc.throttle, acc.args.length)
            ) {
              callbacks.onToolInputDelta({
                toolUseId: acc.id,
                toolName: acc.name,
                partialJson: acc.args,
              })
            }
            toolInputAccumulators.delete(idx)
          }
        })
      }

      // Always attach the contentBlock listener when PTC-capable callbacks are
      // present OR plain onToolUse is set, so we can catch server_tool_use /
      // code_execution_tool_result blocks as they arrive.
      if (
        callbacks.onToolUse ||
        callbacks.onServerToolUse ||
        callbacks.onCodeExecutionResult
      ) {
        activeStream.on(
          'contentBlock',
          (block: Anthropic.ContentBlock | Record<string, unknown>) => {
            streamWatchdog.touch()
            const b = block as Record<string, unknown> & { type?: string }

            if (b.type === 'tool_use' && callbacks.onToolUse) {
              const tu = block as Anthropic.ToolUseBlock
              if (emittedToolUseIds.has(tu.id)) return
              emittedToolUseIds.add(tu.id)
              const sig = (tu as { thoughtSignature?: string }).thoughtSignature
              const caller = readPtcCallerFromToolUse(b)
              callbacks.onToolUse({
                id: tu.id,
                name: tu.name,
                input: (tu.input != null ? tu.input : {}) as Record<string, unknown>,
                ...(typeof sig === 'string' && sig.length > 0 ? { thoughtSignature: sig } : {}),
                ...(caller ? { caller } : {}),
              })
              return
            }

            if (b.type === 'server_tool_use' && callbacks.onServerToolUse) {
              const id = typeof b.id === 'string' ? b.id : ''
              if (!id || emittedServerToolUseIds.has(id)) return
              emittedServerToolUseIds.add(id)
              const rawInput = b.input as Record<string, unknown> | undefined
              const code = typeof rawInput?.code === 'string' ? rawInput.code : ''
              callbacks.onServerToolUse({
                id,
                name: 'code_execution',
                input: { code },
              })
              return
            }

            if (
              b.type === 'code_execution_tool_result' &&
              callbacks.onCodeExecutionResult
            ) {
              const tuId = typeof b.tool_use_id === 'string' ? b.tool_use_id : ''
              if (!tuId || emittedCodeExecResultIds.has(tuId)) return
              emittedCodeExecResultIds.add(tuId)
              const content = (b.content ?? {}) as Record<string, unknown>
              callbacks.onCodeExecutionResult({
                toolUseId: tuId,
                stdout: typeof content.stdout === 'string' ? content.stdout : '',
                stderr: typeof content.stderr === 'string' ? content.stderr : '',
                returnCode:
                  typeof content.return_code === 'number' ? content.return_code : 0,
              })
            }
          },
        )
      }

      activeStream.on('text', (text: string) => {
        streamWatchdog.touch()
        callbacks.onTextDelta(text)
      })

      // Per-content-block `type:'thinking'` accumulator, fed by the raw
      // `streamEvent` channel (the SDK's `'thinking'` aggregate event
      // collapses indexes and only delivers thinking_delta text; we need
      // `content_block_start/delta/stop` so onThinkingBlock fires AT
      // each block's wire-level stop — matching the HTTP-compat path and
      // avoiding the "all blocks complete in one burst at finalMessage()"
      // ordering hazard the renderer's walk-backwards targeting relied on.
      // See `electron/ai/thinkingBlockAccumulator.ts` for the contract +
      // `thinkingBlockAccumulator.test.ts` for the wiring + accumulator unit tests.
      const thinkingAcc = attachThinkingAccumulatorToSdkStream(activeStream, {
        onThinkingDelta: callbacks.onThinkingDelta
          ? (text: string) => {
              streamWatchdog.touch()
              callbacks.onThinkingDelta!(text)
            }
          : undefined,
        onThinkingStart: callbacks.onThinkingStart,
        onThinkingComplete: callbacks.onThinkingComplete,
        onThinkingBlock: callbacks.onThinkingBlock,
      })

      // Plan Phase 4 — `redacted_thinking` 流式回放：服务端启用
      // REDACT_THINKING beta 时 content_block_start 直接带完整 `data`
      // （没有 delta，没有 stop 时再补 — 整块一次到位）。无需 accumulator
      // 状态机，直接 listen `streamEvent` 找 type='redacted_thinking' 即可。
      if (callbacks.onRedactedThinkingBlock) {
        activeStream.on('streamEvent', (event: unknown) => {
          if (!event || typeof event !== 'object') return
          const ev = event as {
            type?: string
            content_block?: { type?: string; data?: string }
          }
          if (ev.type !== 'content_block_start') return
          if (ev.content_block?.type !== 'redacted_thinking') return
          const data = ev.content_block.data
          if (typeof data !== 'string' || data.length === 0) return
          streamWatchdog.touch()
          callbacks.onRedactedThinkingBlock!({
            data,
            startedAtMs: Date.now(),
          })
        })
      }

      try {
        const message = await activeStream.finalMessage()
        anthropic529Streak = 0
        // EOS safety net: if the underlying stream closed without a
        // wire-level content_block_stop for an outstanding thinking
        // block (rare — observed on some forwarding proxies), flush the
        // remaining accumulators so callers still see the assembled
        // block + trailing onThinkingComplete bracket.
        thinkingAcc.flushAll()
        finishAnthropicStreamFromFinalMessage(message, callbacks, {
          anthropicEffort,
          convId,
          emittedToolUseIds,
          emittedServerToolUseIds,
          emittedCodeExecResultIds,
        })
      } catch (streamFinErr: unknown) {
        const can529Fallback =
          isAnthropic529Overloaded(streamFinErr) &&
          activeStream &&
          process.env.POLE_DISABLE_ANTHROPIC_529_STREAM_FALLBACK !== '1'
        if (can529Fallback) {
          anthropic529Streak++
          releaseStreamResources({ anthropicMessageStream: activeStream })
          activeStream = null
          console.warn(
            `[${config.name}] HTTP 529 overloaded — releasing stream and falling back to non-streaming request`,
          )
          callbacks.onStreamingFallback?.({ status: 529, reason: 'overloaded' })
          try {
            const message = (await client.messages.create(
              { ...(requestParams as unknown as Record<string, unknown>), stream: false } as Anthropic.MessageCreateParams,
              streamOpts,
            )) as Anthropic.Message
            anthropic529Streak = 0
            emitAnthropicNonStreamMessageAsStreamCallbacks(message, callbacks, {
              anthropicEffort,
              convId,
            })
          } catch (createErr: unknown) {
            if (isAnthropic529Overloaded(createErr)) anthropic529Streak++
            throw createErr
          }
        } else {
          if (isAnthropic529Overloaded(streamFinErr)) anthropic529Streak++
          throw streamFinErr
        }
      }
      return
    } catch (error) {
      if (isAbortLikeError(error)) {
        // Distinguish a user-initiated cancel from a watchdog-induced abort
        // (TTFB / idle timeout). Only the former leaves the user's `signal`
        // aborted. A watchdog abort fires on `streamWatchdog.signal` while
        // the user's `signal` is still live — surfacing it as an error stops
        // the agentic loop from treating a dead/stalled stream as an empty
        // "completed" turn (silent failure). Mirrors the fetch-based paths
        // (`anthropicCompatHttp` / `compatibleClient`).
        if (signal.aborted) {
          callbacks.onMessageEnd()
          return
        }
        const watchdogMessage = `${config.name}: 流式连接被守卫中止（上游长时间未返回数据：首字节超时或流中途空闲超时；常见原因：网关排队/挂起、代理超时、网络不稳定）。请检查网络与 baseUrl 是否可达后重试。`
        emitProviderErrorSignal(watchdogMessage, 'anthropic', callbacks)
        callbacks.onError(watchdogMessage)
        return
      }

      // Phase 4 (upstream alignment): classify error into a typed
      // LoopSignal envelope, emit to `onLoopSignal`, and mirror PTL
      // kind to the legacy `contextLengthExceededRef` so the loop's
      // reactive-compact block sees `result.contextLengthExceeded === true`.
      // Single classification — no regex on the rendered error message.
      const { isPromptTooLong } = emitProviderErrorSignal(
        error,
        'anthropic',
        callbacks,
        params.contextLengthExceededRef,
      )
      if (isPromptTooLong) {
        return
      }

      const reduced = suggestReducedMaxTokensForContextError(error, effectiveMaxTokens)
      if (reduced !== null && attempt < maxAttempts - 1) {
        effectiveMaxTokens = reduced
        console.warn(
          `[${config.name}] Retrying with max_tokens=${effectiveMaxTokens} after context/max_tokens overload`,
        )
        continue
      }

      const convIdForRetry = getAgentContext()?.streamConversationId
      if (error instanceof APIError && error.status === 400 && isFastModeNotEnabledError(error)) {
        disableFastModeGlobally()
      }

      const retryAfterMs = parseRetryAfterMsFromError(error)
      applyLongRetryAfterCooldown(convIdForRetry, retryAfterMs, params.anthropicFastMode === true)

      const unattended = isUnattendedRetryModeEnabled()
      if (unattended && unattendedStartMs == null) unattendedStartMs = Date.now()

      if (
        isRetryableStreamHttpError(error) &&
        attempt < maxAttempts - 1 &&
        !(unattended && unattendedWallClockExceeded(unattendedStartMs))
      ) {
        const delay = computeApiRetryDelayMs(attempt, {
          retryAfterMs,
          unattended,
        })
        console.warn(
          `[${config.name}] retryable API error (attempt ${attempt + 1}/${maxAttempts}), retry in ${delay}ms:`,
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

      const fallbackModel = params.anthropicOverloadFallbackModel?.trim()
      const ref = params.anthropicOverloadFallbackModelRef
      if (
        anthropic529Streak >= 3 &&
        fallbackModel &&
        ref &&
        isNonCustomOpusModel(params.model)
      ) {
        ref.value = fallbackModel
        return
      }

      if (error instanceof APIError) {
        let errorMessage = error.message || 'Unknown error'
        if (error.status === 401) {
          const body = error.error as Record<string, unknown> | undefined
          const nested =
            body &&
            typeof body.error === 'object' &&
            body.error !== null &&
            typeof (body.error as { message?: unknown }).message === 'string'
              ? (body.error as { message: string }).message
              : typeof body?.message === 'string'
                ? body.message
                : ''
          const detail = nested ? `${nested} ` : ''
          errorMessage = `HTTP 401 — ${detail}${errorMessage}`
          if (config.id === 'zhipu') {
            errorMessage +=
              '（智谱：若使用 GLM 编码套餐 / Claude Code，请核对套餐与密钥是否与文档一致：https://docs.bigmodel.cn/cn/coding-plan/tool/claude ；通用 Claude 兼容见：https://docs.bigmodel.cn/cn/guide/develop/claude/introduction#typescript ；baseURL 应为 https://open.bigmodel.cn/api/anthropic）'
          }
        } else if (error.status === 429) {
          errorMessage = 'Rate limited. Please wait and retry.'
        } else if (error.status === 529) {
          errorMessage = 'API temporarily overloaded (529). Non-streaming fallback failed — please retry.'
        } else if (error.status === 500 || error.status === 503) {
          errorMessage = `${config.name} server error.`
        }
        callbacks.onError(errorMessage)
        return
      }

      const err = error as { message?: string; status?: number }
      let errorMessage = err.message || 'Unknown error'
      if (err.status === 401) errorMessage = `Invalid API key for ${config.name}.`
      else if (err.status === 429) errorMessage = 'Rate limited. Please wait and retry.'
      else if (err.status === 529) {
        errorMessage = 'API temporarily overloaded (529). Non-streaming fallback failed — please retry.'
      } else if (err.status === 500 || err.status === 503) errorMessage = `${config.name} server error.`
      callbacks.onError(errorMessage)
      return
    } finally {
      if (activeStream) {
        releaseStreamResources({ anthropicMessageStream: activeStream })
      }
      streamWatchdog.dispose()
    }
  }
}
