/**
 * Context threshold evaluator and orchestrator.
 * Multi-level: warning → error → micro-compact → auto-compact → block.
 */

import { estimateConversationTokens, estimateMessagesOnlyTokens } from './tokenCounter'
import { buildContextBreakdown, type ContextBreakdown } from './contextBreakdown'
import {
  contextUsagePercentForModel,
  tokenCountWithEstimationFromMessageAnchors,
} from './tokenUsageAccounting'
import { microCompact, autoCompact, type CompactOptions } from './compact'
import { clampToolResultsInMessages } from '../ai/toolResultBudget'
import { clearCompletedToolResultsExceptRecent } from './idleToolResultClear'
import { snipOldestMessagesForBudget } from './historySnip'
import {
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  SNIP_TARGET_MARGIN_BELOW_AUTO,
  deriveContextThresholdsFromOpenClaudeWindow,
  getCompactPlanningWindowTokens,
} from './openClaudeParityConstants'
import { emitContextTelemetryEvent } from '../telemetry/contextEvents'
import { trySessionMemoryCompact } from './sessionMemoryCompact'
import { buildActiveSkillRebuildAttachment } from './postCompactAttachments'
import { getAgentContext } from '../agents/agentContext'
import { signalMicroCompactForPromptCache } from './cachedMicrocompactPromptCache'
import { postCompactCleanup } from '../agents/postCompactCleanup'
import {
  type CompactAttempt,
  type CompactHistory,
  isCompactDiminishing,
  recordCompactAttempt,
} from './compactDiminishingReturns'

function compactDedupeKey(kind: string, msgCountBefore: number, estBefore: number): string {
  const cid = getAgentContext()?.streamConversationId?.trim() ?? 'na'
  return `${cid}|${kind}|${msgCountBefore}|${estBefore}`
}
import { runPreCompactHooks, runPostCompactHooks } from '../tools/hooks/engine'
import { getWorkspacePath } from '../tools/workspaceState'
import {
  SIDE_CHANNEL_KIND,
  makeSideChannelUserMessage,
} from '../constants/sideChannelKinds'

/**
 * Audit fix (A-1) — build a model-visible side-channel marker announcing
 * the silent truncations that history_snip / micro_compact / soft_clear
 * just performed. Without this, the model treats the (now-trimmed)
 * earlier transcript as ground truth and re-uses dropped facts.
 *
 * Inserted as a `<system-reminder>`-wrapped user-role message at the
 * head of the returned message list so the model reads it before any
 * surviving turn content. Uses {@link SIDE_CHANNEL_KIND.genericConvertedSystem}
 * — the marker text itself is the distinguishing signal (similar to
 * how `compactSummary` and `contextCollapseAuto` are distinguished by
 * their leading bracket markers).
 */
function buildContextCompactionMarker(
  kind: 'history_snip' | 'micro_compact' | 'soft_clear',
  detail: {
    droppedCount?: number
    transcriptPath?: string
  },
): Record<string, unknown> {
  let body: string
  if (kind === 'history_snip') {
    const n = detail.droppedCount ?? 0
    body =
      `[Context budget — ${n} older message${n === 1 ? '' : 's'} dropped from the conversation to stay within the token budget. ` +
      `Any facts, tool outputs, or commitments that lived only in those messages are NO LONGER visible. ` +
      `Re-read files or re-run tools rather than relying on memory of dropped content.`
  } else if (kind === 'micro_compact') {
    body =
      `[Context budget — tool_result contents from older iterations have been condensed to placeholders ` +
      `("[Previous tool output truncated - N chars]") to stay within the token budget. ` +
      `If you need the exact bytes of an earlier read/glob/grep result, re-run the tool rather than ` +
      `assuming the truncated placeholder still contains the data.`
  } else {
    body =
      `[Context budget — older completed tool_result string bodies have been cleared to free tokens. ` +
      `The most recent results are intact; if you need earlier results, re-run the tool.`
  }
  if (detail.transcriptPath) {
    body += ` Pre-compaction transcript on disk: ${detail.transcriptPath}`
  }
  body += `]`
  return makeSideChannelUserMessage(SIDE_CHANNEL_KIND.genericConvertedSystem, body)
}

export interface ContextThresholds {
  warningTokens: number
  errorTokens: number
  /**
   * History-snip tier — drop oldest transcript messages.
   *
   * Sits between {@link errorTokens} (soft_clear) and {@link microCompactTokens}
   * (cache-edit compaction). Snip is the **lightest** upstream compaction step
   * (report §9.1): zero LLM cost, just slice the message array. We try it
   * before micro_compact so the cache-friendly micro path doesn't have to
   * fight with rotten tail history.
   *
   * Defaults to 70_000 in {@link DEFAULT_THRESHOLDS} — invariant
   * `errorTokens < historySnipTokens < microCompactTokens` is enforced in
   * {@link ContextManager.updateThresholds}.
   */
  historySnipTokens: number
  microCompactTokens: number
  autoCompactTokens: number
  blockingTokens: number
  /** Reserved for future compaction anchor logic; persisted for Settings UI parity. */
  anchorBudgetChars: number
}

/**
 * Defaults tuned for ~100k–200k effective model windows using our **heuristic** token
 * estimator (~chars/4). Previous defaults (~180k/200k) almost never fired in normal use.
 * Users can raise them in Settings → Advanced context; power users with huge contexts should.
 */
export const DEFAULT_THRESHOLDS: ContextThresholds = {
  warningTokens: 52_000,
  errorTokens: 64_000,
  historySnipTokens: 70_000,
  microCompactTokens: 76_000,
  autoCompactTokens: 88_000,
  blockingTokens: 102_000,
  anchorBudgetChars: 4000,
}

export type ContextLevel =
  | 'ok'
  | 'warning'
  | 'error'
  | 'history_snip'
  | 'micro_compact'
  | 'auto_compact'
  | 'blocking'

export interface ContextState {
  estimatedTokens: number
  level: ContextLevel
  compactCount: number
  consecutiveCompactFailures: number
  lastCompactSummary?: string
  /** upstream §2.3 — `estimatedTokens / modelWindow * 100` when {@link ContextManager.evaluate} receives `model`. */
  usagePercentOfWindow?: number
  /** Production context-ring breakdown by payload class. */
  breakdown?: ContextBreakdown
}

type ContextAction =
  | 'none'
  | 'soft_clear'
  | 'history_snip'
  | 'micro_compact'
  | 'auto_compact'
  | 'block'

const CONTEXT_ACTION_RANK: Record<ContextAction, number> = {
  none: 0,
  soft_clear: 1,
  history_snip: 2,
  micro_compact: 3,
  auto_compact: 4,
  block: 5,
}

/**
 * 2026-07 reentry guard — growth escape ratio. A blocked auto_compact tier
 * re-arms once the current estimate exceeds the recorded post-compact size
 * by this factor (10% of a 200k window ≈ 20k tokens of genuinely new
 * material — enough that a fresh summary pass can actually fold something).
 * See {@link ContextManager.shouldSkipAutoCompactReentry}.
 */
const AUTO_COMPACT_REENTRY_GROWTH_RATIO = 1.1

function levelForAction(action: ContextAction): ContextLevel {
  if (action === 'soft_clear') return 'error'
  if (action === 'block') return 'blocking'
  if (action === 'none') return 'ok'
  return action
}

function maybeUpgradeForProactiveCompact(
  action: ContextAction,
  proactiveAction?: CompactOptions['proactiveCompact'],
): ContextAction {
  if (!proactiveAction || action === 'block') return action
  const requested = proactiveAction.action
  if (CONTEXT_ACTION_RANK[requested] <= CONTEXT_ACTION_RANK[action]) {
    return action
  }
  return requested
}

export class ContextManager {
  private thresholds: ContextThresholds
  private state: ContextState
  /** Last API-reported input_tokens for a request; paired with message count at send time (upstream §3.3). */
  private lastUsageInputTokens?: number
  private messageCountAtLastUsage?: number
  /**
   * One-shot total from Anthropic `messages.countTokens` (§3.1), includes system + messages + tools.
   * Consumed on next {@link estimateTotalInputTokens} / {@link evaluate}.
   */
  private prefetchedInputTokens?: number
  private lastUsageSnapshot?: Record<string, unknown>
  /**
   * True once {@link updateThresholds} or a non-empty constructor argument has
   * supplied thresholds. While false, {@link applyDynamicThresholdsForModel}
   * is allowed to derive thresholds from the active model's context window so
   * 1M / 256K / 200K windows don't share the (200K-tuned) fallback defaults.
   *
   * Why this matters: upstream-main external builds run one `autoCompact` at
   * `window - 33_000`, so a 1M-window user lands at ~967K — using cursor's
   * 88K fallback for a 1M model forces a compact at ~9% of capacity and is
   * the dominant cause of mid-session hallucination on long contexts.
   */
  private userCustomizedThresholds = false
  /** Caches the last model the derivation ran for so repeat turns no-op. */
  private lastDerivedThresholdsModel: string | undefined

  /**
   * P3.1 — Rolling log of recent compact attempts. Pushed on every
   * compact that runs to completion (success path of microcompact /
   * autocompact / snip / session-memory / soft-clear). Consumed by
   * {@link isCompactDiminishingGate} so the orchestrator can detect
   * "we're spinning on compacts that don't free meaningful tokens" and
   * stop trying. upstream parity: their `tokenBudget.ts` diminishing
   * returns logic applied to the compact subsystem.
   */
  private compactHistory: CompactHistory = []

  /**
   * 2026-07 reentry guard (cc-haha `shouldSkipRecompactionReentry` parity) —
   * post-compact token estimate of the most recent SUCCESSFUL auto-tier
   * compact (LLM auto_compact, session-memory compact, or block-tier
   * escalation). When this is still at/above `autoCompactTokens`, the
   * summary itself is the bulk: re-running the LLM summarizer over an
   * already-summarized transcript reclaims ~nothing and just burns an
   * LLM call per iteration — every pass "succeeds", so the
   * `consecutiveCompactFailures` breaker never sees it. {@link evaluate}
   * skips the auto_compact tier while the guard holds and falls through
   * to the cheap micro tier; the blocking tier's escalation path stays
   * UNGATED on purpose (it is the livelock escape hatch of last resort).
   *
   * Instance lifetime = one agentic-loop run for the loop-local manager
   * (`agenticLoop/setup.ts` news one per run), so the guard naturally
   * resets on the next user turn — same scoping as cc-haha's
   * `AutoCompactTrackingState.lastTruePostCompactTokenCount`.
   */
  private lastAutoCompactPostTokens?: number

  constructor(thresholds?: Partial<ContextThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds }
    // Explicit constructor thresholds count as user customization so the
    // dynamic-from-model derivation never silently overwrites them. Empty
    // object `{}` is still treated as "no preference" — the runtime singleton
    // is built with no arg, but tests often pass `{}` accidentally.
    if (thresholds && Object.keys(thresholds).length > 0) {
      this.userCustomizedThresholds = true
    }
    this.state = {
      estimatedTokens: 0,
      level: 'ok',
      compactCount: 0,
      consecutiveCompactFailures: 0,
      usagePercentOfWindow: undefined,
    }
  }

  /**
   * P1 audit fix (2026-07 阈值双源收敛) — expose the model-window derivation
   * as an explicit priming entry so `agenticLoop/setup.ts` can seed a fresh
   * loop-local manager from THE SAME derivation `evaluate()` uses, instead of
   * re-implementing a second (divergent, un-adjusted) derivation inline.
   *
   * Only meaningful on a manager whose thresholds are NOT user-customized
   * (i.e. constructed with no arguments); on a customized manager this is a
   * no-op, same as the `evaluate()`-time derivation.
   */
  primeThresholdsForModel(model: string): void {
    this.applyDynamicThresholdsForModel(model)
  }

  /**
   * True when thresholds were supplied explicitly (constructor argument or
   * {@link updateThresholds}) — the signal that dynamic-from-model
   * derivation must not overwrite them. Read by `agenticLoop/setup.ts` to
   * decide whether the loop-local manager should use model-derived
   * thresholds or honour the user's Settings values.
   */
  hasUserCustomizedThresholds(): boolean {
    return this.userCustomizedThresholds
  }

  /**
   * Realign thresholds to the active model's context window when the user
   * hasn't customized them. Mirrors upstream-main's
   * `getAutoCompactThreshold(model) = window - 33_000` shape, then layers two
   * upstream-external-parity adjustments on top:
   *
   * 1. `historySnipTokens` is pulled UP to `microCompactTokens`. upstream's
   *    `snipCompact` only exists behind `feature('HISTORY_SNIP')` which is
   *    OFF in external builds — bare message-dropping is what causes
   *    "AI forgot the setup I wrote 20 turns ago" hallucinations because the
   *    `[Context budget — N older messages dropped]` marker doesn't tell the
   *    model WHAT was dropped.
   *
   * 2. `microCompactTokens` is shifted to `autoCompactTokens - 2_000` so the
   *    cheap-but-lossy `micro_compact` path acts as a last-millisecond
   *    fallback rather than a primary tier. LLM-summary `auto_compact`
   *    handles the bulk of the pressure (with structured summary +
   *    file-state restore), which is far less hallucinogenic than tool_result
   *    truncation that also nukes prompt cache.
   *
   * Idempotent: same `model` short-circuits via `lastDerivedThresholdsModel`.
   * Switching models (e.g. 200K Claude → 1M Qwen3-Coder) re-derives.
   */
  private applyDynamicThresholdsForModel(model: string): void {
    if (this.userCustomizedThresholds) return
    const m = model.trim()
    if (!m) return
    if (this.lastDerivedThresholdsModel === m) return

    // Compact-planning window, not the raw effective window: 1M-tier
    // models are capped (default 400k) so auto-compact actually fires
    // long before attention degrades — see getCompactPlanningWindowTokens.
    const effectiveWindow = getCompactPlanningWindowTokens(m)
    const derived = deriveContextThresholdsFromOpenClaudeWindow(effectiveWindow)

    // upstream-external parity: collapse the snip tier into micro_compact.
    const microNearAuto = Math.max(
      derived.autoCompactTokens - 2_000,
      derived.errorTokens + 1,
    )
    derived.microCompactTokens = microNearAuto
    derived.historySnipTokens = microNearAuto

    this.thresholds = {
      ...this.thresholds,
      ...derived,
    }
    this.lastDerivedThresholdsModel = m
  }

  /**
   * After a successful model response, record server input token count and how many messages were in that request.
   */
  recordUsageAfterRequest(
    inputTokens: number,
    messageCountAtRequestStart: number,
    usageSnapshot?: Record<string, unknown>,
  ): void {
    if (
      typeof inputTokens === 'number' &&
      Number.isFinite(inputTokens) &&
      inputTokens > 0 &&
      typeof messageCountAtRequestStart === 'number' &&
      messageCountAtRequestStart >= 0
    ) {
      this.lastUsageInputTokens = inputTokens
      this.messageCountAtLastUsage = messageCountAtRequestStart
      this.lastUsageSnapshot = usageSnapshot ? { ...usageSnapshot } : undefined
    }
  }

  /** Call after compaction or transcript replacement — anchor is no longer valid. */
  clearUsageSnapshot(): void {
    this.lastUsageInputTokens = undefined
    this.messageCountAtLastUsage = undefined
    this.lastUsageSnapshot = undefined
  }

  /**
   * When `POLE_ANTHROPIC_COUNT_TOKENS=1`, {@link runQueryLoopPreModelSteps} may set this so the next
   * threshold evaluation uses server-side token count instead of heuristics alone.
   */
  setPrefetchedInputTokensForNextEvaluate(tokens: number | undefined): void {
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
      this.prefetchedInputTokens = tokens
    } else {
      this.prefetchedInputTokens = undefined
    }
  }

  private takePrefetchedInputTokens(): number | undefined {
    const v = this.prefetchedInputTokens
    this.prefetchedInputTokens = undefined
    return v
  }

  private estimateTotalInputTokens(
    apiMessages: Array<Record<string, unknown>>,
    systemPrompt: string,
    toolTokens: number,
  ): number {
    return this.estimateTotalInputTokensPeek(apiMessages, systemPrompt, toolTokens, true)
  }

  /**
   * Non-destructive variant of {@link estimateTotalInputTokens}. Used by
   * {@link runQueryLoopPreModelSteps} so the snip / collapse gates see the
   * same number that {@link evaluate} will see when it runs a few lines
   * later. Before this was exposed, pre-model used a raw heuristic
   * (`estimateConversationTokens + toolTokens`) which could disagree with
   * {@link evaluate} — causing snip to fire at the wrong threshold whenever
   * anchors or prefetched counts were available (audit Bug 4).
   *
   * When `consumePrefetch` is false the internal `prefetchedInputTokens`
   * slot is preserved for the upcoming {@link evaluate} call; when true it
   * is consumed in the same way {@link evaluate} does.
   */
  estimateTotalInputTokensPeek(
    apiMessages: Array<Record<string, unknown>>,
    systemPrompt: string,
    toolTokens: number,
    consumePrefetch = false,
  ): number {
    const apiTotal = consumePrefetch
      ? this.takePrefetchedInputTokens()
      : this.prefetchedInputTokens
    if (apiTotal != null && apiTotal > 0) {
      return apiTotal
    }
    const fromMsgAnchor = tokenCountWithEstimationFromMessageAnchors(apiMessages, toolTokens)
    if (fromMsgAnchor != null) {
      return fromMsgAnchor
    }
    if (
      this.lastUsageInputTokens == null ||
      this.messageCountAtLastUsage == null ||
      this.messageCountAtLastUsage > apiMessages.length
    ) {
      return estimateConversationTokens(apiMessages, systemPrompt) + toolTokens
    }
    const tail = apiMessages.slice(this.messageCountAtLastUsage)
    return this.lastUsageInputTokens + estimateMessagesOnlyTokens(tail) + toolTokens
  }

  evaluate(
    apiMessages: Array<Record<string, unknown>>,
    systemPrompt: string,
    toolTokens?: number,
    modelForUsagePercent?: string,
  ): {
    level: ContextLevel
    action:
      | 'none'
      | 'soft_clear'
      | 'history_snip'
      | 'micro_compact'
      | 'auto_compact'
      | 'block'
  } {
    // Realign thresholds against the active model's window before any tier
    // comparison so 1M / 256K models don't share the 200K-tuned fallback
    // defaults. No-op when the user has customized thresholds via Settings
    // or the constructor — see {@link applyDynamicThresholdsForModel}.
    if (modelForUsagePercent) {
      this.applyDynamicThresholdsForModel(modelForUsagePercent)
    }
    const tt = toolTokens || 0
    const willUseAnchoredEstimate =
      (this.prefetchedInputTokens != null && this.prefetchedInputTokens > 0) ||
      tokenCountWithEstimationFromMessageAnchors(apiMessages, tt) != null ||
      (
        this.lastUsageInputTokens != null &&
        this.messageCountAtLastUsage != null &&
        this.messageCountAtLastUsage <= apiMessages.length
      )
    const total = this.estimateTotalInputTokens(apiMessages, systemPrompt, tt)
    this.state.estimatedTokens = total
    this.state.breakdown = buildContextBreakdown({
      apiMessages,
      systemPrompt,
      toolTokens: tt,
      totalTokens: total,
      anchored: willUseAnchoredEstimate,
      usageSnapshot: this.lastUsageSnapshot,
    })
    const m = modelForUsagePercent?.trim()
    if (m) {
      this.state.usagePercentOfWindow = contextUsagePercentForModel(total, m)
    } else {
      this.state.usagePercentOfWindow = undefined
    }

    // Each tier check must guard against NaN — the existing public contract
    // (see `conversationDisplayState.test.ts > NaN thresholds cause all
    // checks to fail`) is that a NaN threshold disables that tier rather
    // than firing it spuriously. `total >= NaN` is already false, but for
    // tiers added post-launch (e.g. historySnipTokens) the tier triggers
    // when *all* sibling thresholds are NaN but the new one still has its
    // default — without an explicit `isFinite` gate the new tier silently
    // overrides the "all NaN ⇒ ok" invariant.
    const isFinite = Number.isFinite
    if (
      isFinite(this.thresholds.blockingTokens) &&
      total >= this.thresholds.blockingTokens
    ) {
      this.state.level = 'blocking'
      return { level: 'blocking', action: 'block' }
    }
    if (
      isFinite(this.thresholds.autoCompactTokens) &&
      total >= this.thresholds.autoCompactTokens &&
      this.shouldAttemptAutoCompact() &&
      !this.shouldSkipAutoCompactReentry(total)
    ) {
      this.state.level = 'auto_compact'
      return { level: 'auto_compact', action: 'auto_compact' }
    }
    if (
      isFinite(this.thresholds.microCompactTokens) &&
      total >= this.thresholds.microCompactTokens
    ) {
      this.state.level = 'micro_compact'
      return { level: 'micro_compact', action: 'micro_compact' }
    }
    // upstream §9.1 layer 1 — try history snip BEFORE micro_compact when in the
    // [historySnip, microCompact) band. Snip is zero-LLM-cost and frees
    // raw tokens by dropping the oldest messages, often enough to land
    // back below microCompact and avoid touching the prompt cache slot at
    // all. If snip can't free enough (handleContext re-evaluates after),
    // the next iteration will fall into micro_compact naturally.
    //
    // Disable when *any* of the surrounding tiers (errorTokens or
    // microCompactTokens) is NaN — both signal the user has explicitly
    // disabled the band, and firing snip in that hole would surprise them.
    if (
      isFinite(this.thresholds.historySnipTokens) &&
      isFinite(this.thresholds.errorTokens) &&
      isFinite(this.thresholds.microCompactTokens) &&
      total >= this.thresholds.historySnipTokens
    ) {
      this.state.level = 'history_snip'
      return { level: 'history_snip', action: 'history_snip' }
    }
    if (
      isFinite(this.thresholds.errorTokens) &&
      total >= this.thresholds.errorTokens
    ) {
      // Audit Bug 10: previously the `error` tier raised UI state but did
      // *nothing* to reclaim tokens — users saw "error" in the gauge yet
      // the app would keep sailing until micro_compact. Emit a `soft_clear`
      // action so `handleContext` can run a gentle idle-style tool_result
      // clear (keeps the 5 most recent groups intact).
      this.state.level = 'error'
      return { level: 'error', action: 'soft_clear' }
    }
    if (
      isFinite(this.thresholds.warningTokens) &&
      total >= this.thresholds.warningTokens
    ) {
      this.state.level = 'warning'
      return { level: 'warning', action: 'none' }
    }
    this.state.level = 'ok'
    return { level: 'ok', action: 'none' }
  }

  async handleContext(
    apiMessages: Array<Record<string, unknown>>,
    systemPrompt: string,
    options: CompactOptions,
    toolTokens?: number,
  ): Promise<{
    messages: Array<Record<string, unknown>>
    wasCompacted: boolean
  }> {
    const evaluated = this.evaluate(
      apiMessages,
      systemPrompt,
      toolTokens,
      options.model,
    )
    const action = maybeUpgradeForProactiveCompact(
      evaluated.action,
      options.proactiveCompact,
    )
    if (action !== evaluated.action) {
      this.state.level = levelForAction(action)
    }

    const hookCwd = getWorkspacePath() || process.cwd()
    const proactiveLogSuffix = options.proactiveCompact
      ? ` (${options.proactiveCompact.boundary}:${options.proactiveCompact.reason})`
      : ''
    const proactivePostDetail = (): Record<string, unknown> =>
      options.proactiveCompact
        ? { proactiveCompact: options.proactiveCompact }
        : {}

    const firePre = async () => {
      try {
        await runPreCompactHooks(
          {
            action,
            estimatedTokens: this.state.estimatedTokens,
            level: this.state.level,
          },
          hookCwd,
        )
      } catch (e) {
        console.warn('[ContextManager] PreCompact hooks:', e)
      }
    }

    const firePost = async (detail: Record<string, unknown>) => {
      try {
        await runPostCompactHooks(
          {
            ...detail,
            estimatedTokens: this.state.estimatedTokens,
            level: this.state.level,
          },
          hookCwd,
        )
      } catch (e) {
        console.warn('[ContextManager] PostCompact hooks:', e)
      }
    }

    if (action === 'none') {
      return { messages: apiMessages, wasCompacted: false }
    }

    // Renderer-facing "compaction is starting" signal. Gated to `auto_compact`
    // ONLY — the single tier that (a) runs a slow LLM summary worth a spinner,
    // and (b) ALWAYS returns `wasCompacted: true` (session-memory / LLM success
    // / fallback-micro), so the matching `onContextCompact` "done" reliably
    // resolves the toast. The cheap synchronous tiers (soft_clear / history_snip
    // / micro_compact) complete in well under a frame and can legitimately
    // return `wasCompacted: false` (zero-credit soft_clear, snippedCount===0
    // history_snip) — firing a start for them would either flash a pointless
    // spinner or, worse, leave it stuck because no "done" follows.
    if (action === 'auto_compact') {
      try {
        options.onCompactStart?.({
          level: this.state.level,
          action,
          estimatedTokens: this.state.estimatedTokens,
        })
      } catch (e) {
        console.warn('[ContextManager] onCompactStart threw:', e)
      }
    }

    await firePre()

    if (action === 'soft_clear') {
      // Gentle tier — clear string-body tool_result content in older
      // groups (keep the 8 most recent intact). Does NOT truncate tail,
      // does NOT call the LLM. Cheap enough to run on every pre-model
      // pass when we're in the `error` band.
      console.log('[ContextManager] Performing soft clear (error tier)')
      const estBefore = this.state.estimatedTokens
      const tt = toolTokens || 0
      const cleared = clearCompletedToolResultsExceptRecent(apiMessages, 8)
      this.evaluate(cleared, systemPrompt, tt, options.model)
      const credit = Math.max(0, estBefore - this.state.estimatedTokens)
      postCompactCleanup('micro', {
        dedupeKey: compactDedupeKey('soft_clear', apiMessages.length, estBefore),
        outputBudgetCeilingExtension: credit > 0 ? credit : undefined,
      })
      emitContextTelemetryEvent({
        action: 'soft_clear',
        level: this.state.level,
        estimatedTokensBefore: estBefore,
        estimatedTokensAfter: this.state.estimatedTokens,
        reclaimed: credit,
        conversationId: getAgentContext()?.streamConversationId,
        agentId: getAgentContext()?.agentId,
        model: options.model,
      })
      await firePost({ kind: 'soft_clear', ...proactivePostDetail() })
      // P3.1 — record EVERY attempt (even zero-credit) so the diminishing-
      // returns gate sees the no-op too. A streak of zero-credit soft_clear
      // calls is exactly the signal we want to detect.
      this.logCompactAttempt(estBefore)
      // Return `wasCompacted: true` only when the clear actually reclaimed
      // tokens; otherwise the caller shouldn't re-enter collapsed-history
      // flow (idle clear already ran this turn).
      return { messages: cleared, wasCompacted: credit > 0 }
    }

    if (action === 'history_snip') {
      // upstream §9.1 layer 1 — drop oldest messages to land below microCompact.
      // Target token total: a margin (SNIP_TARGET_MARGIN_BELOW_AUTO ≈ 6k)
      // *below* historySnipTokens so we don't immediately bounce back into
      // the snip band on the next iteration. Min messages kept = 4 (head
      // + 3 recent) — same as preModel's preventive snip.
      console.log(`[ContextManager] Performing history-snip${proactiveLogSuffix}`)
      const estBefore = this.state.estimatedTokens
      const msgCountBefore = apiMessages.length
      const tt = toolTokens || 0
      const target = Math.max(
        this.thresholds.warningTokens,
        this.thresholds.historySnipTokens - SNIP_TARGET_MARGIN_BELOW_AUTO,
      )
      const { messages: snipped, snippedCount } = snipOldestMessagesForBudget(
        apiMessages,
        {
          systemPrompt,
          toolDefsTokens: tt,
          targetTotalTokens: target,
          minMessagesToKeep: 4,
          protectedToolUseIds: options.protectedToolUseIds,
        },
      )
      // No messages were eligible for trimming (min cap hit) — treat as a
      // no-op so the caller doesn't enter post-compact warmup paths.
      if (snippedCount === 0) {
        await firePost({ kind: 'history_snip_noop' })
        return { messages: apiMessages, wasCompacted: false }
      }
      this.evaluate(snipped, systemPrompt, tt, options.model)
      const credit = Math.max(0, estBefore - this.state.estimatedTokens)
      postCompactCleanup('micro', {
        dedupeKey: compactDedupeKey('history_snip', msgCountBefore, estBefore),
        outputBudgetCeilingExtension: credit > 0 ? credit : undefined,
      })
      emitContextTelemetryEvent({
        action: 'history_snip',
        level: this.state.level,
        estimatedTokensBefore: estBefore,
        estimatedTokensAfter: this.state.estimatedTokens,
        reclaimed: credit,
        conversationId: getAgentContext()?.streamConversationId,
        agentId: getAgentContext()?.agentId,
        model: options.model,
      })
      await firePost({
        kind: 'history_snip',
        snippedCount,
        targetTotalTokens: target,
        ...proactivePostDetail(),
      })
      // Audit fix A-1 — make the snip visible to the model. Without this
      // marker the model treats dropped older turns as "still there"
      // and may quote / re-use facts that no longer exist in context.
      //
      // Self-audit note (2026-05) on placement: this marker sits at
      // index 0 of the returned messages. Downstream, `streamHandler`
      // calls `prependUserContext` which prepends a `<system-reminder
      // type="user-meta-context">` message at index 0 — putting the
      // userMeta + snipMarker as TWO adjacent `_convertedFromSystem`
      // user messages. `mergeConsecutiveUserMessages` then collapses
      // them into one user message whose body contains TWO sibling
      // `<system-reminder>` envelopes joined by `\n\n` (NOT nested
      // envelopes — `mergeUserContent` joins string content with
      // `\n\n`, it does not embed one body inside the other). This is
      // the exact same shape `autoCompact` has shipped with for the
      // `compactSummary` message at `compact.ts:801-820`, and the
      // model parses sibling tags correctly. Keeping the marker at
      // head ensures the model reads "context was trimmed" before any
      // surviving older content. Moving the marker further into the
      // array would just shift the merge target by one position.
      const snipMarker = buildContextCompactionMarker('history_snip', {
        droppedCount: snippedCount,
        transcriptPath: options.transcriptPath,
      })
      // P3.1 — record the snip attempt for diminishing-returns tracking.
      this.logCompactAttempt(estBefore)
      return { messages: [snipMarker, ...snipped], wasCompacted: true }
    }

    if (action === 'micro_compact') {
      console.log(`[ContextManager] Performing micro-compact${proactiveLogSuffix}`)
      const estBefore = this.state.estimatedTokens
      const msgCountBefore = apiMessages.length
      const tt = toolTokens || 0
      const budgeted = clampToolResultsInMessages(apiMessages)
      const compacted = microCompact(budgeted, 5, options.protectedToolUseIds)
      this.evaluate(compacted, systemPrompt, tt, options.model)
      const credit = Math.max(0, estBefore - this.state.estimatedTokens)
      postCompactCleanup('micro', {
        dedupeKey: compactDedupeKey('micro', msgCountBefore, estBefore),
        outputBudgetCeilingExtension: credit > 0 ? credit : undefined,
      })
      signalMicroCompactForPromptCache(getAgentContext()?.streamConversationId)
      emitContextTelemetryEvent({
        action: 'micro_compact',
        level: this.state.level,
        estimatedTokensBefore: estBefore,
        estimatedTokensAfter: this.state.estimatedTokens,
        reclaimed: credit,
        conversationId: getAgentContext()?.streamConversationId,
        agentId: getAgentContext()?.agentId,
        model: options.model,
      })
      await firePost({ kind: 'micro_compact', ...proactivePostDetail() })
      // P3.1 — record the micro_compact attempt regardless of credit;
      // a zero-credit pass still counts toward diminishing-returns.
      this.logCompactAttempt(estBefore)
      // Audit fix A-1 — surface the truncation. Only emit when the pass
      // actually reclaimed tokens; a zero-credit micro_compact left the
      // transcript byte-identical and would only add noise.
      if (credit > 0) {
        const microMarker = buildContextCompactionMarker('micro_compact', {
          transcriptPath: options.transcriptPath,
        })
        return { messages: [microMarker, ...compacted], wasCompacted: true }
      }
      return { messages: compacted, wasCompacted: true }
    }

    if (action === 'auto_compact') {
      const estBefore = this.state.estimatedTokens
      const msgCountBefore = apiMessages.length
      const tt = toolTokens || 0

      const smResult = await trySessionMemoryCompact({
        conversationId: getAgentContext()?.streamConversationId,
        messages: apiMessages,
        systemPrompt,
        thresholds: this.thresholds,
        toolDefsTokens: tt,
        transcriptPath: options.transcriptPath,
      })
      if (smResult?.wasCompacted) {
        console.log('[ContextManager] Session-memory compact succeeded (zero API cost)')
        this.state.compactCount++
        this.state.consecutiveCompactFailures = 0
        this.state.lastCompactSummary = smResult.sessionMemoryContent
        // Codex-parity prefix rebuild (2026-07): the SM path skips the full
        // post-compact attachment matrix, but the ACTIVE skill's workflow
        // text must survive EVERY compact tier that replaces history with a
        // summary. Splice the verbatim rebuild right after the boundary
        // marker — same position the LLM path gives its skill attachment.
        // Peek-only: registry metadata stays intact for pre-model reinjection.
        if (options.activeSkillName) {
          const rebuild = buildActiveSkillRebuildAttachment(
            options.agentId ?? getAgentContext()?.agentId,
            options.activeSkillName,
          )
          if (rebuild) {
            smResult.messages = [
              smResult.messages[0],
              { ...rebuild } as Record<string, unknown>,
              ...smResult.messages.slice(1),
            ]
          }
        }
        this.evaluate(smResult.messages, systemPrompt, tt, options.model)
        // 2026-07 reentry guard — record the post-compact size so the next
        // evaluate() can skip a pointless re-summarize of this summary.
        this.lastAutoCompactPostTokens = this.state.estimatedTokens
        const credit = Math.max(0, estBefore - this.state.estimatedTokens)
        postCompactCleanup('auto', {
          dedupeKey: compactDedupeKey('sm_compact', msgCountBefore, estBefore),
          outputBudgetCeilingExtension: credit > 0 ? credit : undefined,
        })
        emitContextTelemetryEvent({
          action: 'session_memory_compact',
          level: this.state.level,
          estimatedTokensBefore: estBefore,
          estimatedTokensAfter: this.state.estimatedTokens,
          reclaimed: credit,
          conversationId: getAgentContext()?.streamConversationId,
          agentId: getAgentContext()?.agentId,
          model: options.model,
        })
        await firePost({
          kind: 'session_memory_compact',
          summary: smResult.sessionMemoryContent,
          ...proactivePostDetail(),
        })
        // P3.1 — record the session-memory compact attempt.
        this.logCompactAttempt(estBefore)
        return { messages: smResult.messages, wasCompacted: true }
      }

      try {
        console.log(`[ContextManager] Performing auto-compact via LLM${proactiveLogSuffix}`)
        const result = await autoCompact({
          ...options,
          llmQuerySource: options.llmQuerySource ?? 'marble_origami',
        })
        this.state.compactCount++
        this.state.consecutiveCompactFailures = 0
        this.state.lastCompactSummary = result.summary
        this.evaluate(result.messages, systemPrompt, tt, options.model)
        // 2026-07 reentry guard — see the session-memory branch above.
        this.lastAutoCompactPostTokens = this.state.estimatedTokens
        const credit = Math.max(0, estBefore - this.state.estimatedTokens)
        postCompactCleanup('auto', {
          dedupeKey: compactDedupeKey('auto', msgCountBefore, estBefore),
          outputBudgetCeilingExtension: credit > 0 ? credit : undefined,
        })
        emitContextTelemetryEvent({
          action: 'auto_compact',
          level: this.state.level,
          estimatedTokensBefore: estBefore,
          estimatedTokensAfter: this.state.estimatedTokens,
          reclaimed: credit,
          conversationId: getAgentContext()?.streamConversationId,
          agentId: getAgentContext()?.agentId,
          model: options.model,
        })
        await firePost({
          kind: 'auto_compact',
          summary: result.summary,
          ...proactivePostDetail(),
        })
        // P3.1 — record the auto_compact attempt.
        this.logCompactAttempt(estBefore)
        return { messages: result.messages, wasCompacted: true }
      } catch (error) {
        console.error('[ContextManager] Auto-compact failed:', error)
        this.state.consecutiveCompactFailures++
        const compacted = microCompact(
          clampToolResultsInMessages(apiMessages),
          5,
          options.protectedToolUseIds,
        )
        this.evaluate(compacted, systemPrompt, tt, options.model)
        const credit = Math.max(0, estBefore - this.state.estimatedTokens)
        postCompactCleanup('micro', {
          dedupeKey: compactDedupeKey('auto_fallback_micro', msgCountBefore, estBefore),
          outputBudgetCeilingExtension: credit > 0 ? credit : undefined,
        })
        signalMicroCompactForPromptCache(getAgentContext()?.streamConversationId)
        emitContextTelemetryEvent({
          action: 'auto_compact_fallback_micro',
          level: this.state.level,
          estimatedTokensBefore: estBefore,
          estimatedTokensAfter: this.state.estimatedTokens,
          reclaimed: credit,
          conversationId: getAgentContext()?.streamConversationId,
          agentId: getAgentContext()?.agentId,
          model: options.model,
        })
        await firePost({
          kind: 'auto_compact_fallback_micro',
          ...proactivePostDetail(),
        })
        // P3.1 — record the fallback micro_compact attempt.
        this.logCompactAttempt(estBefore)
        return {
          messages: compacted,
          wasCompacted: true,
        }
      }
    }

    if (action === 'block') {
      console.warn('[ContextManager] Blocking threshold, forcing micro-compact')
      const estBefore = this.state.estimatedTokens
      const msgCountBefore = apiMessages.length
      const tt = toolTokens || 0
      // Keep at least 3 recent iterations so the model still sees intermediate
      // tool results — dropping to 1 caused repeated-action loops where the
      // model couldn't see prior work and re-executed the same steps.
      const compacted = microCompact(
        clampToolResultsInMessages(apiMessages),
        3,
        options.protectedToolUseIds,
      )
      this.evaluate(compacted, systemPrompt, tt, options.model)
      const credit = Math.max(0, estBefore - this.state.estimatedTokens)
      postCompactCleanup('micro', {
        dedupeKey: compactDedupeKey('block_micro', msgCountBefore, estBefore),
        outputBudgetCeilingExtension: credit > 0 ? credit : undefined,
      })
      signalMicroCompactForPromptCache(getAgentContext()?.streamConversationId)
      emitContextTelemetryEvent({
        action: 'block_micro',
        level: this.state.level,
        estimatedTokensBefore: estBefore,
        estimatedTokensAfter: this.state.estimatedTokens,
        reclaimed: credit,
        conversationId: getAgentContext()?.streamConversationId,
        agentId: getAgentContext()?.agentId,
        model: options.model,
      })
      await firePost({ kind: 'block_micro', ...proactivePostDetail() })
      // P3.1 — record the block_micro attempt.
      this.logCompactAttempt(estBefore)

      // 2026-06 destructive 50×120 stress fix — blocking-tier livelock.
      //
      // `evaluate` checks blockingTokens FIRST, so once the transcript's
      // un-micro-compactable bulk (thinking blocks, tool_use inputs,
      // protected Read/Glob results, preserved summary chain) pushes the
      // estimate past blockingTokens, the auto_compact tier becomes
      // permanently unreachable: every subsequent pass lands here, micro
      // reclaims ~0, and the context grows without bound (observed: 4.5M
      // tokens after 50 rounds). When the forced micro pass leaves us at
      // or above autoCompactTokens, escalate to the real LLM auto-compact
      // — the only pass that can actually fold that bulk.
      if (
        this.state.estimatedTokens >= this.thresholds.autoCompactTokens &&
        this.shouldAttemptAutoCompact()
      ) {
        try {
          console.warn(
            '[ContextManager] block_micro reclaimed too little — escalating to auto-compact',
          )
          const result = await autoCompact({
            ...options,
            messages: compacted,
            llmQuerySource: options.llmQuerySource ?? 'compact',
          })
          this.state.compactCount++
          this.state.consecutiveCompactFailures = 0
          this.state.lastCompactSummary = result.summary
          this.evaluate(result.messages, systemPrompt, tt, options.model)
          // 2026-07 reentry guard — record here too: a block-tier
          // escalation that STILL lands above autoCompactTokens must not
          // be followed by auto-tier re-summarize attempts on subsequent
          // evaluate() calls (the escalation path itself stays ungated).
          this.lastAutoCompactPostTokens = this.state.estimatedTokens
          const escalationCredit = Math.max(
            0,
            estBefore - this.state.estimatedTokens,
          )
          postCompactCleanup('auto', {
            dedupeKey: compactDedupeKey('block_auto', msgCountBefore, estBefore),
            outputBudgetCeilingExtension:
              escalationCredit > 0 ? escalationCredit : undefined,
          })
          emitContextTelemetryEvent({
            action: 'block_escalated_auto',
            level: this.state.level,
            estimatedTokensBefore: estBefore,
            estimatedTokensAfter: this.state.estimatedTokens,
            reclaimed: escalationCredit,
            conversationId: getAgentContext()?.streamConversationId,
            agentId: getAgentContext()?.agentId,
            model: options.model,
          })
          await firePost({
            kind: 'block_escalated_auto',
            summary: result.summary,
            ...proactivePostDetail(),
          })
          this.logCompactAttempt(estBefore)
          return { messages: result.messages, wasCompacted: true }
        } catch (error) {
          console.error('[ContextManager] Block-tier auto-compact escalation failed:', error)
          this.state.consecutiveCompactFailures++
          // Fall through to the micro result below — same degradation the
          // auto tier uses when the LLM call fails.
        }
      }

      return {
        messages: compacted,
        wasCompacted: true,
      }
    }

    return { messages: apiMessages, wasCompacted: false }
  }

  private shouldAttemptAutoCompact(): boolean {
    return this.state.consecutiveCompactFailures < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  }

  /**
   * 2026-07 reentry guard — true when the previous successful auto-tier
   * compact ALREADY left the transcript at/above `autoCompactTokens` and
   * the conversation has not grown meaningfully since. Re-summarizing an
   * already-summarized transcript reclaims ~nothing; each pass "succeeds",
   * so neither `consecutiveCompactFailures` nor the failure breaker ever
   * fires — pre-guard, the loop paid one LLM summary call per iteration
   * for zero reclaim. cc-haha parity: `shouldSkipRecompactionReentry`
   * (`services/compact/autoCompact.ts`), plus a growth escape it lacks —
   * once the transcript grows past the recorded post-compact size by
   * {@link AUTO_COMPACT_REENTRY_GROWTH_RATIO}, there is genuinely new
   * material worth folding and the auto tier re-arms.
   *
   * Consulted ONLY by the `evaluate()` auto_compact tier. The blocking
   * tier's auto-compact escalation stays ungated — it is the livelock
   * escape hatch of last resort (2026-06 destructive 50×120 stress fix)
   * and must keep the ability to fold un-micro-compactable bulk.
   */
  private shouldSkipAutoCompactReentry(total: number): boolean {
    const last = this.lastAutoCompactPostTokens
    if (last === undefined) return false
    if (!Number.isFinite(this.thresholds.autoCompactTokens)) return false
    if (last < this.thresholds.autoCompactTokens) return false
    return total < last * AUTO_COMPACT_REENTRY_GROWTH_RATIO
  }

  getState(): ContextState {
    return { ...this.state }
  }

  getThresholds(): ContextThresholds {
    return { ...this.thresholds }
  }

  // ── P3.1 — Compact-history surface ─────────────────────────────────
  //
  // Phase-aware compact and the post-tool context-manage step consult
  // `isCompactDiminishingGate()` before running another compact pass.
  // When it returns true the gate skips the compact (upstream parity:
  // their `autoCompact.ts` would silently return wasCompacted:false in
  // the same shape).
  //
  // Population: `handleContext` calls `logCompactAttempt(estBefore)` at
  // every successful compact return point (history_snip, microcompact,
  // session_memory_compact, auto_compact, auto_compact_fallback_micro,
  // block_micro, and the credit-bearing soft_clear path). The helper
  // captures `estBefore` against the post-compact `state.estimatedTokens`
  // so the rolling window stays accurate.

  /**
   * Append a new compact attempt to the rolling history. Public API for
   * tests / external instrumentation. Production code path uses the
   * private `logCompactAttempt` wrapper below.
   */
  recordCompactAttempt(attempt: CompactAttempt): void {
    this.compactHistory = recordCompactAttempt(this.compactHistory, attempt)
  }

  /**
   * Internal sugar: record a compact attempt using `estBefore` (snapshot
   * captured before the compact ran) against the current post-compact
   * `state.estimatedTokens`. Called from inside `handleContext`'s
   * success branches.
   */
  private logCompactAttempt(estBefore: number): void {
    this.recordCompactAttempt({
      preTokens: estBefore,
      postTokens: this.state.estimatedTokens,
      ranAt: Date.now(),
    })
  }

  /** Read-only view for telemetry / tests. */
  getCompactHistory(): CompactHistory {
    return this.compactHistory
  }

  /**
   * Returns true when the rolling compact history says additional
   * compact attempts won't free meaningful tokens. Pure read from the
   * helper module — no state mutation.
   */
  isCompactDiminishingGate(): boolean {
    return isCompactDiminishing(this.compactHistory)
  }

  updateThresholds(thresholds: Partial<ContextThresholds>): void {
    // Explicit user/Settings override — opt out of dynamic-from-model derivation
    // from this point on. The user has signaled they want the values they wrote.
    this.userCustomizedThresholds = true
    const next = { ...this.thresholds, ...thresholds }
    // Validate all numeric fields — NaN or non-numbers silently disable context management
    const numericKeys = Object.keys(DEFAULT_THRESHOLDS) as Array<keyof ContextThresholds>
    for (const key of numericKeys) {
      if (typeof next[key] !== 'number' || !Number.isFinite(next[key])) {
        next[key] = DEFAULT_THRESHOLDS[key]
      }
    }
    if (next.anchorBudgetChars < 500) {
      next.anchorBudgetChars = DEFAULT_THRESHOLDS.anchorBudgetChars
    }
    // Invariant: errorTokens < historySnipTokens < microCompactTokens.
    // If the caller supplied a custom errorTokens / microCompactTokens but
    // forgot historySnipTokens (typical for legacy Settings payloads),
    // re-derive it as the midpoint so the new tier still fires meaningfully.
    if (
      next.historySnipTokens <= next.errorTokens ||
      next.historySnipTokens >= next.microCompactTokens
    ) {
      const midpoint = Math.round((next.errorTokens + next.microCompactTokens) / 2)
      next.historySnipTokens = midpoint
    }
    this.thresholds = next
  }

  reset(): void {
    this.clearUsageSnapshot()
    this.prefetchedInputTokens = undefined
    this.state = {
      estimatedTokens: 0,
      level: 'ok',
      compactCount: 0,
      consecutiveCompactFailures: 0,
      usagePercentOfWindow: undefined,
    }
  }
}

export const contextManager = new ContextManager()
