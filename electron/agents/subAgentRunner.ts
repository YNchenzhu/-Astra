/**
 * Sub-agent execution engine.
 *
 * Runs a sub-agent by invoking the existing agentic loop with a filtered
 * tool set and the agent's system prompt. The core insight is that a sub-agent
 * is just a regular agentic loop with different parameters.
 */

import type { ProviderConfig } from '../ai/client'
import type { AgentId } from '../tools/ids'
import { asAgentId } from '../tools/ids'
import { runOrchestratedSubAgent } from '../orchestration/runOrchestratedSubAgent'
import type { AgenticLoopResult } from '../ai/loopEvents'
import type {
  AgentDefinitionUnion,
  SubAgentResult,
  SubAgentEvent,
} from './types'
import { createInitialKernelLoopState } from '../orchestration/kernelTypes'
import { normalizeMcpServerNameList } from './normalizeAgentMcpServers'
import { getAgentContext, runWithAgentContextAsync } from './agentContext'
import { logAsyncAgentPhase, registerAsyncAgent } from './asyncAgentLifecycle'
import { ensureMcpServersConnected } from '../mcp/handlers'
import { getWorkspacePath } from '../tools/workspaceState'
import { loadTeamFile } from '../tools/TeamCreateTool'
import { sendTeammateIdleNotification } from './teamIdleNotifier'
import { requestTeamMemberIdleWake } from './mainAgentWakeup'
import { toolRegistry } from '../tools/registry'
import { getActiveBundle } from './bundles/bundleRegistryQueries'
import {
  fireSubagentHooks,
  fireSubagentStartHooks,
  fireTeammateIdleHooks,
} from '../tools/hooks/runtimeHookBridges'
import { buildQueryContextCacheKey } from '../context/queryContextCacheKey'
import { ensureTeamMember } from '../tools/TeamCreateTool'
import type { ActiveAgent } from './types'
import {
  registerActiveAgent,
  unregisterActiveAgent,
  getActiveAgent,
  waitForAgentMailboxOrAbort,
} from './activeAgentRegistry'
import { trackAgentInOrchestrator } from './agentLifecycle'
import { getMultiAgentOrchestrator } from './multiAgentOrchestratorSingleton'
import { recordSubAgentOrchestrationOutcome } from '../orchestration/store'
import { getToolUseIdFromStopScope } from '../ai/toolExecutionScope'
import { taskRuntimeStore } from '../tools/TaskRuntimeStore'
import {
  type SystemPromptLayers,
} from '../ai/systemPrompt'
import { FORK_SUBAGENT_MAX_ITERATIONS } from './forkSubagent'
import { MAX_AGENT_DEPTH, MAX_ITERATIONS } from '../constants/toolLimits'
import { agentQuerySource } from './querySource'
import { generateQueryChainId } from './queryTracking'
import {
  initSubAgentSidechain,
  appendSubAgentSidechain,
} from './subAgentSidechainTranscript'
import { finalizeSubAgentLifecycle } from './subAgentLifecycleCleanup'
import { acquireSubAgentMcpLease } from '../mcp/subAgentMcpLease'
import type { AgentDefinitionPermissionMode } from './types'
import { resolveInheritedTaskBudgetMs } from './subAgentInheritance'
import { getPermissionMode } from '../ai/interactionState'
import { resolveSubAgentPermissionOverride } from './resolveSubAgentPermissionOverride'
import { buildTeammateRuntimeContext } from './teammateIdentity'
import { mergeEnvTaskBudgetIntoAgentDef } from './subAgentModelEnv'
import { createSubAgentRunState } from './subAgentRunContext'
import { assembleSubAgentPrompt } from './subAgentPromptAssembly'
import { createSubAgentLoopCallbacks } from './subAgentLoopCallbacks'

// Compat re-export retained only for `resolveAgentTools.test.ts` and any
// historical callers. New code should import directly from
// `./subAgentToolResolver`. `toolsToApiDefinitions` is intentionally
// **not** re-exported here — that was a transport-layer reverse dependency
// (ai/streamHandler → agents/runner) and has been removed.
export { resolveAgentTools } from './subAgentToolResolver'
import { resolveAgentTools, toolsToApiDefinitions } from './subAgentToolResolver'
// findAgentDefinition moved to its own module (file-split refactor); re-export
// kept so existing `import { findAgentDefinition } from './subAgentRunner'`
// call sites (agentTool, teamAutoLauncher, REPLTool, sendMessageDiskRecovery,
// findAgentDefinition.test) keep resolving from here.
export { findAgentDefinition } from './findAgentDefinition'
import {
  buildAgentDepthRejectionMessage,
} from './subAgentPrompts'
import { maybeRunInWorker } from './subAgentWorkerDispatch'
import {
  resolveSubAgentReportedOutputDetail,
  subAgentProducedUsableReport,
} from './subAgentOutputResolver'
import { extractLastAssistantText } from './extractTranscriptText'
import { decideSubagentRetry } from './subAgentRetryPolicy'
import {
  resolveFinalSummaryRescueBudgetMs,
  runSubAgentFinalSummaryRescue,
  shouldRunFinalSummaryRescue,
} from './subAgentFinalSummary'

// Compat re-export so existing callers (`subAgentRunner.p1-bugs.test.ts`,
// any downstream consumer) keep working after the resolver moved to its
// own module. New code should import directly from
// `./subAgentOutputResolver`.
export {
  resolveSubAgentReportedOutput,
  resolveSubAgentReportedOutputDetail,
} from './subAgentOutputResolver'

// Compat re-export so external callers
// (`teamAutoLauncher.ts` reads `READONLY_AGENT_TYPES`;
// `subAgentRunner.p1-bugs.test.ts` reads `shouldAbortReadonlyBudgetAfterMessageEnd`)
// keep working after the budget constants & helpers moved to their own
// module. New code should import directly from `./subAgentReadonlyBudget`.
export {
  READONLY_AGENT_TYPES,
  shouldAbortReadonlyBudgetAfterMessageEnd,
} from './subAgentReadonlyBudget'

// `SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS`, `resolveSubAgentReportedOutput`,
// and `resolveSubAgentReportedOutputDetail` are now defined in
// `./subAgentOutputResolver` and re-exported above. Both spawn paths
// (in-process here, worker_threads in `subAgentWorkerClient.ts`) call
// the same resolver so the parent agent sees identical output
// regardless of which path was taken.

// ========== Sub-Agent Execution ==========

let agentCounter = 0

function generateAgentId(): AgentId {
  agentCounter++
  return asAgentId(`agent-${Date.now()}-${agentCounter}`)
}

function cloneApiMessagesDeep(msgs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(msgs)
    }
  } catch {
    /* ignore */
  }
  // P1-2: JSON fallback also needs guarding. Circular references / BigInt /
  // Symbol values would otherwise throw and abort the mailbox-continuation
  // path that depends on this clone. Returning the original reference under
  // failure preserves liveness; the next iteration's `syncAgentContextConversation`
  // (P1-1) will re-deep-clone before mutating.
  try {
    return JSON.parse(JSON.stringify(msgs)) as Array<Record<string, unknown>>
  } catch (err) {
    console.warn(
      '[subAgentRunner] cloneApiMessagesDeep JSON fallback failed; returning original reference:',
      err instanceof Error ? err.message : String(err),
    )
    return msgs
  }
}

/**
 * Run a sub-agent with the given parameters.
 *
 * 1. Resolves the agent's tools
 * 2. Builds the agent's message list (optionally forking parent context)
 * 3. Runs the agentic loop with the agent's system prompt and filtered tools
 * 4. Collects events and returns the result
 */
export async function runSubAgent(params: {
  config: ProviderConfig
  model: string
  agentDef: AgentDefinitionUnion
  prompt: string
  description?: string
  name?: string
  teamName?: string
  /** Background agents pre-register with a fixed id — do not register twice. */
  agentIdOverride?: AgentId | string
  parentMessages?: Array<Record<string, unknown>>
  /** When false, parentMessages already ends with the task (fork); do not append `prompt` again. */
  appendParentPrompt?: boolean
  parentSystemPrompt?: string
  signal: AbortSignal
  onEvent: (event: SubAgentEvent) => void
  /**
   * Background workers: after each natural agentic-loop completion, stay `running` in the registry
   * and wait for `SendMessage` / mailbox, then continue the same transcript (until abort or timeout).
   */
  stayRunningForSendMessage?: boolean
  /** Report §3.1 — overrides global chat permission mode for this sub-agent ALS chain. */
  permissionModeOverride?: AgentDefinitionPermissionMode
  /**
   * Hard-restrict mutating tools (Write / Edit / NotebookEdit / MCP fs-mutators)
   * to this exact absolute path for the duration of the run. Currently only
   * the `session-memory-internal` scribe uses it; see
   * {@link AgentContext.sessionMemoryWritableTargetPath} for semantics.
   */
  sessionMemoryWritableTargetPath?: string
  /**
   * Worktree isolation: absolute path of a dedicated git worktree this
   * sub-agent should treat as its workspace root. When set (agent definition
   * has `isolation: 'worktree'`), the worker-path init payload uses this
   * instead of the global workspace path so the child's file tools actually
   * land inside the worktree. See `subAgentWorkerDispatch.maybeRunInWorker`.
   */
  workspaceOverride?: string
}): Promise<SubAgentResult> {
  const {
    config,
    model,
    agentDef: agentDefParam,
    prompt,
    description,
    name,
    teamName,
    agentIdOverride,
    parentMessages,
    appendParentPrompt = true,
    parentSystemPrompt,
    signal,
    onEvent,
    stayRunningForSendMessage = false,
    permissionModeOverride: permissionModeOverrideParam,
    sessionMemoryWritableTargetPath,
    workspaceOverride,
  } = params

  const parentContext = getAgentContext()

  // Hard cap on nested agent depth. Without this, a misbehaving agent
  // (or adversarial prompt) could cause unbounded spawn chains. We count
  // depth on the same `replDepth` field that the child context increments
  // so the ceiling is consistent across REPL and Agent tools.
  const currentDepth = parentContext?.replDepth ?? 0
  if (currentDepth + 1 > MAX_AGENT_DEPTH) {
    const rejectMessage = buildAgentDepthRejectionMessage(MAX_AGENT_DEPTH, currentDepth)
    return {
      success: false,
      agentId: agentIdOverride ? asAgentId(agentIdOverride) : generateAgentId(),
      agentType: agentDefParam.agentType,
      output: rejectMessage,
      totalTokens: 0,
      totalDurationMs: 0,
      totalToolUses: 0,
    }
  }

  const effectivePermissionModeOverride =
    permissionModeOverrideParam ??
    resolveSubAgentPermissionOverride({
      agentDef: agentDefParam,
      runInBackground: stayRunningForSendMessage,
      parentEffectiveMode: getPermissionMode(),
    })
  const inheritedTimeout = resolveInheritedTaskBudgetMs(parentContext)
  const agentDef: AgentDefinitionUnion = mergeEnvTaskBudgetIntoAgentDef(
    agentDefParam.timeout !== undefined
      ? agentDefParam
      : inheritedTimeout !== undefined
        ? { ...agentDefParam, timeout: inheritedTimeout }
        : agentDefParam,
  )
  const effectiveThinkingBudgetTokens =
    agentDefParam.thinkingBudgetTokens !== undefined
      ? agentDefParam.thinkingBudgetTokens
      : parentContext?.thinkingBudgetTokens

  const isForkRun =
    appendParentPrompt === false &&
    Array.isArray(parentMessages) &&
    parentMessages.length > 0
  // Fork runs default to FORK_SUBAGENT_MAX_ITERATIONS (200) because they pick up
  // work the parent would have done themselves. But an agent definition with an
  // explicit, deliberately-low `maxTurns` (e.g. session-memory-internal at 30)
  // must still be honoured — otherwise a 15→200 silent expansion sneaks in via
  // the fork branch and amplifies runaway cost by 13×. Cap fork iterations by
  // the agent's own `maxTurns` whenever it is set; default to 200 when absent.
  const subAgentMaxIterations = isForkRun
    ? (typeof agentDef.maxTurns === 'number'
        ? Math.min(FORK_SUBAGENT_MAX_ITERATIONS, agentDef.maxTurns)
        : FORK_SUBAGENT_MAX_ITERATIONS)
    : agentDef.maxTurns

  const agentId: AgentId = agentIdOverride ? asAgentId(agentIdOverride) : generateAgentId()
  /** MCP servers connected by this run’s ensure step (leased for refcount teardown). */
  let mcpLeaseReleaseNames: string[] = []
  initSubAgentSidechain(agentId)
  appendSubAgentSidechain(agentId, {
    kind: 'start',
    summary: `agentType=${agentDef.agentType} fork=${isForkRun}`,
  })
  const parentToolUseId = getToolUseIdFromStopScope()?.trim()
  if (parentToolUseId) {
    taskRuntimeStore.linkAlias(agentId, parentToolUseId)
  }
  if (teamName?.trim()) {
    await ensureTeamMember(teamName.trim(), agentId)
  }
  const startTime = Date.now()
  // Two parallel input-token accumulators because two consumers disagree
  // on the right semantic — see the audit notes on Finding 1 (E):
  //
  //   - {@link latestInputTokens} = `max(input_per_turn)`. Anthropic
  //     reports per-turn cumulative `input_tokens` (the value already
  //     includes the entire prompt prefix sent that turn). Taking the
  //     max gives the *peak context size* the agent reached, which is
  //     the correct number to compare against a per-agent context-size
  //     budget. Used by the readonly-agent abort gate below and by
  //     {@link recordAgentTokenUsage}.
  //
  //   - {@link inputTokSum} = `sum(input_per_turn)`. This matches what
  //     Anthropic actually bills — every turn is metered separately, so
  //     summing reports the realised cost. Used as the user-visible
  //     `SubAgentResult.totalTokens` so the in-process and worker-process
  //     sub-agent paths report comparable numbers (the worker path also
  //     reports sum-based totals at subAgentWorkerClient.ts).
  //
  // Output is per-turn delta in both API and billing terms, so a single
  // sum suffices.
  // Shared mutable run-state (token/tool metrics, abort reason, in-process
  // loop state, termination ref, and the bounded process digest). Threaded by
  // reference so the stream-callback / loop / result-assembly code can live in
  // separate modules. See `subAgentRunContext.ts`.
  //
  // Sub-agent process digest (`ctx.toolUseCounts` / `ctx.toolFailures`) is
  // surfaced to the parent so it can reason about retries / partial failures /
  // wasted work without parsing event streams; bounded to keep it under a few KB.
  const ctx = createSubAgentRunState()
  const MAX_RECORDED_FAILURES = 8

  registerAsyncAgent(agentId, agentDef.agentType)
  logAsyncAgentPhase(
    agentId,
    'permission_resolved',
    effectivePermissionModeOverride === undefined
      ? 'inherit-chat'
      : String(effectivePermissionModeOverride),
  )

  try {
    mcpLeaseReleaseNames = await ensureMcpServersConnected(
      normalizeMcpServerNameList(agentDef.mcpServers),
      getWorkspacePath(),
    )
    acquireSubAgentMcpLease(mcpLeaseReleaseNames)
  } catch (e) {
    console.warn('[SubAgent] MCP ensure failed:', e)
  }
  logAsyncAgentPhase(agentId, 'mcp_initialized')

  const runtimeHooks = agentDef.agentHooks && agentDef.agentHooks.length > 0 ? agentDef.agentHooks : undefined
  logAsyncAgentPhase(agentId, 'hooks_registered', runtimeHooks ? `${runtimeHooks.length} hook(s)` : 'none')

  // 1. Resolve tools for this agent
  const agentTools = resolveAgentTools(agentDef)
  logAsyncAgentPhase(agentId, 'tools_resolved', `${agentTools.length} tools`)
  const toolDefinitions = toolsToApiDefinitions(agentTools)

  // 2. Build system prompt + message list (extracted to subAgentPromptAssembly).
  //    Fork inherits parent text as core; non-fork uses agent body. criticalReminder only on non-fork.
  const { systemPrompt, stableSystemContext, volatileUserContext, messages } = await assembleSubAgentPrompt({
    agentDef,
    model,
    agentTools,
    toolDefinitions,
    parentSystemPrompt,
    parentContext,
    prompt,
    parentMessages,
    appendParentPrompt,
    agentId,
  })

  // 4. Notify start
  onEvent({
    type: 'subagent_start',
    agentId,
    agentType: agentDef.agentType,
    description: (description || prompt || '').slice(0, 100),
    ...(name !== undefined ? { name } : {}),
    runInBackground: stayRunningForSendMessage,
  })

  const ctxMessages: Array<Record<string, unknown>> = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))

  const teamId = teamName || parentContext?.teamId
  const teamIdTrim = teamId?.trim()
  const teammateRuntime =
    teamIdTrim !== undefined && teamIdTrim.length > 0
      ? buildTeammateRuntimeContext({
          agentId,
          name,
          teamName: teamIdTrim,
          parentSessionId:
            parentContext?.streamConversationId &&
            String(parentContext.streamConversationId).trim()
              ? String(parentContext.streamConversationId).trim()
              : undefined,
        })
      : undefined

  const streamConversationId =
    parentContext?.streamConversationId &&
    String(parentContext.streamConversationId).trim()
      ? String(parentContext.streamConversationId).trim()
      : parentContext?.streamConversationId

  const policyTier = agentDef.parentPolicy ?? 'inherit'

  const toolRev = toolRegistry.getToolsetRevision()
  const queryContextCacheKey = isForkRun
    ? (parentContext?.queryContextCacheKey ??
      buildQueryContextCacheKey({
        model,
        sharedSystemPrefix: parentSystemPrompt ?? '',
        toolsetRevision: toolRev,
      }))
    : buildQueryContextCacheKey({
        model,
        sharedSystemPrefix: systemPrompt,
        toolsetRevision: toolRev,
      })

  const wasPreRegistered = Boolean(agentIdOverride && getActiveAgent(agentId))
  const shouldRegisterForPending = !wasPreRegistered
  // P0-2: always create the budget controller so token / tool-count limits and
  // wall-clock timeouts can actually abort the loop, even when this run was
  // already registered upstream (`agentIdOverride` path, e.g. background agents
  // and SendMessage continuations). Registration with `activeAgentRegistry`
  // remains conditional below.
  const bridgeAc = new AbortController()
  const markAbortReason = (reason: string): void => {
    if (!ctx.abortReason && reason.trim()) ctx.abortReason = reason.trim()
  }
  if (signal.aborted) {
    markAbortReason('Parent or user cancellation fired before the sub-agent started')
    bridgeAc.abort()
  } else {
    signal.addEventListener(
      'abort',
      () => {
        markAbortReason('Parent or user cancellation')
        bridgeAc.abort()
      },
      { once: true },
    )
  }

  /** Wall-clock / token budget aborts {@link bridgeAc}; parent stream uses {@link signal}. Both must stop the loop. */
  const effectiveLoopSignal =
    typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, bridgeAc.signal])
      : signal

  const parentContextDiffPermission = parentContext?.diffPermissionMode
  /**
   * Audit v3 Bug 2/3 — path-sandboxed sub-agents must not inherit or project
   * `bypassPermissions` onto the diff pipeline. Even though they run with
   * `permissionMode: 'bypassPermissions'` to suppress prompts for legitimate
   * in-sandbox writes, the early gate in {@link runAgenticToolUse} is the only
   * authority that decides whether a path is allowed; `diffPermissionMode` is
   * therefore clamped to `'default'` so the system never auto-applies a diff
   * for any path that ever reached the approval layer.
   */
  const isPathSandboxedAgent = agentDefParam.agentType === 'session-memory-internal'
  const effectiveDiffPermissionMode = isPathSandboxedAgent
    ? 'default'
    : parentContextDiffPermission !== undefined
      ? parentContextDiffPermission
      : effectivePermissionModeOverride === 'bypassPermissions' ||
          effectivePermissionModeOverride === 'acceptEdits'
        ? 'bypassPermissions'
        : 'default'

  const childContextBase = {
    config,
    model,
    systemPrompt,
    // Proper stable/volatile split so block-mode system prompts and
    // `countTokens` prefetch stay aligned with the main chat layout.
    systemPromptLayers: {
      systemContext: stableSystemContext,
      userContext: volatileUserContext,
      // Sub-agents do not (yet) ship a `<system-reminder>` user-meta msg
      // for project memory / LSP — recall + LSP drain happen inline in
      // `volatileUserContext`. See `streamHandler.ts` for the main-chat
      // user-message context flow this field enables.
      userMessageContext: '',
    } satisfies SystemPromptLayers,
    messages: ctxMessages,
    signal: effectiveLoopSignal,
    agentId,
    parentAgentId: parentContext?.agentId,
    streamConversationId,
    mcpServers: normalizeMcpServerNameList(agentDef.mcpServers),
    runtimeHooks,
    teamId,
    ...(teammateRuntime ? { teammate: teammateRuntime } : {}),
    replDepth: (parentContext?.replDepth ?? 0) + 1,
    sessionAgentType: agentDef.agentType,
    ...(sessionMemoryWritableTargetPath
      ? { sessionMemoryWritableTargetPath }
      : {}),
    policyTier,
    // 子代理默认禁用 extended thinking——对齐 upstream-main
    // `runAgent.ts:682` 的策略：fork 子代理（与父亲共享 prompt cache 的
    // 并行 worker）继承父亲的 thinking 配置以保持 byte-identical 请求
    // 前缀（一旦不一致缓存就失效），其它"会话型"子代理（包括 default /
    // async_agent / in_process_teammate 三种 profile）一律关——避免上层
    // reasoning 串入子代理上下文造成噪声与幻觉，同时也节省子代理的输出
    // token 预算。Report §3.2 对 `async_agent` 的硬约束（必须关）天然
    // 落在"非 fork"分支里，无需再单独 if。
    alwaysThinking: isForkRun
      ? parentContext?.alwaysThinking === true
      : false,
    queryChainId: generateQueryChainId(),
    querySource: agentQuerySource(agentDef.agentType),
    skipPromptCacheWrite: parentContext?.skipPromptCacheWrite === true,
    queryContextCacheKey,
    permissionModeOverride: effectivePermissionModeOverride,
    diffPermissionMode: effectiveDiffPermissionMode,
    permissionDefaultMode: parentContext?.permissionDefaultMode,
    permissionRules: parentContext?.permissionRules,
    // Runtime second-gate for sub-agent tool surface (audit BUG-R1):
    // mirrors the names the model is told it can call so an out-of-list
    // tool_use is rejected at `runAgenticToolUseBody` before reaching
    // `toolRegistry.execute`. Skipped for main-chat ('main' agentId)
    // since it has no per-agent whitelist.
    allowedToolNamesForRuntime: agentTools.map((t) => t.name),
    // P1-2 — propagate the agent's declared default scheduling priority
    // into ALS. `DefaultToolRuntimePort` reads this (with NORMAL as the
    // fallback) when enqueueing batches into the process-wide
    // `ToolScheduler`. session-memory-internal / dream / future
    // background agents should declare `defaultPriority: BACKGROUND` so
    // they cannot starve foreground main chat or visible sub-agents.
    ...(typeof agentDef.defaultPriority === 'number'
      ? { priority: agentDef.defaultPriority }
      : {}),
    ...(typeof agentDef.timeout === 'number' && agentDef.timeout > 0
      ? { taskBudgetMs: agentDef.timeout }
      : {}),
    ...(effectiveThinkingBudgetTokens !== undefined
      ? { thinkingBudgetTokens: effectiveThinkingBudgetTokens }
      : {}),
  }

  /**
   * SA-3 fix 3 — whether THIS run added the orchestrator lineage edge below
   * (and therefore owns its teardown). Stays false when the caller already
   * registered the edge itself (teamAutoLauncher pre-registers via
   * `trackAgentInOrchestrator` before calling `runSubAgent`).
   */
  let registeredOrchestratorEdgeForPending = false
  if (shouldRegisterForPending) {
    const ephemeral: ActiveAgent = {
      agentId,
      agentType: agentDef.agentType,
      agentDef,
      description: (description || prompt || '').slice(0, 200),
      name,
      teamName,
      parentAgentId: parentContext?.agentId,
      streamConversationId,
      messages: [],
      pendingMessages: [],
      abortController: bridgeAc,
      startTime: Date.now(),
      status: 'running',
      resolve: () => {},
    }
    const reg = registerActiveAgent(ephemeral)
    if (!reg.ok) {
      onEvent({ type: 'subagent_error', agentId, error: reg.error })
      await finalizeSubAgentLifecycle(agentId, {
        streamConversationId,
        mcpLeaseReleaseNames,
      })
      return {
        success: false,
        agentId,
        agentType: agentDef.agentType,
        output: reg.error,
        totalTokens: 0,
        totalDurationMs: Date.now() - startTime,
        totalToolUses: 0,
      }
    }
    // SA-3 fix 3 — fork / skill / REPL / disk-recovery spawns reach this
    // ephemeral branch with NO MultiAgentOrchestrator edge, so
    // `interruptTree(parent)` could not cascade an abort into them.
    // Register the parent→child edge here (the shim wraps `bridgeAc`, so a
    // tree interrupt aborts the loop via `effectiveLoopSignal`). Skipped
    // when an edge already exists (teamAutoLauncher owns its own edge and
    // teardown — re-registering would clobber its meta/createdAt).
    //
    // Known trade-off: `orchestrator.register` is also what
    // `enforceConcurrencyLimit` counts, so these children now occupy a
    // concurrency slot under their parent for the duration of the run.
    // There is no edge-only API on MultiAgentOrchestrator and adding one
    // (electron/orchestration) is out of scope for this batch; counting a
    // real running child is also arguably the more correct accounting
    // (cf. the teamAutoLauncher under-count bug this facade fixed).
    // The edge is only added when a parent context exists — root spawns
    // have nothing to cascade from.
    if (
      parentContext?.agentId &&
      !getMultiAgentOrchestrator().get(String(agentId))
    ) {
      const edge = trackAgentInOrchestrator({
        agentId,
        agentType: agentDef.agentType,
        abortController: bridgeAc,
        parentAgentId: parentContext.agentId,
        ...(typeof streamConversationId === 'string' && streamConversationId
          ? { conversationId: streamConversationId }
          : {}),
      })
      if (edge.ok) {
        registeredOrchestratorEdgeForPending = true
      } else {
        // Bookkeeping must never sink the spawn — log and continue
        // (same policy as teamAutoLauncher).
        console.warn(
          '[subAgentRunner] orchestrator lineage edge registration failed:',
          edge.error,
        )
      }
    }
  }

  const workerOutcome = await maybeRunInWorker({
    config, model, agentDef, prompt, systemPrompt, parentMessages,
    effectiveLoopSignal, onEvent, subAgentMaxIterations, effectiveDiffPermissionMode,
    parentContext, sessionMemoryWritableTargetPath, isForkRun, agentId, startTime,
    streamConversationId, mcpLeaseReleaseNames, shouldRegisterForPending,
    registeredOrchestratorEdgeForPending, stayRunningForSendMessage,
    workspaceOverride,
  })
  if (workerOutcome.handled) return workerOutcome.result

  // Worktree isolation can only be honoured on the (per-thread, own
  // workspacePath) worker path. The in-process path resolves file tools
  // against the single PROCESS-GLOBAL workspace path, so redirecting it here
  // would corrupt the parent and sibling agents. If we reach the in-process
  // fallback with a worktree override, the isolation is NOT applied — surface
  // it loudly rather than silently writing into the shared workspace.
  if (workspaceOverride) {
    console.warn(
      `[subAgentRunner] worktree isolation requested (worktree=${workspaceOverride}) but the agent ran in-process; ` +
        `file edits will land in the shared workspace, not the worktree. ` +
        `Enable the worker path (POLE_AGENT_WORKER=1 / readonly agent) for real isolation.`,
    )
  }

  try {
    return await runWithAgentContextAsync(childContextBase, async () => {
    logAsyncAgentPhase(agentId, 'running')
    fireSubagentStartHooks({
      agent_id: agentId,
      agent_type: agentDef.agentType,
      workspace_path: getWorkspacePath()?.trim() || '',
      stream_conversation_id: streamConversationId ?? '',
      stay_running_for_send_message: stayRunningForSendMessage,
    })
    // Audit fix (S2.1): capture the typed `terminationResult` via `onTerminate`
    // hook on every `runAgenticLoop` invocation. Previously the in-process
    // sub-agent runner only knew about termination via the legacy callbacks
    // (`onError(string)`, `onMaxIterationsReached(n)`) and could not
    // distinguish 9 of the 12 `TerminationReason` values (blocking_limit,
    // prompt_too_long, image_error, model_error, stop_hook_prevented,
    // hook_stopped, iteration_boundary_stopped, output_budget_exhausted, …).
    // upstream parity: their `runAgent` doesn't consume `Terminal.reason`
    // either, but the **worker-based** path in our own `subAgentWorker.ts`
    // already does — the in-process runner was inconsistent with itself.
    //
    // We don't use `terminationResult.reason` to drive control flow today;
    // `reachedMaxIterations` (above) and `effectiveLoopSignal.aborted` cover
    // the structural cases. The capture is for richer event metadata and
    // future use (UI badges per TerminationReason, hook receivers, etc.).
    //
    // Ref-container shape (rather than `let x: T | null = null`) because
    // TypeScript's flow analysis doesn't see assignments that happen
    // inside the onTerminate closure — without the ref, narrowing
    // collapses `x` back to `null` at every use site outside the closure.
    // Same pattern as `contextLengthExceededRef` etc.
    // Termination ref + in-process loop state live on `ctx` (see
    // subAgentRunContext.ts): ctx.terminationResultRef, ctx.lastFinalText,
    // ctx.iterationToolCount, ctx.budgetDirectiveInjected,
    // ctx.outputLenBeforeThisStream, ctx.taskCursorBeforeThisStream,
    // ctx.iterationStartOutputLen, ctx.sawPerStreamUsage, ctx.firstModelByteLogged,
    // ctx.reachedMaxIterations.
    const { loopCallbacks, recordUsageForBudgets } = createSubAgentLoopCallbacks({
      ctx,
      onEvent,
      agentId,
      agentDef,
      markAbortReason,
      bridgeAc,
      maxRecordedFailures: MAX_RECORDED_FAILURES,
      // Effective iteration cap: agent `maxTurns` / fork cap, or the loop
      // default when unset — drives the iteration-limit graceful wind-down.
      maxIterations: subAgentMaxIterations ?? MAX_ITERATIONS,
    })

    try {
      let continuationApi: Array<Record<string, unknown>> | undefined

      for (;;) {
        if (continuationApi) {
          onEvent({ type: 'subagent_text', agentId, text: '\n\n' })
        }
        // Audit Bug O3 — FIXED: sub-agents now inherit the parent's
        // orchestration `ToolRuntimePort` when it is present in ALS.
        // This keeps snapshot/rewind consistency and permission pre-flight
        // behavior aligned between parent and child. Falls back to the
        // legacy non-orchestrated path when no port is available.
        //
        // Stage 1.4 + Bug E fix — the original `parentCtxForTools = getAgentContext()`
        // here is misleading: this code runs INSIDE the `runWithAgentContextAsync(
        // childContextBase, ...)` scope set up at line ~1015, so
        // `getAgentContext()` returns the CHILD's context (`childContextBase`),
        // not the parent's. `childContextBase` (built at line ~836) does NOT
        // copy `toolRuntimePort` / `parentKernelGetState` / `parentNoteToolInvocation`
        // from parent — so reading them off the child always returns `undefined`
        // and the sub-agent silently falls back to the legacy path.
        //
        // We read the OUTER-scope `parentContext` (captured at line 246 BEFORE
        // we enter the child ALS scope) — that's the actual parent context that
        // the kernel mutated in `kernel.ts:464-475`.
        const inheritedToolRuntimePort = parentContext?.toolRuntimePort
        const parentKernelGetState = parentContext?.parentKernelGetState
        const parentNoteToolInvocation = parentContext?.parentNoteToolInvocation
        const orchestratedToolExecution = inheritedToolRuntimePort
          ? {
              port: inheritedToolRuntimePort,
              getKernelState: parentKernelGetState
                ? parentKernelGetState
                : () => ({
                    ...createInitialKernelLoopState([]),
                    phase: 'CallModel' as const,
                  }),
              noteToolInvocation: parentNoteToolInvocation ?? (() => {}),
            }
          : undefined
        const bundle = getActiveBundle()
        const effectiveTemperature = agentDef.temperature ?? bundle?.capabilities?.temperature
        const effectiveTopP = agentDef.topP ?? bundle?.capabilities?.topP
        // upstream parity: retry transient `model_error` terminations
        // before giving up. `decideSubagentRetry` is the policy table
        // (electron/agents/subAgentRetryPolicy.ts) — it caps at
        // `DEFAULT_MAX_ATTEMPTS = 2`, so we attempt at most one retry.
        //
        // Scope: only `model_error` is wired here. `prompt_too_long`
        // remains `no_retry` because the inner reactive-compact
        // recovery (electron/ai/agenticLoop/stream/reactiveCompactRecovery.ts)
        // has already run one compact pass before that termination
        // surfaces — a runner-level retry without a further forced
        // compact would just hit the same wall.
        //
        // State across attempts:
        //   - `messages` / `continuationApi`: not reset — the failed
        //     attempt may have appended user/assistant messages that
        //     give the retry context.
        //   - `outputText` / `lastFinalText` / token accumulators: not
        //     reset; counted as one task continuation, same as
        //     upstream's behavior (parent's apiMessages keep the
        //     pre-error trail).
        //   - `reachedMaxIterations`: reset so the success calc below
        //     reflects only the final attempt's outcome.
        //   - `terminationResultRef.value`: reset before each attempt
        //     so the post-loop branches see the latest reason only.
        //
        // Function-call resets (`clearTerminationRef`) instead of
        // direct `ref.value = null` — TypeScript flow analysis would
        // otherwise narrow the property type to literal `null` for
        // the rest of the for-loop body, breaking the post-await
        // `.reason` read. Side effects across function call boundaries
        // are opaque to narrowing, which is exactly what we want.
        const clearTerminationRef = (): void => {
          ctx.terminationResultRef.value = null
        }
        for (let attemptsSoFar = 0; ; attemptsSoFar++) {
          clearTerminationRef()

          const subAgentLoopParams = {
            config,
            model,
            messages: continuationApi ? [] : messages,
            systemPrompt,
            maxTokens: 8192,
            enableTools: toolDefinitions.length > 0,
            toolDefinitionsOverride: toolDefinitions,
            maxIterationsOverride: subAgentMaxIterations,
            initialApiMessages: continuationApi,
            signal: effectiveLoopSignal,
            alwaysThinking: getAgentContext()?.alwaysThinking === true,
            effort: agentDef.effort,
            diffPermissionMode: getAgentContext()?.diffPermissionMode ?? 'default',
            permissionDefaultMode: getAgentContext()?.permissionDefaultMode ?? 'ask',
            permissionRules: getAgentContext()?.permissionRules,
            ...(orchestratedToolExecution ? { orchestratedToolExecution } : {}),
            ...(effectiveTemperature !== undefined ? { temperature: effectiveTemperature } : {}),
            ...(effectiveTopP !== undefined ? { topP: effectiveTopP } : {}),
            // Audit §3.2 wire-up — pre-iteration boundary check for
            // sub-agents. On the legacy `runAgenticLoop` path this is the
            // ONLY between-iteration control point (no kernel). On the
            // 阶段 2 kernel path (`runOrchestratedSubAgent`) it coexists with
            // the kernel's own pause/abort/snapshot boundary. Fires BEFORE the
            // inner `iteration.ts:state.signal.aborted` gate so a sub-agent
            // that's already over-budget OR whose parent signal just fired
            // exits with the typed `iteration_boundary_stopped` reason instead
            // of the less informative `aborted_streaming`.
            iterationBoundaryHook: async () => {
              if (effectiveLoopSignal.aborted) return { stop: true }
              const active = getActiveAgent(agentId)
              if (active?.tokenBudgetExceeded === true) return { stop: true }
              return undefined
            },
          }
          // Audit fix (S2.1): capture the typed terminationResult so we can
          // enrich SubAgentResult / events with the reason class, AND so the
          // model_error retry policy below sees the latest run's reason. Last
          // write wins across retry attempts / stayRunningForSendMessage cycles.
          const captureTermination = (r: AgenticLoopResult): void => {
            ctx.terminationResultRef.value = r.terminationResult
          }

          // Main-process sub-agents always route through a real orchestration kernel
          // so the MultiAgentOrchestrator's pause/resume cascade reaches it
          // and it gets checkpoint/persist + PolicyEngine-backed tool runtime. The
          // worker path is excluded (it returned early above) because a
          // worker_threads child can't hold a main-process kernel object.
          await runOrchestratedSubAgent(subAgentLoopParams, loopCallbacks, {
            agentId: String(agentId),
            agentType: agentDef.agentType,
            ...(parentContext?.agentId
              ? { parentAgentId: String(parentContext.agentId) }
              : {}),
            ...(typeof streamConversationId === 'string' && streamConversationId
              ? { conversationId: streamConversationId }
              : {}),
            onTerminate: captureTermination,
            onKernelInterrupt: (reason) => {
              markAbortReason(`Kernel interrupt (${reason ?? 'user'})`)
              bridgeAc.abort()
            },
          })

          const lastReason = ctx.terminationResultRef.value?.reason
          if (lastReason !== 'model_error') break
          if (effectiveLoopSignal.aborted || signal.aborted) break

          const decision = decideSubagentRetry(lastReason, attemptsSoFar)
          if (decision.kind !== 'retry') break

          const backoffMs = decision.backoffMs ?? 1000
          const nextAttempt = attemptsSoFar + 2 // 1-indexed, "about to start"
          onEvent({
            type: 'subagent_retry',
            agentId,
            attemptsSoFar: nextAttempt,
            terminationReason: lastReason,
            reason: decision.reason,
            backoffMs,
          })
          appendSubAgentSidechain(agentId, {
            kind: 'limit',
            summary: `model_error retry attempt=${nextAttempt} backoffMs=${backoffMs}`,
          })

          // Reset per-attempt outcome flags so the post-loop success
          // calc reflects the FINAL attempt only.
          ctx.reachedMaxIterations = false

          if (backoffMs > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, backoffMs))
          }
          if (effectiveLoopSignal.aborted || signal.aborted) break
        }

        // Audit fix (S0.1): the old condition `!outputText.includes(
        // 'Agentic loop reached maximum')` checked a string that is NEVER
        // emitted into outputText anywhere in the codebase — the only
        // max-iterations text goes to the `subagent_error` event channel
        // (line 1327: 'Reached maximum iterations (N)'), not the text
        // delta stream. The dead substring check meant a sub-agent that
        // exited via max-iterations still entered the idle-mailbox wait
        // loop. Read the structural flag set by `onMaxIterationsReached`
        // (line 1326) — typed-signal-driven, no regex-on-output guard.
        const idleMailbox =
          stayRunningForSendMessage &&
          !effectiveLoopSignal.aborted &&
          !getActiveAgent(agentId)?.tokenBudgetExceeded &&
          !ctx.reachedMaxIterations

        if (!idleMailbox) break

        const agentCtx = getAgentContext()
        if (!agentCtx?.messages?.length) break

        continuationApi = cloneApiMessagesDeep(agentCtx.messages as Array<Record<string, unknown>>)

        fireTeammateIdleHooks({
          agent_id: agentId,
          agent_type: agentDef.agentType,
          workspace_path: getWorkspacePath()?.trim() || '',
        })

        // Audit 2026-06 — "team hangs idle, lead never learns" gap. This
        // is the exact moment the member's current work is DONE and it
        // transitions to waiting for new mail. Two signals, both
        // best-effort:
        //   1. `idle_notification` into the lead's durable mailbox so the
        //      lead's next turn renders it in the `<team-inbox>` digest
        //      (previously only the `teammateRunner` path wrote this; the
        //      Agent-tool spawn path fired hooks only — the lead had no
        //      protocol-visible signal that a member went idle).
        //   2. Renderer wake event so an IDLE main conversation actually
        //      starts that next turn instead of waiting for the user
        //      (guards live in `autoResumeBackgroundTasks`).
        const idleTeam = (teamName ?? '').trim()
        if (idleTeam) {
          try {
            const wsForIdle = getWorkspacePath()
            const team = wsForIdle ? loadTeamFile(wsForIdle, idleTeam) : null
            const leadId = team?.leadAgentId?.trim()
            if (leadId && leadId !== String(agentId)) {
              await sendTeammateIdleNotification({
                teammateAgentId: String(agentId),
                ...(name ? { teammateName: name } : {}),
                teammateAgentType: agentDef.agentType,
                leadAgentId: leadId,
                teamName: idleTeam,
                reason: 'turn_complete',
              })
            }
          } catch (err) {
            console.warn(
              '[subAgentRunner] idle notification to lead failed:',
              err instanceof Error ? err.message : String(err),
            )
          }
          requestTeamMemberIdleWake({
            agentId: String(agentId),
            teamName: idleTeam,
          })
        }

        try {
          await waitForAgentMailboxOrAbort(agentId, effectiveLoopSignal)
        } catch {
          break
        }
        if (effectiveLoopSignal.aborted) break
      }

      // A "clean" run neither hit an internal budget / wall-clock abort nor
      // ran out of iterations. This is the pre-existing success rule; it is
      // still SUFFICIENT for success but no longer NECESSARY — see the
      // output-aware `success` recomputed after the rescue below.
      const cleanCompletion = !effectiveLoopSignal.aborted && !ctx.reachedMaxIterations
      const active = getActiveAgent(agentId)
      const truncated = active?.tokenBudgetExceeded === true
      const terminalAbortReason = ctx.abortReason ?? active?.terminalError

      // ── Final-summary rescue ──────────────────────────────────────────
      // If the loop terminated abnormally without ever producing a
      // tool-free final turn, give the model exactly ONE more non-tool
      // turn to write its report based on what it has gathered so far.
      // This is what prevents the parent from receiving a single
      // "Now let me read…" sentence after a sub-agent burns 120 tool
      // calls. See {@link runSubAgentFinalSummaryRescue} for the full
      // rationale and budget controls.
      const rescueBudgetMs = resolveFinalSummaryRescueBudgetMs()
      const rescueCtx = getAgentContext()
      const rescueApiMessages =
        (rescueCtx?.messages as Array<Record<string, unknown>> | undefined) ?? []
      // upstream parity: pull the most recent assistant text block from
      // the transcript. Used as a second-priority resolver fallback
      // and to short-circuit the rescue turn when the transcript
      // already carries usable text.
      const transcriptLastAssistantText = extractLastAssistantText(rescueApiMessages)
      let rescueRan = false
      let rescueProducedChars = 0
      let rescueDurationMs = 0
      let rescueOutcome: 'completed' | 'timeout' | 'error' | 'skipped' = 'skipped'
      if (
        shouldRunFinalSummaryRescue({
          reachedMaxIterations: ctx.reachedMaxIterations,
          aborted: effectiveLoopSignal.aborted,
          lastFinalText: ctx.lastFinalText,
          transcriptLastAssistantText,
          apiMessageCount: rescueApiMessages.length,
          parentSignalAborted: signal.aborted,
          budgetMs: rescueBudgetMs,
        })
      ) {
        rescueRan = true
        const rescueReason: 'max_iterations' | 'aborted' = ctx.reachedMaxIterations
          ? 'max_iterations'
          : 'aborted'
        appendSubAgentSidechain(agentId, {
          kind: 'limit',
          summary: `final_summary_rescue start reason=${rescueReason} budgetMs=${rescueBudgetMs}`,
        })
        const rescueResult = await runSubAgentFinalSummaryRescue({
          config,
          model,
          systemPrompt,
          apiMessages: cloneApiMessagesDeep(rescueApiMessages),
          reason: rescueReason,
          ...(terminalAbortReason ? { abortReason: terminalAbortReason } : {}),
          toolCallsMade: ctx.totalToolUses,
          parentSignal: signal,
          budgetMs: rescueBudgetMs,
          onTextDelta: (text) => {
            ctx.outputText += text
            onEvent({ type: 'subagent_text', agentId, text })
          },
          onStreamUsage: (usage) => recordUsageForBudgets(usage),
        })
        rescueProducedChars = rescueResult.text.length
        rescueDurationMs = rescueResult.durationMs
        rescueOutcome = rescueResult.timedOut
          ? 'timeout'
          : rescueResult.errored
            ? 'error'
            : 'completed'
        if (rescueResult.text) {
          // Promote rescue text to `lastFinalText` so the resolver's
          // top-priority tier (the tool-free final turn) picks it up,
          // identical to the path a well-behaved sub-agent takes.
          ctx.lastFinalText = rescueResult.text
        }
        appendSubAgentSidechain(agentId, {
          kind: 'limit',
          summary:
            `final_summary_rescue ${rescueOutcome} ` +
            `chars=${rescueProducedChars} durationMs=${rescueDurationMs}`,
        })
      }

      // Output-aware success (computed AFTER the rescue so a rescue-produced
      // report counts). A run succeeds when the user did NOT cancel it AND
      // either it completed cleanly OR it still delivered a usable final
      // report despite hitting an iteration / token budget. This is the
      // change that stops "hit the limit but produced a complete report"
      // runs from being reported as failures. `signal` is the parent/user
      // signal — a true user-cancel is always a failure regardless of output.
      const producedReport = subAgentProducedUsableReport({
        lastFinalText: ctx.lastFinalText,
        transcriptLastAssistantText,
      })
      const success = !signal.aborted && (cleanCompletion || producedReport)

      recordSubAgentOrchestrationOutcome({
        conversationId:
          typeof streamConversationId === 'string' && streamConversationId.trim()
            ? streamConversationId.trim()
            : streamConversationId,
        success,
        coordinatorPhase: agentDef.coordinatorPhase,
      })

      const reportedOutput = resolveSubAgentReportedOutputDetail({
        lastFinalText: ctx.lastFinalText,
        transcriptLastAssistantText,
        outputText: ctx.outputText,
        latestTextOutput: active?.latestTextOutput,
        reachedMaxIterations: ctx.reachedMaxIterations,
        aborted: effectiveLoopSignal.aborted,
        abortReason: terminalAbortReason,
      })
      const result: SubAgentResult = {
        success,
        agentId,
        agentType: agentDef.agentType,
        output: reportedOutput.body,
        // Sum semantics — matches what subAgentWorkerClient.ts reports
        // (worker path uses `state.totalUsage.inputTokens + outputTokens`,
        // both sum-based) so parent agents see comparable numbers
        // regardless of which spawn path was taken. The audit's Finding 1
        // (E) called out this inconsistency when we had `max+sum` here.
        totalTokens: ctx.inputTokSum + ctx.outputTokTotal,
        totalDurationMs: Date.now() - startTime,
        totalToolUses: ctx.totalToolUses,
        tokenUsage: { input: ctx.inputTokSum, output: ctx.outputTokTotal },
        truncated,
        reachedMaxIterations: ctx.reachedMaxIterations,
        aborted: effectiveLoopSignal.aborted,
        ...(terminalAbortReason ? { abortReason: terminalAbortReason } : {}),
        ...(success ? {} : { error: terminalAbortReason ?? 'Sub-agent did not complete cleanly' }),
        // Audit fix (S2.1): forward the typed loop termination reason
        // (when captured) so parent / UI / telemetry can branch on
        // the 12-way discriminator instead of parsing error strings.
        ...(ctx.terminationResultRef.value
          ? { terminationReason: ctx.terminationResultRef.value.reason }
          : {}),
        toolUseCounts: Object.fromEntries(ctx.toolUseCounts),
        toolFailures: ctx.toolFailures.slice(),
        ...(reportedOutput.charTruncated
          ? {
              outputCharTruncated: true,
              outputOriginalCharCount: reportedOutput.originalCharCount,
            }
          : {}),
        ...(rescueRan && rescueOutcome !== 'skipped'
          ? {
              finalSummaryRescue: {
                outcome: rescueOutcome,
                chars: rescueProducedChars,
                durationMs: rescueDurationMs,
              },
            }
          : {}),
        ...(ctx.windDown ? { windDown: ctx.windDown } : {}),
      }

      appendSubAgentSidechain(agentId, {
        kind: 'complete',
        summary: `success=${success} tools=${ctx.totalToolUses} reason=${ctx.terminationResultRef.value?.reason ?? 'n/a'}`,
      })
      logAsyncAgentPhase(agentId, 'completing')
      onEvent({ type: 'subagent_complete', agentId, result })
      fireSubagentHooks({
        agent_id: agentId,
        agent_type: agentDef.agentType,
        success: result.success,
        total_tool_uses: result.totalToolUses,
        truncated: result.truncated,
        reached_max_iterations: result.reachedMaxIterations,
      })
      logAsyncAgentPhase(agentId, 'completed')
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appendSubAgentSidechain(agentId, { kind: 'error', summary: message.slice(0, 300) })
      onEvent({ type: 'subagent_error', agentId, error: message })

      recordSubAgentOrchestrationOutcome({
        conversationId:
          typeof streamConversationId === 'string' && streamConversationId.trim()
            ? streamConversationId.trim()
            : streamConversationId,
        success: false,
        coordinatorPhase: agentDef.coordinatorPhase,
      })

      const activeFail = getActiveAgent(agentId)
      const truncatedFail = activeFail?.tokenBudgetExceeded === true
      const terminalAbortReason = ctx.abortReason ?? activeFail?.terminalError
      // upstream parity: even on the thrown-error path the transcript
      // built up by the failed loop may carry usable assistant text
      // (e.g. agent narrated work, then a tool exception killed the
      // run). Pull it before falling back to the streaming buffer.
      const transcriptLastAssistantTextFail = extractLastAssistantText(
        (getAgentContext()?.messages as Array<Record<string, unknown>> | undefined) ?? [],
      )
      const fallbackOutDetail = resolveSubAgentReportedOutputDetail({
        lastFinalText: ctx.lastFinalText,
        transcriptLastAssistantText: transcriptLastAssistantTextFail,
        outputText: ctx.outputText,
        latestTextOutput: activeFail?.latestTextOutput,
        reachedMaxIterations: ctx.reachedMaxIterations,
        aborted: effectiveLoopSignal.aborted,
        abortReason: terminalAbortReason,
      })
      const errParts = [message.trim(), fallbackOutDetail.body.trim()].filter(Boolean)
      const result: SubAgentResult = {
        success: false,
        agentId,
        agentType: agentDef.agentType,
        output: errParts.join('\n\n') || message,
        // See sibling success branch — sum-based reporting to align with
        // the worker-process path's `SubAgentResult.totalTokens`.
        totalTokens: ctx.inputTokSum + ctx.outputTokTotal,
        totalDurationMs: Date.now() - startTime,
        totalToolUses: ctx.totalToolUses,
        tokenUsage: { input: ctx.inputTokSum, output: ctx.outputTokTotal },
        truncated: truncatedFail,
        reachedMaxIterations: ctx.reachedMaxIterations,
        aborted: effectiveLoopSignal.aborted,
        ...(terminalAbortReason ? { abortReason: terminalAbortReason } : {}),
        error: message,
        // Audit fix (S2.1): forward typed termination reason on the
        // catch path too. Useful when an error like `prompt_too_long`
        // surfaced before the runner could synthesise a success result.
        ...(ctx.terminationResultRef.value
          ? { terminationReason: ctx.terminationResultRef.value.reason }
          : {}),
        toolUseCounts: Object.fromEntries(ctx.toolUseCounts),
        toolFailures: ctx.toolFailures.slice(),
        ...(fallbackOutDetail.charTruncated
          ? {
              outputCharTruncated: true,
              outputOriginalCharCount: fallbackOutDetail.originalCharCount,
            }
          : {}),
        ...(ctx.windDown ? { windDown: ctx.windDown } : {}),
      }

      logAsyncAgentPhase(agentId, 'completing')
      onEvent({ type: 'subagent_complete', agentId, result })
      fireSubagentHooks({
        agent_id: agentId,
        agent_type: agentDef.agentType,
        success: false,
        total_tool_uses: result.totalToolUses,
        truncated: result.truncated,
        reached_max_iterations: result.reachedMaxIterations,
        error: message,
      })
      logAsyncAgentPhase(agentId, 'completed')
      return result
    }
    })
  } finally {
    await finalizeSubAgentLifecycle(agentId, {
      streamConversationId,
      mcpLeaseReleaseNames,
    })
    if (shouldRegisterForPending) {
      // SA-3 fix 3 — drop the lineage edge we added (and only ours;
      // caller-owned edges, e.g. teamAutoLauncher's, are torn down by
      // their owners via `unspawnAndUntrackAgent`).
      if (registeredOrchestratorEdgeForPending) {
        try {
          getMultiAgentOrchestrator().unregister(String(agentId))
        } catch {
          /* idempotent best-effort teardown */
        }
      }
      unregisterActiveAgent(agentId)
    }
  }
}

