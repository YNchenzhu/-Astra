/**
 * Agentic loop — setup & state initialisation.
 * Extracted from agenticLoop.ts (§ Initialization, § Phase 0).
 */

import { ContextManager, contextManager as globalContextManager } from '../../context/manager'
import { getToolDefinitions } from '../../tools/schema'
import { toolRegistry } from '../../tools/registry'
import { applyDiffPermissionKillswitch } from '../permissionRuntimeKillswitch'
import { createToolCallHistory } from '../toolCallHistory'
import {
  isTokenBudgetEnabled,
  getTokenBudgetConfigFromEnv,
  createTokenBudgetState,
  type TokenBudgetState,
} from '../../context/tokenBudget'
import { MAX_ITERATIONS } from '../../constants/toolLimits'
import { createQueryProfiler } from '../queryProfiler'
import { getAgentContext } from '../../agents/agentContext'
import { getIterationStallGuard } from '../../orchestration/iterationStallGuard'
import { readForkCacheStrategy } from '../../agents/forkSubagent'
import { streamText } from '../client'
import type { AgenticLoopParams } from '../agenticLoopTypes'
import type { LoopInitResult } from './loopShared'
import { freezeQueryConfig, type QueryConfig } from './queryConfig'
import { defaultQueryDeps, type QueryDeps } from './queryDeps'
import { asAgentId } from '../../tools/ids'

function initialiseTokenBudget(): TokenBudgetState | null {
  if (!isTokenBudgetEnabled()) return null
  const cfg = getTokenBudgetConfigFromEnv()
  return cfg ? createTokenBudgetState(cfg) : null
}

/**
 * Read `POLE_BLOCKING_LIMIT_HARD` once. Production consumer:
 * {@link QueryConfig.blockingLimitHard}, which is consulted by the
 * blocking-limit gate in `electron/orchestration/phases/iteration.ts`.
 * Reading once at state-init time (rather than each iteration) prevents
 * a mid-flight settings flip from changing the termination semantics of
 * the same turn.
 *
 * Truthy values match upstream's truthy envelope (`1` / `true` / `yes`),
 * mirroring the prior inline check verbatim so the migration is a pure
 * mechanical move with no behaviour change.
 */
function readBlockingLimitHardFromEnv(): boolean {
  const raw = process.env.POLE_BLOCKING_LIMIT_HARD?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * Build the {@link QueryConfig} snapshot for the run. Pulls identity
 * fields from the ambient ALS {@link AgentContext} (the loop runs
 * inside a `runWithAgentContext` scope) and freezes feature flags
 * captured from env / params.
 *
 * Returning a `Readonly` view (via `freezeQueryConfig`) is what makes
 * "captured once" enforceable — phase modules that try to mutate the
 * snapshot get a runtime TypeError instead of silently affecting the
 * loop's behaviour.
 */
/**
 * Build the {@link QueryDeps} container for the run.
 *
 * Production wiring:
 *
 *   - `callModel` points at the imported `streamText` reference.
 *     `vi.mock('../client')` swaps the export at import time, so tests
 *     transparently intercept this slot without touching `defaultQueryDeps`.
 *   - `signal` is the outer abort signal carried on the loop's params.
 *   - `now` defaults to `Date.now`. Production call sites that want a
 *     deterministic clock seam read `state.queryDeps.now()` instead of
 *     the bare global.
 *
 * No `microcompact` / `autocompact` slots — see `queryDeps.ts` for the
 * architectural divergence from upstream's `src/query/deps.ts`.
 */
function buildQueryDeps(params: AgenticLoopParams): QueryDeps {
  return defaultQueryDeps({
    callModel: streamText,
    signal: params.signal,
  })
}

function buildQueryConfig(
  params: AgenticLoopParams,
): Readonly<QueryConfig> {
  const ctx = getAgentContext()
  const agentId =
    ctx?.agentId !== undefined ? ctx.agentId : asAgentId('main')
  return freezeQueryConfig({
    agentId,
    model: params.model,
    replDepth: ctx?.replDepth ?? 0,
    parentAgentId: ctx?.parentAgentId,
    streamConversationId: ctx?.streamConversationId,
    providerConfigName: params.config?.name,
    // ── Captured feature flags ──
    // (P3-1: the dead `coordinatorMode` / `skipPromptCacheWrite`
    // placeholders were removed from QueryConfig — see queryConfig.ts.)
    forkCacheStrategy: readForkCacheStrategy(),
    blockingLimitHard: readBlockingLimitHardFromEnv(),
    // `thinkingBudgetTokens`: consumed by `stream.ts` as the adaptive
    // thinking-budget base (P3 audit fix 2026-07 — first QueryConfig
    // read-site migration; previously stream.ts read live ALS and this
    // snapshot had no consumer).
    ...(ctx?.thinkingBudgetTokens !== undefined
      ? { thinkingBudgetTokens: ctx.thinkingBudgetTokens }
      : {}),
    // §16.2 / §7.5 pass-throughs.
    //
    // Status (honest): no production code reads
    // `queryConfig.queryChainId` or `queryConfig.taskBudgetMs` TODAY —
    // runtime sites still consult ALS directly (`stream.ts` calls
    // `attachPoleQueryTrackingToTailUserMessage(getAgentContext())`;
    // `subAgentInheritance.resolveInheritedTaskBudgetMs` walks the
    // parent context). They are kept because `freezeQueryConfig`
    // accepts these fields, the QueryConfig type explicitly lists them
    // as "stable session identity" / "task budget", and
    // `query.test.ts:84-92` verifies the contract.
    //
    // Without this wiring, the type would promise fields that
    // `buildQueryConfig` silently drops — a more confusing state than
    // honest "snapshot may be unused today" scaffolding. When a phase
    // module migrates a read site from ALS to QueryConfig (per the
    // QueryConfig.ts migration plan), it lands here without a
    // second-source-of-truth puzzle.
    //
    // `queryChainId`: trim-then-check matches `queryTracking.ts:65`
    // (`ctx?.queryChainId?.trim() || generateQueryChainId()`) so the
    // two call sites agree on what counts as "no chainId set".
    ...(typeof ctx?.queryChainId === 'string' && ctx.queryChainId.trim().length > 0
      ? { queryChainId: ctx.queryChainId.trim() }
      : {}),
    // `taskBudgetMs`: positive-finite-number guard mirrors
    // `subAgentInheritance.ts:11` (rejects 0 / NaN / Infinity / neg).
    // Written onto AgentContext by `subAgentRunner` from
    // `agentDef.timeout`.
    ...(typeof ctx?.taskBudgetMs === 'number' && Number.isFinite(ctx.taskBudgetMs) && ctx.taskBudgetMs > 0
      ? { taskBudgetMs: ctx.taskBudgetMs }
      : {}),
  })
}

// ── Public entry ──

export function initialiseLoopState(
  params: AgenticLoopParams,
): LoopInitResult {
  const {
    config,
    model,
    systemPromptLayers: systemPromptLayersParam,
    maxTokens,
    enableTools = true,
    toolDefinitionsOverride,
    maxIterationsOverride,
    signal,
    effort: effortFromParams,
    diffPermissionMode: diffPermissionModeParam = 'default',
    permissionDefaultMode = 'ask',
    permissionRules,
    chatMode = 'agent',
    alwaysThinking,
    fastMode: fastModeFromParams,
    orchestratedToolExecution,
    hostTranscript,
    kernelLoopPort,
    appendixAFlow,
    temperature,
    topP,
  } = params

  const anthropicFastModeEnabled = fastModeFromParams === true
  const diffPermissionMode = applyDiffPermissionKillswitch(diffPermissionModeParam)

  const hasToolDefinitionsOverride = toolDefinitionsOverride !== undefined
  const baseToolDefinitions: LoopInitResult['baseToolDefinitions'] =
    toolDefinitionsOverride ?? (enableTools ? getToolDefinitions(permissionRules) : [])
  const lastToolsetRevision = toolRegistry.getToolsetRevision()
  const maxIterations = maxIterationsOverride || MAX_ITERATIONS

  // P1 audit fix (2026-07 阈值双源收敛) — the loop-local manager previously
  // applied a RAW `deriveContextThresholdsFromOpenClaudeWindow` here, which
  // diverged from `ContextManager.applyDynamicThresholdsForModel` (the
  // documented single source that also collapses the history-snip tier into
  // micro_compact and shifts micro to `auto - 2k`). Net effect of the old
  // wiring: history_snip (bare message dropping) was the dominant steady-state
  // compaction tier and the LLM `auto_compact` path was nearly unreachable —
  // the exact hallucination mechanism the manager's adjustments exist to
  // prevent. Additionally, `updateThresholds` marked the manager as
  // user-customized, so `evaluate(model)` could never re-derive on a
  // mid-conversation model switch.
  //
  // New wiring:
  //   - user HAS customized thresholds (Settings / persisted) → honour them
  //     verbatim (previously they were silently overwritten by derivation);
  //   - user has NOT customized → construct the manager pristine so the
  //     dynamic derivation stays enabled, then prime it for the session
  //     model via the ONE derivation path (`primeThresholdsForModel`).
  //     `evaluate(model)` re-derives automatically on model switch.
  //   - `POLE_OPENCLAUDE_CONTEXT_THRESHOLDS=0` escape hatch → legacy
  //     behaviour (global thresholds copied, no derivation).
  const userCustomizedThresholds = globalContextManager.hasUserCustomizedThresholds()
  const useOpenClaudeDerivedLoopThresholds =
    process.env.POLE_OPENCLAUDE_CONTEXT_THRESHOLDS !== '0' && !userCustomizedThresholds
  const loopContextManager = useOpenClaudeDerivedLoopThresholds
    ? new ContextManager()
    : new ContextManager(globalContextManager.getThresholds())
  if (useOpenClaudeDerivedLoopThresholds) {
    loopContextManager.primeThresholdsForModel(model)
  }

  const apiMessages: LoopInitResult['apiMessages'] = params.initialApiMessages
    ? params.initialApiMessages.map((m) =>
        typeof structuredClone === 'function'
          ? structuredClone(m)
          : (JSON.parse(JSON.stringify(m)) as Record<string, unknown>),
      )
    : params.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }))

  const totalUsage = { inputTokens: 0, outputTokens: 0 }

  const toolCallHistory =
    process.env.ASTRA_TOOL_CALL_HISTORY === '0' ? undefined : createToolCallHistory()

  const tokenBudgetState = initialiseTokenBudget()

  // 2026-06 audit — the IterationStallGuard singleton keys its streak by
  // conversation id and previously only reset on successful tool execution
  // or session teardown, so the streak accumulated ACROSS user turns: three
  // consecutive short no-tool replies (normal chit-chat) falsely tripped
  // `iteration_stalled`. A genuine new user turn IS forward progress —
  // zero the streak at loop start. Within-turn stall detection (the guard's
  // actual purpose) is unaffected.
  {
    const cidForStallReset = getAgentContext()?.streamConversationId?.trim()
    if (cidForStallReset) {
      try {
        getIterationStallGuard().resetFor(cidForStallReset)
      } catch (e) {
        console.warn('[Agentic Loop] stall guard resetFor at turn start threw:', e)
      }
    }
  }

  if (enableTools && baseToolDefinitions.length === 0) {
    console.warn('[Agentic Loop] Warning: enableTools=true but no tool definitions available')
  } else if (enableTools) {
    console.log(
      `[Agentic Loop] Using ${baseToolDefinitions.length} tools:`,
      baseToolDefinitions.map((t) => t.name),
    )
  }

  // P2-1 (2026-07 核心层做深) — build deps FIRST so the two clock seeds
  // below read through the `queryDeps.now` seam instead of bare
  // `Date.now()`. Deterministic-clock tests can now pin the very first
  // iteration's idle-clear arithmetic (previously Finding 7's partial seam).
  const queryDeps = buildQueryDeps(params)

  return {
    queryConfig: buildQueryConfig(params),
    queryDeps,
    config,
    model,
    enableTools,
    diffPermissionMode,
    permissionDefaultMode,
    permissionRules,
    chatMode,
    alwaysThinking,
    appendAppendixAFlow: appendixAFlow,
    temperature,
    topP,
    effortFromParams,
    anthropicFastModeEnabled,
    systemPromptLayers: systemPromptLayersParam,
    hasToolDefinitionsOverride,
    baseToolDefinitions,
    lastToolsetRevision,
    maxIterations,
    loopContextManager,
    useOpenClaudeDerivedLoopThresholds,
    apiMessages,
    accumulatedText: '',
    toolUseBlocks: [],
    thinkingBlocks: [],
    serverToolUseBlocks: [],
    codeExecutionResultBlocks: [],
    iteration: 0,
    totalUsage,
    lastStreamEndMs: queryDeps.now(),
    // "Never cleared yet" is expressed as `now`, not `0` (epoch). With `0`,
    // `now - lastIdleClearMs` is the full wall-clock timestamp — astronomically
    // larger than any idle threshold — so the idle-clear OR-guard
    // (`applyIdleToolClear`) would rely solely on `lastStreamEndMs` to suppress
    // a spurious clear on the very first message. Seeding `now` makes the
    // sentinel honest and removes that first-message misfire risk when the
    // idle threshold is configured small.
    lastIdleClearMs: queryDeps.now(),
    activeInlineSkillSession: null,
    tokenBudgetState,
    pendingToolUseSummary: null,
    discoveryExclude: new Set(),
    toolCallHistory,
    // P0 fix (audit §4.1) — seed from kernel-supplied state when present,
    // so a restart-recovered turn picks up the same soft-cap progress
    // instead of restarting the counter at 0.
    maxOutputRecoveryCycles: params.seedMetaCounters?.maxOutputRecoveryCycles ?? 0,
    lastStreamStopReason: undefined,
    streamMaxOutTokens: maxTokens ?? 8192,
    lastUserPlainBudgetSource: undefined,
    terminationResult: null,
    lastStreamUsageForPole: null,
    lastStreamInputTokens: 0,
    iterationModel: model,
    iterationToolDefs: baseToolDefinitions,
    iterationEffort: effortFromParams,
    toolsForApi: undefined,
    openAiStrictToolNames: undefined,
    toolTokensForContext: 0,
    collapseConversationKey: '',
    signal,
    callbacks: undefined as unknown as LoopInitResult['callbacks'], // set by runAgenticLoop
    appendixReport: () => {}, // set by runAgenticLoop
    syncConversation: () => {}, // set by runAgenticLoop
    acceptHostTranscript: () => {}, // set by runAgenticLoop
    refreshMainChatContextHeader: () => {}, // set by runAgenticLoop
    profiler: createQueryProfiler(),
    stopHookActive: new Set<string>(),
    consecutiveStopHookBlocks: 0,
    declaredIntentNudgeCount: 0,
    lastToolBatchAllErrors: false,
    allToolsFailedNudgeCount: 0,
    verificationGateNudgeCount: 0,
    thinkingOnlySilentTurnNudgeCount: 0,
    completionEvidenceChallengeCount: 0,
    reactiveCompactAttempts: 0,
    adaptiveThinkingFullBudgetLatched: false,
    // P0 fix (audit §4.1) — same rationale as `maxOutputRecoveryCycles`
    // above: pick up the kernel-persisted counter so a restart-recovered
    // turn enforces the soft cap correctly.
    consecutiveCompactFailures: params.seedMetaCounters?.consecutiveCompactFailures ?? 0,
    withheldStreamError: null,
    withheldStreamSignal: null,
    transition: 'init',
    transitionHistory: [],
    lastPhaseAwareCompactIteration: 0,
    orchestratedToolExecution,
    hostTranscript,
    kernelLoopPort,
  }
}
