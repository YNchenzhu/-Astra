/**
 * Agentic loop — pre-model pipeline.
 * Extracted from agenticLoop.ts (§ Query-loop pre-model, § Skill discovery, § Budget checks).
 */

import { app } from 'electron'
import { runQueryLoopPreModelSteps } from '../queryLoopPreModel'
import { buildDiscoveryQuery, buildSkillDiscoveryInjection, injectSkillDiscoveryIntoLastUserMessage } from '../../skills/skillDiscovery'
import { getWorkspacePath } from '../../tools/workspaceState'
import { buildContextCollapseConversationKey } from '../../context/contextCollapseStore'
import { getAgentContext } from '../../agents/agentContext'
import { resolveConversationFilePath } from '../../conversation/storage'
import { buildCompactSideAttachmentIds } from '../agenticLoopHelpers'
import { clearCompletedToolResultsExceptRecent } from '../../context/idleToolResultClear'
import { getIdleToolClearMs } from '../../context/openClaudeParityConstants'
import {
  applyPoleOutputTokenBudgetFromUserText,
  extractLastUserTurnPlainText,
  getPoleOutputBudgetBlockMessage,
} from '../../context/tokenBudgetUserCommands'
import { createTerminalResult, runTerminationCleanup } from '../queryTermination'
import type { PreModelInput, PreModelOutput, LoopState } from './loopShared'

/**
 * Resolve the on-disk path for the active conversation's persisted JSON
 * so we can embed a `transcriptPath` hint inside the post-compact
 * boundary user message. Returns `undefined` when any required piece is
 * missing (no agent context / no conversation id / no workspace / app
 * isn't ready) — `compact.ts` then simply omits the hint.
 *
 * Wrapped in try/catch because `app.getPath('userData')` throws if the
 * app isn't initialised yet (theoretical in test envs; not in prod
 * since the agentic loop only runs after `app.whenReady`).
 */
function resolveTranscriptPathIfPossible(wsPath: string | undefined | null): string | undefined {
  try {
    const cid = getAgentContext()?.streamConversationId?.trim()
    if (!cid) return undefined
    const ws = (wsPath || '').trim()
    if (!ws) return undefined
    return resolveConversationFilePath(app.getPath('userData'), ws, cid)
  } catch {
    return undefined
  }
}

// ── Idle tool result clear ──

function isSkillDiscoveryPrefetchEnabled(): boolean {
  const raw = process.env.POLE_SKILL_DISCOVERY_PREFETCH?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * @param apiMessages Optional working copy of the transcript for THIS
 *   pipeline pass (post-skill-discovery). Defaults to `state.apiMessages`.
 *
 *   P2-1 audit fix (2026-07) — the caller used to pass a SPREAD COPY of the
 *   whole state (`{ ...state, apiMessages: msgs }`), so the
 *   `state.lastIdleClearMs = now` write-back below landed on the throwaway
 *   copy and the real LoopState never learned a clear had happened — the
 *   `sinceLastClear` throttle was ineffective across iterations. The
 *   transcript override is now a separate parameter and `state` is always
 *   the REAL LoopState, so the write-back persists.
 */
export function applyIdleToolClear(
  state: LoopState,
  apiMessages?: Array<Record<string, unknown>>,
): {
  apiMessages: Array<Record<string, unknown>>
  applied: boolean
} {
  const msgs = apiMessages ?? state.apiMessages
  const ctx = getAgentContext()
  const isMainChat = !ctx?.agentId || ctx.agentId === 'main'
  if (!isMainChat) return { apiMessages: msgs, applied: false }

  // 5-piece-set §A3 — read the clock through the queryDeps seam so tests
  // can inject a deterministic `now()` instead of the fragile
  // `lastStreamEndMs: Date.now() - 60_000` pattern. Production behaviour
  // is unchanged: `defaultQueryDeps` wires `now` to `Date.now`.
  const now = state.queryDeps.now()
  const idleThresholdMs = getIdleToolClearMs()
  const idleElapsed = now - state.lastStreamEndMs
  const sinceLastClear = now - state.lastIdleClearMs
  if (idleElapsed < idleThresholdMs || sinceLastClear < idleThresholdMs) {
    return { apiMessages: msgs, applied: false }
  }

  const cleared = clearCompletedToolResultsExceptRecent(msgs, 8)
  state.lastIdleClearMs = now
  return { apiMessages: cleared, applied: true }
}

// ── Public entry ──

export async function runPreModelPhase(input: PreModelInput): Promise<PreModelOutput> {
  const { state, systemPrompt, isIterationOne, hasInitialApiMessages } = input
  let msgs = [...state.apiMessages]

  // Skill discovery (iteration 1 only, without initial messages).
  // Default off: upstream-style progressive disclosure keeps the main
  // context lean. The DiscoverSkills tool remains available when the model
  // needs an explicit skill lookup after a task pivot.
  if (isSkillDiscoveryPrefetchEnabled() && isIterationOne && !hasInitialApiMessages) {
    const q = buildDiscoveryQuery(msgs)
    const { injection, surfacedNames } = buildSkillDiscoveryInjection(q, {
      excludeNames: state.discoveryExclude,
    })
    for (const n of surfacedNames) state.discoveryExclude.add(n)
    injectSkillDiscoveryIntoLastUserMessage(msgs, injection)
    state.appendixReport('P2_Q_skill_discovery_prefetch', {
      iteration: state.iteration,
      surfacedCount: surfacedNames.length,
    })
  }

  // Idle tool result clear. Pass the REAL state (not a spread copy) so the
  // `lastIdleClearMs` write-back persists across iterations — see the P2-1
  // note on `applyIdleToolClear`.
  const { apiMessages: afterIdle, applied: idleApplied } = applyIdleToolClear(state, msgs)
  msgs = afterIdle

  // Build collapse key
  const wsPath = getWorkspacePath()
  const collapseKey = buildContextCollapseConversationKey(
    wsPath?.trim() || undefined,
    getAgentContext()?.streamConversationId,
  )
  const transcriptPath = resolveTranscriptPathIfPossible(wsPath)

  // Run pre-model pipeline
  const preModel = await runQueryLoopPreModelSteps({
    apiMessages: msgs,
    systemPrompt,
    toolDefsTokens: state.toolTokensForContext,
    loopContextManager: state.loopContextManager,
    compactOptions: {
      config: state.config,
      model: state.iterationModel,
      systemPrompt,
      messages: msgs,
      signal: state.signal,
      collapseConversationKey: collapseKey,
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(state.activeInlineSkillSession?.skillName
        ? { activeSkillName: state.activeInlineSkillSession.skillName }
        : {}),
      ...buildCompactSideAttachmentIds(),
      onCompactStart: (d) => state.callbacks.onContextCompactStart?.({ level: d.level }),
    },
    thresholds: state.loopContextManager.getThresholds(),
    idleToolClearApplied: idleApplied,
    model: state.iterationModel,
    anthropicPrefetch:
      state.config.id === 'anthropic' && (state.config.apiKey || '').trim()
        ? {
            providerId: state.config.id,
            apiKey: state.config.apiKey || '',
            baseUrl: state.config.baseUrl,
            model: state.iterationModel,
            tools: state.toolsForApi,
            systemPromptLayers: state.systemPromptLayers,
            signal: state.signal,
          }
        : undefined,
    permissionRules: state.permissionRules,
  })

  msgs = preModel.messages
  state.appendixReport('P2_Q_preprocess_pipeline', {
    iteration: state.iteration,
    phase: 'complete',
    phases: preModel.phases,
    snippedCount: preModel.snippedCount,
    wasContextManaged: preModel.wasContextManaged,
  })

  // Phase B migration: the legacy supervisor-style sub-agent output
  // splice (`injectPendingSubAgentOutputsForMainTurn`) used to fire
  // here every iteration. It now runs at `post_tool` via the
  // `subAgentOutputs` collector in `hostAttachments`. The
  // `streamHandler.ts` user-turn-entry call is preserved separately —
  // that's the moment a fresh user message lands and the model needs
  // pre-existing deltas before its first thought. Inside the loop
  // (between iterations), the post-tool collector covers the same
  // signal with upstream-aligned timing.

  const plainUser = extractLastUserTurnPlainText(msgs)
  if (plainUser && plainUser !== state.lastUserPlainBudgetSource) {
    state.lastUserPlainBudgetSource = plainUser
    applyPoleOutputTokenBudgetFromUserText(plainUser)
  }

  const budgetBlock = getPoleOutputBudgetBlockMessage()
  if (budgetBlock) {
    state.callbacks.onError(budgetBlock)
    state.callbacks.onMessageEnd(state.totalUsage)
    // Audit Bug 8 — was previously misclassified as `'blocking_limit'`
    // (= input/context too long), which steered the UI / triage toward
    // shrinking context when the actual ceiling hit was the user-set
    // output token budget. Use the dedicated reason so consumers can
    // surface the correct fix ("raise budget" vs. "shrink context").
    state.terminationResult = createTerminalResult('output_budget_exhausted', {
      turnCount: state.iteration,
      totalUsage: state.totalUsage,
      errorDetail: 'Output token budget exhausted',
    })
    await runTerminationCleanup(state.terminationResult)
    return {
      apiMessages: msgs,
      wasPreModelCompacted: preModel.wasContextManaged,
      contextLevelAfter: preModel.contextLevelAfter ?? state.loopContextManager.getState().level,
      snippedCount: preModel.snippedCount,
      pipelinePhases: preModel.phases,
      idleToolClearApplied: idleApplied,
      terminated: true,
    }
  }

  // Fire compact callbacks
  if (preModel.snippedCount > 0 && state.callbacks.onContextCompact) {
    const pre = preModel.snipPreTokens
    const post = preModel.snipPostTokens
    state.callbacks.onContextCompact({
      level: 'history_snip',
      preTokens: pre,
      postTokens: post,
      reclaimedTokens:
        pre != null && post != null ? Math.max(0, pre - post) : undefined,
    })
  }
  if (preModel.wasContextManaged && state.callbacks.onContextCompact) {
    const pre = preModel.ctxPreTokens
    const post = preModel.ctxPostTokens
    state.callbacks.onContextCompact({
      level: preModel.contextLevelAfter ?? state.loopContextManager.getState().level,
      preTokens: pre,
      postTokens: post,
      reclaimedTokens:
        pre != null && post != null ? Math.max(0, pre - post) : undefined,
    })
  }

  return {
    apiMessages: msgs,
    wasPreModelCompacted: preModel.wasContextManaged,
    contextLevelAfter: preModel.contextLevelAfter ?? state.loopContextManager.getState().level,
    snippedCount: preModel.snippedCount,
    pipelinePhases: preModel.phases,
    idleToolClearApplied: idleApplied,
    terminated: false,
  }
}
