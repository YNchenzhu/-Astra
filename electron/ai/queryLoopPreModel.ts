/**
 * upstream report §6.1 — steps **before** each model stream in `runAgenticLoop` (queryLoop analogue).
 *
 * Ordering (subset aligned with report):
 * 1. Skill discovery prefetch — done in {@link runAgenticLoop} (iteration 1 + post-tool follow-up).
 * 2. Tool result budget — {@link clampToolResultsInMessages} (message-level cap).
 * 2b. Idle tool clear — when already applied this iteration (§4.1.1), recorded as `idle_tool_clear`.
 * 2c. Optional auto context-collapse segment — `POLE_CONTEXT_COLLAPSE_AUTO=1` → {@link autoFoldOldestMessagesForContextCollapse}.
 * 3. Snip compact — {@link snipOldestMessagesForBudget} when over auto-compact region.
 * 4b. Context collapse drain — when estimated tokens ≥ ~90% effective window, inject queued
 *     summaries ({@link drainContextCollapseForReactiveCompact}) before ContextManager.
 * 4c. Optional Anthropic `countTokens` (`POLE_ANTHROPIC_COUNT_TOKENS=1`) — primes {@link ContextManager}
 *     one-shot prefetched total before handleContext.
 * 5–7. Micro-compact / blocking micro / auto-compact — {@link ContextManager.handleContext}.
 *
 * Not equivalent to upstream StreamingToolExecutor or full Stop hook matrix; see strict AC-6.1 notes.
 */

import type { ContextManager } from '../context/manager'
import type { CompactOptions } from '../context/compact'
import { clampToolResultsInMessages } from './toolResultBudget'
import { collectActiveTaskRelevanceTerms } from '../context/activeTaskRelevance'
import { snipOldestMessagesForBudget } from '../context/historySnip'
import {
  SNIP_TARGET_MARGIN_BELOW_AUTO,
  getContextCollapseDrainThresholdTokens,
} from '../context/openClaudeParityConstants'
import { drainContextCollapseForReactiveCompact } from '../context/contextCollapseDrain'
import { getAgentContext } from '../agents/agentContext'
import { recordSnipEvent } from '../context/snipNudgeTracker'
import { injectInvokedSkillsIntoLastUserMessage } from '../skills/invokedSkillsRegistry'
import { tryPrefetchAnthropicInputTokens } from '../context/conversationTokenMeter'
import type { ToolDefinition } from '../tools/types'
import type { SystemPromptLayers } from './systemPrompt'
import { autoFoldOldestMessagesForContextCollapse } from '../context/contextCollapseAuto'
import { logAnalyzeContextDevLine } from '../context/analyzeContextDev'
import type { PermissionRulePayload } from './permissionRuleMatch'
import { maybeAppendToolPoolTranscriptDeltas } from '../context/toolPoolTranscriptDeltas'

export type QueryLoopPreModelPhase =
  | 'idle_tool_clear'
  | 'tool_result_budget'
  | 'history_snip'
  | 'context_collapse_auto'
  | 'context_collapse_drain'
  | 'anthropic_count_tokens'
  | 'micro_compact'
  | 'auto_compact'
  | 'blocking_micro'
  | 'context_manager_none'

export type RunQueryLoopPreModelParams = {
  apiMessages: Array<Record<string, unknown>>
  systemPrompt: string
  toolDefsTokens: number
  loopContextManager: ContextManager
  compactOptions: CompactOptions
  /** Same thresholds object used for snip target math */
  thresholds: ReturnType<ContextManager['getThresholds']>
  /** Main-thread idle clear ran before this pipeline (see {@link clearCompletedToolResultsExceptRecent}). */
  idleToolClearApplied?: boolean
  /**
   * Model id for effective-window math (§6.3 collapse-drain threshold). Omit to skip collapse drain.
   */
  model?: string
  /**
   * Tests only: override collapse-drain threshold (token estimate). When set, {@link RunQueryLoopPreModelParams.model} optional.
   */
  contextCollapseTokenThresholdOverride?: number
  /**
   * When set and env `POLE_ANTHROPIC_COUNT_TOKENS=1`, calls Anthropic `messages.countTokens` before
   * {@link ContextManager.handleContext} so thresholds use server-side totals (1P API only).
   */
  anthropicPrefetch?: {
    providerId: string
    apiKey: string
    baseUrl?: string
    model: string
    tools?: ToolDefinition[]
    systemPromptLayers?: SystemPromptLayers
    signal?: AbortSignal
  }
  /** Chat permission rules — forwarded into deferred-tool pool delta (upstream parity). */
  permissionRules?: ReadonlyArray<PermissionRulePayload>
}

export type RunQueryLoopPreModelResult = {
  messages: Array<Record<string, unknown>>
  phases: QueryLoopPreModelPhase[]
  snippedCount: number
  wasContextManaged: boolean
  contextLevelAfter?: string
  /**
   * Best-effort pre/post token-estimate snapshots, used by `preModel.ts`
   * to build the `CompactDetail` payload for `onContextCompact`. Populated
   * only on the path that actually ran the corresponding step:
   *   - `snipPre/PostTokens` set when the snip phase reclaimed messages
   *   - `ctxPre/PostTokens` set when `handleContext` reported `wasCompacted`
   * Both are `estimatedTokens` from the unified estimator, so they include
   * messages + system + toolTokens.
   */
  snipPreTokens?: number
  snipPostTokens?: number
  ctxPreTokens?: number
  ctxPostTokens?: number
}

/**
 * Apply §6.1-style pre-model compaction chain (tool budget → optional snip → ContextManager).
 */
export async function runQueryLoopPreModelSteps(
  params: RunQueryLoopPreModelParams,
): Promise<RunQueryLoopPreModelResult> {
  const phases: QueryLoopPreModelPhase[] = []
  if (params.idleToolClearApplied) {
    phases.push('idle_tool_clear')
  }
  // 2026-07 uplift #10 — relevance-weighted eviction: tool results tied to
  // the open todos / plan steps are evicted LAST by the global sweep.
  let messages = clampToolResultsInMessages(params.apiMessages, {
    relevanceTerms: collectActiveTaskRelevanceTerms(),
  })
  phases.push('tool_result_budget')
  messages = maybeAppendToolPoolTranscriptDeltas(messages, params.permissionRules)

  const th = params.thresholds
  const collapseKeyEarly = params.compactOptions.collapseConversationKey?.trim()
  if (collapseKeyEarly && params.compactOptions.config) {
    const folded = await autoFoldOldestMessagesForContextCollapse({
      messages,
      systemPrompt: params.systemPrompt,
      thresholds: th,
      toolDefsTokens: params.toolDefsTokens,
      config: params.compactOptions.config,
      model: (params.model || params.compactOptions.model || 'claude-sonnet-4-20250514').trim(),
      signal: params.compactOptions.signal,
      collapseConversationKey: collapseKeyEarly,
    })
    if (folded) {
      messages = folded
      phases.push('context_collapse_auto')
      params.loopContextManager.clearUsageSnapshot()
    }
  }

  // Use the ContextManager's unified estimator so snip/collapse gates see
  // the same number that `evaluate()` will see below — prefetched Anthropic
  // count, `_poleContextUsage` anchors, and `lastUsageInputTokens + tail`
  // all take precedence over the raw heuristic when available (audit
  // Bug 4). Peek mode: don't consume the prefetched count here; `evaluate`
  // will still see it.
  const estAfterClamp = params.loopContextManager.estimateTotalInputTokensPeek(
    messages,
    params.systemPrompt,
    params.toolDefsTokens,
    false,
  )

  let snippedCount = 0
  let snipPreTokens: number | undefined
  let snipPostTokens: number | undefined
  if (estAfterClamp > th.autoCompactTokens) {
    const { messages: snipped, snippedCount: sc } = snipOldestMessagesForBudget(messages, {
      systemPrompt: params.systemPrompt,
      toolDefsTokens: params.toolDefsTokens,
      targetTotalTokens: Math.max(
        th.warningTokens,
        th.autoCompactTokens - SNIP_TARGET_MARGIN_BELOW_AUTO,
      ),
      minMessagesToKeep: 4,
      protectedToolUseIds: params.compactOptions.protectedToolUseIds,
    })
    if (sc > 0) {
      messages = snipped
      snippedCount = sc
      phases.push('history_snip')
      params.loopContextManager.clearUsageSnapshot()
      snipPreTokens = estAfterClamp
      // Feed the `context_efficiency` collector's growth tracker so
      // the nudge baseline resets after the host freed space. Reuse the
      // same `postEst` for the CompactDetail surfaced to onContextCompact.
      const postEst = params.loopContextManager.estimateTotalInputTokensPeek(
        messages,
        params.systemPrompt,
        params.toolDefsTokens,
        false,
      )
      snipPostTokens = postEst
      const convId = getAgentContext()?.streamConversationId?.trim()
      if (convId) {
        recordSnipEvent(convId, postEst, Math.max(0, estAfterClamp - postEst))
      }
    }
  }

  const collapseKey = params.compactOptions.collapseConversationKey?.trim()
  if (collapseKey) {
    const collapseModel =
      (params.model?.trim() || params.compactOptions.model?.trim() || 'unknown-model').trim() ||
      'unknown-model'
    const estForCollapse = params.loopContextManager.estimateTotalInputTokensPeek(
      messages,
      params.systemPrompt,
      params.toolDefsTokens,
      false,
    )
    const collapseAt = getContextCollapseDrainThresholdTokens(
      collapseModel,
      params.contextCollapseTokenThresholdOverride,
    )
    if (estForCollapse >= collapseAt) {
      const beforeLen = messages.length
      messages = drainContextCollapseForReactiveCompact(messages, {
        conversationKey: collapseKey,
      })
      if (messages.length > beforeLen) {
        phases.push('context_collapse_drain')
        params.loopContextManager.clearUsageSnapshot()
      }
    }
  }

  if (params.anthropicPrefetch) {
    const p = params.anthropicPrefetch
    const counted = await tryPrefetchAnthropicInputTokens({
      providerId: p.providerId,
      apiKey: p.apiKey,
      baseUrl: p.baseUrl,
      model: p.model,
      messages,
      systemPrompt: params.systemPrompt,
      systemPromptLayers: p.systemPromptLayers,
      tools: p.tools,
      signal: p.signal,
    })
    if (counted != null) {
      params.loopContextManager.setPrefetchedInputTokensForNextEvaluate(counted)
      phases.push('anthropic_count_tokens')
    }
  }

  // Audit fix — top-level `params.permissionRules` was historically lost on its
  // way into `handleContext` because we spread only `params.compactOptions`
  // into `compactOpts` and the rules never lived in that nested record. Merge
  // them in explicitly so the post-compact tool-pool-delta builder downstream
  // sees the same rules the chat is operating under.
  const compactOpts = {
    ...params.compactOptions,
    ...(params.permissionRules ? { permissionRules: params.permissionRules } : {}),
    messages,
  }
  // Snapshot pre-handleContext estimate so we can report `reclaimedTokens`
  // on the CompactDetail payload. Peek mode preserves any prefetched
  // anthropic count so `evaluate()` inside handleContext still sees it.
  const ctxPreTokensCandidate = params.loopContextManager.estimateTotalInputTokensPeek(
    messages,
    params.systemPrompt,
    params.toolDefsTokens,
    false,
  )

  const ctxOut = await params.loopContextManager.handleContext(
    messages,
    params.systemPrompt,
    compactOpts,
    params.toolDefsTokens,
  )

  let contextLevelAfter: string | undefined
  let ctxPreTokens: number | undefined
  let ctxPostTokens: number | undefined
  if (ctxOut.wasCompacted) {
    messages = ctxOut.messages
    const lvl = params.loopContextManager.getState().level
    contextLevelAfter = lvl
    messages = injectInvokedSkillsIntoLastUserMessage(messages, getAgentContext()?.agentId)
    if (lvl === 'micro_compact') phases.push('micro_compact')
    else if (lvl === 'auto_compact') phases.push('auto_compact')
    else if (lvl === 'blocking') phases.push('blocking_micro')
    else phases.push('micro_compact')
    params.loopContextManager.clearUsageSnapshot()
    ctxPreTokens = ctxPreTokensCandidate
    ctxPostTokens = params.loopContextManager.getState().estimatedTokens
  } else {
    phases.push('context_manager_none')
  }

  logAnalyzeContextDevLine({
    systemPrompt: params.systemPrompt,
    messages,
    toolDefsTokens: params.toolDefsTokens,
    phases,
    model: params.model || params.compactOptions.model,
  })

  return {
    messages,
    phases,
    snippedCount,
    wasContextManaged: ctxOut.wasCompacted,
    contextLevelAfter,
    snipPreTokens,
    snipPostTokens,
    ctxPreTokens,
    ctxPostTokens,
  }
}
