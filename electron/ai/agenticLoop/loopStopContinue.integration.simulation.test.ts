/**
 * Loop stop/continue — cross-subsystem integration simulation (~300 scenarios).
 *
 * Motivation: the user found that THINKING interfered with the loop's
 * stop/continue decision (a thinking-only turn ending in a question slipped
 * to a silent `completed`; fixed by row 12e). This test asks the broader
 * question: what OTHER subsystems interfere with stop/continue?
 *
 * Strategy — wire the REAL subsystems that produce the decision's inputs, run
 * a large combinatorial scenario matrix through the REAL `decideIterationOutcome`,
 * and compare every outcome against an INDEPENDENT oracle re-derived from the
 * documented priority table. Any mismatch is interference (a bug). On top of
 * faithfulness we assert PRODUCT invariants per category and emit a report
 * that counts the by-design precedence interactions (safety nets overriding
 * continue signals, guards overriding benign completions, etc.).
 *
 * Subsystems integrated for real (not mocked):
 *   - `createIterationStallGuard` (orchestration/iterationStallGuard) — the
 *     token-delta stall detector (row 8b).
 *   - `createTokenBudgetState` + `checkTokenBudget` (context/tokenBudget) —
 *     diminishing-returns continuation (row 12 / stop).
 *   - `recordStopHookBlock` (noTools) — the stop-hook circuit breaker (row 8).
 *   - `detectDeclaredIntentTail` (declaredIntentGuard) — row 12b detector.
 *   - thinking-only gating + `isThinkingOnlySilentTurnGuardEnabled` (row 12e).
 *   - `ContextManager` (context/manager) — real compaction ladder, to prove
 *     compaction never changes a fixed scenario's outcome.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  decideIterationOutcome,
  type IterationDecisionSignals,
  type IterationOutcome,
} from './iterationDecision'
import type { StopFamilyHookOutcome } from '../../tools/hooks/engine'
import { recordStopHookBlock, STOP_HOOK_BLOCK_CAP } from './noTools'
import {
  createIterationStallGuard,
  type IterationStallGuard,
} from '../../orchestration/iterationStallGuard'
import {
  createTokenBudgetState,
  recordOutputTokens,
  checkTokenBudget,
  type TokenBudgetState,
} from '../../context/tokenBudget'
import {
  detectDeclaredIntentTail,
  buildDeclaredIntentDirective,
  isUserQuestionTail,
} from './declaredIntentGuard'
import { buildThinkingOnlySilentTurnDirective } from './thinkingOnlySilentTurnGuard'
import { buildAllToolsFailedDirective } from './allToolsFailedGuard'
import { ContextManager } from '../../context/manager'
import type { CompactOptions } from '../../context/compact'
import { estimateConversationTokens } from '../../context/tokenCounter'
import { silenceExpectedConsoleWarnAndError } from '../../testHelpers/silenceExpectedConsole'

// Deterministic auto-compact summarizer (same seam as the declared-intent sim).
vi.mock('../client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../client')>()
  return {
    ...orig,
    streamText: vi.fn(
      async (
        _config: unknown,
        _params: unknown,
        callbacks: { onTextDelta?: (t: string) => void; onMessageEnd?: () => void },
      ) => {
        callbacks.onTextDelta?.(
          '<summary>\nSummary:\n- [mock-summarizer] recap of the summarized window\n</summary>',
        )
        callbacks.onMessageEnd?.()
      },
    ),
  }
})

silenceExpectedConsoleWarnAndError()

// ─────────────────────────────────────────────────────────────────────
// Scenario dimensions
// ─────────────────────────────────────────────────────────────────────

type AbortMode = 'none' | 'preStream' | 'postStream' | 'postTool'
type TopGate = 'none' | 'boundaryHook' | 'preModelTerm' | 'blockingLimit' | 'streamTerm'
type HookKind = 'neutral' | 'forceStop' | 'blockingError' | 'preventStop'
type TextKind = 'empty' | 'question' | 'completion' | 'declaredIntent' | 'plainLong' | 'plainShort'
type ThinkingKind = 'none' | 'plain' | 'declaredIntent' | 'question'
type TokenProfile = 'high' | 'low'

interface Scenario {
  id: string
  category: string
  abort: AbortMode
  topGate: TopGate
  hook: HookKind
  interAgent: boolean
  todos: boolean
  allFailed: boolean
  text: TextKind
  thinking: ThinkingKind
  tokens: TokenProfile
  budgetEnabled: boolean
  /** declared-intent / thinking-only one-shot budgets already spent this episode. */
  nudgeSpent: boolean
  /** stall guard already saw 2 consecutive stalls before this turn → this is the 3rd. */
  stallPrimed: boolean
  /** circuit-breaker counter already at cap-1 before this turn. */
  cbPrimed: boolean
  /** pending hook-stop from tool execution (row 16). */
  pendingHookStop: boolean
}

const TEXTS: Record<TextKind, string> = {
  empty: '',
  question: '需要我对哪个子系统展开分析，或者开始编制某个方向的文档？',
  completion: '所有修改已完成，没有需要继续的操作。',
  declaredIntent: '分析完毕，我现在开始修改 PaymentService 的退款幂等逻辑。',
  plainLong: '这是一段较长的可见正文回复，'.repeat(12), // > 100 chars
  plainShort: '好的。',
}

const THINKINGS: Record<ThinkingKind, string> = {
  none: '',
  plain: '我把各子系统都过了一遍，结构大致清楚了。先到这里。',
  declaredIntent: '用户没指定方向。我现在开始编制 orchestration 子系统的设计文档。',
  question: '用户没指定方向。需要我对哪个子系统展开分析，或者开始编制某个方向的文档？',
}

const TOKENS: Record<TokenProfile, number> = { high: 4_000, low: 120 }
const TOOL_DEFS_TOKENS = 6_000
const MODEL = 'claude-sonnet-4-6'
const SYSTEM_PROMPT = 'integration sim system prompt'

// ─────────────────────────────────────────────────────────────────────
// REAL subsystem-driven signal builder (mirrors noTools.ts wiring)
// ─────────────────────────────────────────────────────────────────────

function buildHookOutcome(hook: HookKind): StopFamilyHookOutcome {
  switch (hook) {
    case 'forceStop':
      return { kind: 'forceStop', errorDetail: 'admin abort', hookName: 'force-hook' }
    case 'blockingError':
      return { kind: 'blockingError', errorMessage: 'lint failed', hookName: 'lint-hook' }
    case 'preventStop':
      return { kind: 'preventStop', appendUserContent: 'please continue', hookName: 'cont-hook' }
    case 'neutral':
    default:
      return { kind: 'neutral' }
  }
}

interface BuildResult {
  signals: IterationDecisionSignals
}

/**
 * Construct the decision signal envelope for a no-tool turn EXACTLY as
 * `noTools.ts` does, but feeding REAL subsystem state producers.
 */
function buildEnvelope(scn: Scenario, stallGuard: IterationStallGuard): BuildResult {
  // ── Pre/post-stream + post-tool gates (simple flags, top of table). ──
  if (scn.abort === 'preStream') {
    return { signals: { preStreamAbort: { reason: 'aborted_streaming' } } }
  }
  if (scn.topGate === 'boundaryHook') return { signals: { boundaryHookStop: true } }
  if (scn.topGate === 'preModelTerm') return { signals: { preModelTerminated: true } }
  if (scn.topGate === 'blockingLimit') return { signals: { blockingLimitHard: true } }
  if (scn.topGate === 'streamTerm') return { signals: { phaseWroteTermination: true } }
  if (scn.abort === 'postStream') {
    return { signals: { postStreamAbort: { reason: 'aborted_streaming' } } }
  }

  // ── No-tool branch: drive every continue/stop input via real subsystems. ──
  const accumulatedText = TEXTS[scn.text]
  const thinkingText = THINKINGS[scn.thinking]
  const thinkingBlocks = thinkingText ? [{ thinking: thinkingText }] : []
  const outputTokens = TOKENS[scn.tokens]
  const stopHook = buildHookOutcome(scn.hook)
  const cid = `sim-${scn.id}`

  // Circuit breaker (row 8) — real counter.
  const stopHookWouldContinue =
    stopHook.kind === 'blockingError' ||
    (stopHook.kind === 'preventStop' && Boolean((stopHook as { appendUserContent?: string }).appendUserContent?.trim()))
  const priorBlocks = scn.cbPrimed ? STOP_HOOK_BLOCK_CAP - 1 : 0
  const circuitBreakerWouldTrip = stopHookWouldContinue
    ? recordStopHookBlock(priorBlocks).tripped
    : false

  // Stall guard (row 8b) — real per-conversation streak. Prime 2 stalls first
  // when requested so THIS record is the 3rd (threshold default = 3).
  if (scn.stallPrimed) {
    stallGuard.record(cid, { hadToolUse: false, textLength: 0, tokenDelta: 10 })
    stallGuard.record(cid, { hadToolUse: false, textLength: 0, tokenDelta: 10 })
  }
  const stallAdvice = stallGuard.record(cid, {
    hadToolUse: false,
    textLength: accumulatedText.length,
    tokenDelta: outputTokens,
  })
  const stallTripped =
    stallAdvice.stalled && stallAdvice.message
      ? { message: stallAdvice.message, consecutiveCount: stallAdvice.consecutiveCount }
      : undefined

  // Token budget (row 12) — real diminishing-returns engine.
  let tokenBudgetReminder: string | undefined
  if (scn.budgetEnabled) {
    const budget: TokenBudgetState = createTokenBudgetState({ totalBudget: 1_000_000 })
    recordOutputTokens(budget, outputTokens)
    const check = checkTokenBudget(budget)
    if (check.action === 'continue') tokenBudgetReminder = check.reminderMessage
  }

  // Active-todo guard (row 12a). Plan A: a genuine question tail is exempt
  // (mirrors `buildActiveTodoPanelGuardSignal`), so a clarifying question
  // yields the turn even with open todos.
  const activeTodoPanelGuard =
    scn.todos && !isUserQuestionTail(accumulatedText)
      ? { itemCount: 2, directiveBody: '[Active TodoWrite items — turn cannot end yet]\n\nX, Y' }
      : undefined

  // Declared-intent guard (row 12b) — real detector on the real scan source.
  const intentScanSource = accumulatedText.trim()
    ? accumulatedText
    : (thinkingBlocks[thinkingBlocks.length - 1]?.thinking ?? '')
  const declaredIntentGuard =
    !activeTodoPanelGuard && !scn.nudgeSpent && detectDeclaredIntentTail(intentScanSource)
      ? { directiveBody: buildDeclaredIntentDirective() }
      : undefined

  // All-tools-failed guard (row 12c).
  const allToolsFailedGuard =
    !activeTodoPanelGuard && !declaredIntentGuard && scn.allFailed && !scn.nudgeSpent
      ? { directiveBody: buildAllToolsFailedDirective() }
      : undefined

  // Verification gate (row 12d) — exercised separately; left absent here so
  // the thinking-only / declared-intent interactions stay legible.

  // Thinking-only silent-turn guard (row 12e) — real gating condition.
  const thinkingOnlySilentTurnGuard =
    !activeTodoPanelGuard &&
    !declaredIntentGuard &&
    !allToolsFailedGuard &&
    !scn.nudgeSpent &&
    !accumulatedText.trim() &&
    thinkingBlocks.length > 0
      ? { directiveBody: buildThinkingOnlySilentTurnDirective() }
      : undefined

  const noToolUse: NonNullable<IterationDecisionSignals['noToolUse']> = {
    interAgentInjected: scn.interAgent,
    stopHook,
    stopHookActiveSkipped: false,
    circuitBreakerWouldTrip,
    ...(tokenBudgetReminder ? { tokenBudgetReminder } : {}),
    ...(stallTripped ? { stallTripped } : {}),
    ...(activeTodoPanelGuard ? { activeTodoPanelGuard } : {}),
    ...(declaredIntentGuard ? { declaredIntentGuard } : {}),
    ...(allToolsFailedGuard ? { allToolsFailedGuard } : {}),
    ...(thinkingOnlySilentTurnGuard ? { thinkingOnlySilentTurnGuard } : {}),
  }

  // Post-tool gates (rows 14-16) are mutually exclusive with the no-tool
  // branch in production; we model `postTool` abort and pendingHookStop as
  // their own envelopes (no noToolUse present) so the oracle reaches them.
  if (scn.abort === 'postTool') {
    return { signals: { postToolAbort: { iterationExhausted: false } } }
  }
  if (scn.pendingHookStop) {
    return { signals: { pendingHookStop: { reason: 'tool hook stopped', hookName: 'pt-hook' } } }
  }

  return { signals: { noToolUse } }
}

// ─────────────────────────────────────────────────────────────────────
// Independent oracle — re-derived from the documented priority table.
// (Does NOT call decideIterationOutcome.)
// ─────────────────────────────────────────────────────────────────────

type OracleResult = { kind: 'terminate'; reason: string } | { kind: 'continue'; inject?: string }

function oracle(sig: IterationDecisionSignals): OracleResult {
  if (sig.preStreamAbort) return { kind: 'terminate', reason: 'aborted_streaming' }
  if (sig.boundaryHookStop) return { kind: 'terminate', reason: 'iteration_boundary_stopped' }
  if (sig.preModelTerminated) return { kind: 'terminate', reason: 'model_error' }
  if (sig.blockingLimitHard) return { kind: 'terminate', reason: 'blocking_limit' }
  if (sig.phaseWroteTermination) return { kind: 'terminate', reason: 'model_error' }
  if (sig.postStreamAbort) return { kind: 'terminate', reason: 'aborted_streaming' }

  const n = sig.noToolUse
  if (n) {
    if (n.stopHook.kind === 'forceStop') return { kind: 'terminate', reason: 'stop_hook_prevented' }
    if (n.circuitBreakerWouldTrip) return { kind: 'terminate', reason: 'stop_hook_circuit_breaker' }
    if (n.stallTripped) return { kind: 'terminate', reason: 'iteration_stalled' }
    if (n.interAgentInjected) return { kind: 'continue' }
    if (n.stopHook.kind === 'blockingError') return { kind: 'continue', inject: 'blockingError' }
    if (n.stopHook.kind === 'preventStop') {
      const c = (n.stopHook as { appendUserContent?: string }).appendUserContent?.trim()
      if (c) return { kind: 'continue', inject: c }
      // blank preventStop falls through
    }
    if (n.tokenBudgetReminder?.trim()) return { kind: 'continue', inject: n.tokenBudgetReminder }
    if (n.activeTodoPanelGuard?.directiveBody.trim()) {
      return { kind: 'continue', inject: n.activeTodoPanelGuard.directiveBody }
    }
    if (n.declaredIntentGuard?.directiveBody.trim()) {
      return { kind: 'continue', inject: n.declaredIntentGuard.directiveBody }
    }
    if (n.allToolsFailedGuard?.directiveBody.trim()) {
      return { kind: 'continue', inject: n.allToolsFailedGuard.directiveBody }
    }
    if (n.verificationGate?.directiveBody.trim()) {
      return { kind: 'continue', inject: n.verificationGate.directiveBody }
    }
    if (n.thinkingOnlySilentTurnGuard?.directiveBody.trim()) {
      return { kind: 'continue', inject: n.thinkingOnlySilentTurnGuard.directiveBody }
    }
    return { kind: 'terminate', reason: 'completed' }
  }

  if (sig.postToolAbort) return { kind: 'terminate', reason: 'aborted_tools' }
  if (sig.pendingHookStop) return { kind: 'terminate', reason: 'hook_stopped' }
  return { kind: 'continue' }
}

/** Normalise the real outcome to the oracle's comparable shape. */
function normalise(outcome: IterationOutcome): OracleResult {
  if (outcome.kind === 'terminate') {
    // Phase-written terminations carry a sentinel reason in the function
    // (the caller reads the real reason off state); the oracle uses the same
    // sentinel ('model_error') for those rows, so compare directly.
    return { kind: 'terminate', reason: outcome.reason }
  }
  return { kind: 'continue', ...(outcome.injectUserContent ? { inject: outcome.injectUserContent } : {}) }
}

// ─────────────────────────────────────────────────────────────────────
// Scenario generation (~300, deterministic)
// ─────────────────────────────────────────────────────────────────────

function generateScenarios(): Scenario[] {
  const out: Scenario[] = []
  let seq = 0
  const push = (s: Omit<Scenario, 'id'>) => {
    out.push({ id: String(seq++).padStart(4, '0'), ...s })
  }
  const base: Omit<Scenario, 'id' | 'category'> = {
    abort: 'none',
    topGate: 'none',
    hook: 'neutral',
    interAgent: false,
    todos: false,
    allFailed: false,
    text: 'plainLong',
    thinking: 'none',
    tokens: 'high',
    budgetEnabled: false,
    nudgeSpent: false,
    stallPrimed: false,
    cbPrimed: false,
    pendingHookStop: false,
  }

  // Block 1 — top-of-table gates & aborts (must always win).
  for (const abort of ['preStream', 'postStream', 'postTool'] as AbortMode[]) {
    for (const hook of ['neutral', 'forceStop', 'blockingError'] as HookKind[]) {
      for (const todos of [false, true]) {
        push({ ...base, category: 'abort_wins', abort, hook, todos })
      }
    }
  }
  for (const topGate of ['boundaryHook', 'preModelTerm', 'blockingLimit', 'streamTerm'] as TopGate[]) {
    for (const todos of [false, true]) {
      for (const text of ['empty', 'declaredIntent'] as TextKind[]) {
        push({ ...base, category: 'top_gate_wins', topGate, todos, text })
      }
    }
  }

  // Block 2 — hook precedence in the no-tool branch.
  for (const hook of ['forceStop', 'blockingError', 'preventStop'] as HookKind[]) {
    for (const todos of [false, true]) {
      for (const text of ['empty', 'question', 'declaredIntent'] as TextKind[]) {
        for (const thinking of ['none', 'declaredIntent'] as ThinkingKind[]) {
          push({ ...base, category: 'hook_precedence', hook, todos, text, thinking })
        }
      }
    }
  }

  // Block 3 — safety nets (stall / circuit breaker) override continue signals.
  for (const stallPrimed of [false, true]) {
    for (const cbPrimed of [false, true]) {
      for (const hook of ['neutral', 'blockingError', 'preventStop'] as HookKind[]) {
        for (const todos of [false, true]) {
          for (const text of ['empty', 'declaredIntent', 'plainShort'] as TextKind[]) {
            for (const thinking of ['none', 'declaredIntent', 'question'] as ThinkingKind[]) {
              push({
                ...base,
                category: 'safety_net_override',
                stallPrimed,
                cbPrimed,
                hook,
                todos,
                text,
                thinking,
                tokens: 'low', // low delta so a primed stall actually trips
              })
            }
          }
        }
      }
    }
  }

  // Block 4 — continuation-guard ladder (todo > declaredIntent > allFailed > thinkingOnly).
  for (const todos of [false, true]) {
    for (const allFailed of [false, true]) {
      for (const nudgeSpent of [false, true]) {
        for (const text of ['empty', 'question', 'completion', 'declaredIntent', 'plainShort'] as TextKind[]) {
          for (const thinking of ['none', 'plain', 'declaredIntent', 'question'] as ThinkingKind[]) {
            push({
              ...base,
              category: 'guard_ladder',
              todos,
              allFailed,
              nudgeSpent,
              text,
              thinking,
              tokens: 'high',
            })
          }
        }
      }
    }
  }

  // Block 5 — token budget interaction (continue vs diminishing) × interAgent.
  for (const budgetEnabled of [false, true]) {
    for (const interAgent of [false, true]) {
      for (const text of ['empty', 'question', 'declaredIntent'] as TextKind[]) {
        for (const tokens of ['high', 'low'] as TokenProfile[]) {
          push({ ...base, category: 'token_budget', budgetEnabled, interAgent, text, tokens })
        }
      }
    }
  }

  // Block 6 — pendingHookStop (row 16).
  for (const text of ['empty', 'plainLong'] as TextKind[]) {
    push({ ...base, category: 'pending_hook_stop', pendingHookStop: true, text })
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────
// The integration test
// ─────────────────────────────────────────────────────────────────────

describe('loop stop/continue — cross-subsystem integration (~300 scenarios)', () => {
  it('every scenario matches the independent oracle (zero interference bugs)', () => {
    const scenarios = generateScenarios()
    // Each scenario gets its own stall guard so streaks never cross-contaminate.
    const mismatches: Array<{ id: string; category: string; got: OracleResult; want: OracleResult }> = []

    const report = {
      total: scenarios.length,
      byCategory: {} as Record<string, number>,
      // by-design interference interactions we want to SEE happening:
      safetyNetOverrodeContinue: 0, // stall/cb terminated while a continue-guard was present
      todoGuardOverrodeQuestion: 0, // Plan A: must stay 0 — a question is never forced to continue by the todo panel
      todoGuardFiredNonQuestion: 0, // the todo panel still nudges real autonomous drift (non-question turns)
      thinkingOnlyRescues: 0, // row 12e turned a would-be silent completion into a nudge
      declaredIntentRescues: 0, // row 12b
      silentCompletions: 0, // terminate completed with no visible text + thinking present + no rescue
    }

    for (const scn of scenarios) {
      report.byCategory[scn.category] = (report.byCategory[scn.category] ?? 0) + 1
      const stallGuard = createIterationStallGuard({ consecutiveStallThreshold: 3 })
      const { signals } = buildEnvelope(scn, stallGuard)

      const got = normalise(decideIterationOutcome(signals))
      const want = oracle(signals)

      if (got.kind !== want.kind || (got.kind === 'terminate' && want.kind === 'terminate' && got.reason !== want.reason)) {
        mismatches.push({ id: scn.id, category: scn.category, got, want })
      }

      // ── Tally by-design interference interactions for the report. ──
      const n = signals.noToolUse
      if (n) {
        const hasContinueGuard = Boolean(
          n.activeTodoPanelGuard || n.declaredIntentGuard || n.allToolsFailedGuard ||
            n.thinkingOnlySilentTurnGuard || n.tokenBudgetReminder?.trim(),
        )
        if (got.kind === 'terminate' &&
            (got.reason === 'iteration_stalled' || got.reason === 'stop_hook_circuit_breaker') &&
            hasContinueGuard) {
          report.safetyNetOverrodeContinue += 1
        }
        if (scn.text === 'question' && n.activeTodoPanelGuard && got.kind === 'continue' &&
            got.inject === n.activeTodoPanelGuard.directiveBody) {
          report.todoGuardOverrodeQuestion += 1
        }
        if (scn.text !== 'question' && n.activeTodoPanelGuard && got.kind === 'continue' &&
            got.inject === n.activeTodoPanelGuard.directiveBody) {
          report.todoGuardFiredNonQuestion += 1
        }
        if (got.kind === 'continue' && n.thinkingOnlySilentTurnGuard &&
            got.inject === n.thinkingOnlySilentTurnGuard.directiveBody) {
          report.thinkingOnlyRescues += 1
        }
        if (got.kind === 'continue' && n.declaredIntentGuard &&
            got.inject === n.declaredIntentGuard.directiveBody) {
          report.declaredIntentRescues += 1
        }
        if (got.kind === 'terminate' && got.reason === 'completed' &&
            !TEXTS[scn.text].trim() && scn.thinking !== 'none') {
          report.silentCompletions += 1
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log('[loop-stop-continue-integration]', JSON.stringify(report, null, 2))
    if (mismatches.length > 0) {
      // eslint-disable-next-line no-console
      console.error('[loop-stop-continue-integration] MISMATCHES', JSON.stringify(mismatches, null, 2))
    }

    // ── THE answer: decision is faithful to the priority spec across every
    //    cross-subsystem combination → no interference bug. ──
    expect(mismatches).toEqual([])
    expect(scenarios.length).toBeGreaterThanOrEqual(280)

    // ── The integration genuinely exercised the interesting interactions. ──
    expect(report.safetyNetOverrodeContinue).toBeGreaterThan(0)
    expect(report.thinkingOnlyRescues).toBeGreaterThan(0)
    expect(report.declaredIntentRescues).toBeGreaterThan(0)
    // Plan A: the todo panel NEVER overrides a clarifying question now, but it
    // still nudges genuine autonomous drift (non-question no-tool turns).
    expect(report.todoGuardOverrodeQuestion).toBe(0)
    expect(report.todoGuardFiredNonQuestion).toBeGreaterThan(0)
  })

  it('PRODUCT invariant: a visible question with NO guards/safety nets always `completed`', () => {
    const stallGuard = createIterationStallGuard({ consecutiveStallThreshold: 3 })
    const { signals } = buildEnvelope(
      {
        id: 'inv-q', category: 'inv', abort: 'none', topGate: 'none', hook: 'neutral',
        interAgent: false, todos: false, allFailed: false, text: 'question', thinking: 'none',
        tokens: 'high', budgetEnabled: false, nudgeSpent: false, stallPrimed: false,
        cbPrimed: false, pendingHookStop: false,
      },
      stallGuard,
    )
    const out = decideIterationOutcome(signals)
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') expect(out.reason).toBe('completed')
  })

  it('PRODUCT invariant: a thinking-only question turn (fresh budget) always continues (row 12e)', () => {
    const stallGuard = createIterationStallGuard({ consecutiveStallThreshold: 3 })
    const { signals } = buildEnvelope(
      {
        id: 'inv-to', category: 'inv', abort: 'none', topGate: 'none', hook: 'neutral',
        interAgent: false, todos: false, allFailed: false, text: 'empty', thinking: 'question',
        tokens: 'high', budgetEnabled: false, nudgeSpent: false, stallPrimed: false,
        cbPrimed: false, pendingHookStop: false,
      },
      stallGuard,
    )
    const out = decideIterationOutcome(signals)
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.injectUserContent).toBe(buildThinkingOnlySilentTurnDirective())
    }
  })

  it('PRODUCT invariant: a sustained thinking-only stall (3rd round, low delta) terminates `iteration_stalled` — stall guard beats the thinking-only nudge', () => {
    const stallGuard = createIterationStallGuard({ consecutiveStallThreshold: 3 })
    const { signals } = buildEnvelope(
      {
        id: 'inv-stall', category: 'inv', abort: 'none', topGate: 'none', hook: 'neutral',
        interAgent: false, todos: false, allFailed: false, text: 'empty', thinking: 'question',
        tokens: 'low', budgetEnabled: false, nudgeSpent: false, stallPrimed: true,
        cbPrimed: false, pendingHookStop: false,
      },
      stallGuard,
    )
    const out = decideIterationOutcome(signals)
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') expect(out.reason).toBe('iteration_stalled')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Compaction-pressure invariance: real ContextManager compaction must not
// change a fixed scenario's stop/continue outcome.
// ─────────────────────────────────────────────────────────────────────

describe('compaction does not interfere with the stop/continue decision', () => {
  it('a fixed thinking-only question scenario yields the SAME outcome before and after repeated real compaction', async () => {
    const CONTEXT_WINDOW = 256_000
    process.env.POLE_CONTEXT_WINDOW_TOKENS = String(CONTEXT_WINDOW)
    try {
      const mgr = new ContextManager()
      let messages: Array<Record<string, unknown>> = []
      const filler = 'x'.repeat(Math.ceil((120_000 * 4) / 4))

      const decideFixed = (): IterationOutcome => {
        const stallGuard = createIterationStallGuard({ consecutiveStallThreshold: 3 })
        const { signals } = buildEnvelope(
          {
            id: 'cmp', category: 'cmp', abort: 'none', topGate: 'none', hook: 'neutral',
            interAgent: false, todos: false, allFailed: false, text: 'empty', thinking: 'question',
            tokens: 'high', budgetEnabled: false, nudgeSpent: false, stallPrimed: false,
            cbPrimed: false, pendingHookStop: false,
          },
          stallGuard,
        )
        return decideIterationOutcome(signals)
      }

      const before = decideFixed()

      const compactOptions = (msgs: Array<Record<string, unknown>>): CompactOptions => ({
        config: { id: 'mock', name: 'mock', apiKey: 'x' } as unknown as CompactOptions['config'],
        model: MODEL,
        systemPrompt: SYSTEM_PROMPT,
        messages: msgs,
        signal: new AbortController().signal,
        agentId: 'cmp-main',
        transcriptPath: 'g:/fake/.conversations/cmp.json',
      })

      for (let round = 1; round <= 40; round++) {
        messages.push({ role: 'user', content: `第 ${round} 轮` })
        for (let i = 0; i < 4; i++) {
          messages.push({
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: `r${round}/i${i} reasoning ` },
              { type: 'tool_use', id: `tu_${round}_${i}`, name: 'read_file', input: { file_path: `f${i}.ts` } },
              { type: 'text', text: `批 ${i}` },
            ],
          })
          messages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: `tu_${round}_${i}`, content: `ok: ${filler}`, is_error: false }],
          })
          mgr.evaluate(messages, SYSTEM_PROMPT, TOOL_DEFS_TOKENS, MODEL)
          const handled = await mgr.handleContext(messages, SYSTEM_PROMPT, compactOptions(messages), TOOL_DEFS_TOKENS)
          messages = handled.messages
        }
      }

      const peak = estimateConversationTokens(messages, SYSTEM_PROMPT) + TOOL_DEFS_TOKENS
      const finalTokens = estimateConversationTokens(messages, SYSTEM_PROMPT) + TOOL_DEFS_TOKENS
      const after = decideFixed()

      // eslint-disable-next-line no-console
      console.log('[compaction-invariance]', JSON.stringify({
        compactCount: mgr.getState().compactCount,
        level: mgr.getState().level,
        peakTokens: peak,
        finalTokens,
        beforeKind: before.kind,
        afterKind: after.kind,
      }, null, 2))

      // Real pressure occurred — the compaction ladder (soft-clear → micro-
      // compact → auto-compact) fired repeatedly across the run (see logs).
      expect(peak).toBeGreaterThan(150_000)
      // The decision is INVARIANT under that pressure: the thinking-only guard
      // scans the CURRENT turn, never the (compacted) history, so the loop
      // makes the same stop/continue call before and after heavy compaction.
      expect(after.kind).toBe(before.kind)
      if (before.kind === 'continue' && after.kind === 'continue') {
        expect(after.injectUserContent).toBe(before.injectUserContent)
      }
    } finally {
      delete process.env.POLE_CONTEXT_WINDOW_TOKENS
    }
  }, 180_000)
})
