/**
 * Repro — user-reported "loop ended after a question turn" (2026-06).
 *
 * The user observed the model think, then emit a single no-tool turn whose
 * visible text was a QUESTION ("需要我对哪个子系统展开分析，或者开始编制某个
 * 方向的文档？"), after which the agentic loop stopped. They suspected the
 * thinking content interfered with the stop/continue decision.
 *
 * This test reproduces the EXACT production wiring of the no-tool branch
 * (`electron/ai/agenticLoop/noTools.ts`) for that turn:
 *   1. scan-source selection: `accumulatedText.trim() ? accumulatedText
 *      : lastThinkingBlock.thinking` (lines 371-373).
 *   2. declared-intent guard construction from `detectDeclaredIntentTail`.
 *   3. the REAL `decideIterationOutcome` no-tool decision table.
 *
 * Conclusion under test: with visible text present, thinking is NOT scanned,
 * the question tail is exempt, no continuation guard fires, and the loop
 * terminates `completed` — by design, NOT a thinking interference bug.
 */

import { describe, expect, it } from 'vitest'
import {
  detectDeclaredIntentTail,
  isDeclaredIntentGuardEnabled,
  buildDeclaredIntentDirective,
} from './declaredIntentGuard'
import {
  buildThinkingOnlySilentTurnDirective,
  isThinkingOnlySilentTurnGuardEnabled,
} from './thinkingOnlySilentTurnGuard'
import { decideIterationOutcome } from './iterationDecision'
import type { StopFamilyHookOutcome } from '../../tools/hooks/engine'

const USER_OBSERVED_TEXT =
  '需要我对哪个子系统展开分析，或者开始编制某个方向的文档？'

const neutralStop: StopFamilyHookOutcome = { kind: 'neutral' }

/** Mirror of noTools.ts lines 371-373 scan-source selection. */
function pickScanSource(
  accumulatedText: string,
  lastThinking: string | undefined,
): string {
  return accumulatedText.trim() ? accumulatedText : (lastThinking ?? '')
}

/**
 * Mirror of the production no-tool decision (noTools.ts): build the row-12b
 * declared-intent signal and the row-12e thinking-only signal with the exact
 * production gating, then feed them through the REAL decision table (all
 * other guards absent — plain chat, no todos, no token budget, no stop hooks).
 */
function decideForTurn(
  accumulatedText: string,
  lastThinking: string | undefined,
  declaredIntentNudgeCount = 0,
  thinkingOnlyNudgeCount = 0,
): ReturnType<typeof decideIterationOutcome> {
  const intentScanSource = pickScanSource(accumulatedText, lastThinking)
  const declaredIntentGuard =
    isDeclaredIntentGuardEnabled() &&
    declaredIntentNudgeCount === 0 &&
    detectDeclaredIntentTail(intentScanSource)
      ? { directiveBody: buildDeclaredIntentDirective() }
      : undefined
  // Row 12e — fires only when the higher-priority declared-intent guard did
  // NOT, the budget is unspent, there is NO visible text, and thinking exists.
  const thinkingOnlySilentTurnGuard =
    !declaredIntentGuard &&
    isThinkingOnlySilentTurnGuardEnabled() &&
    thinkingOnlyNudgeCount === 0 &&
    !accumulatedText.trim() &&
    !!(lastThinking && lastThinking.length > 0)
      ? { directiveBody: buildThinkingOnlySilentTurnDirective() }
      : undefined
  return decideIterationOutcome({
    noToolUse: {
      interAgentInjected: false,
      stopHook: neutralStop,
      stopHookActiveSkipped: false,
      circuitBreakerWouldTrip: false,
      ...(declaredIntentGuard ? { declaredIntentGuard } : {}),
      ...(thinkingOnlySilentTurnGuard ? { thinkingOnlySilentTurnGuard } : {}),
    },
  })
}

describe('repro: question-tail no-tool turn terminates `completed`', () => {
  it('the exact sentence is exempt from the declared-intent guard', () => {
    expect(detectDeclaredIntentTail(USER_OBSERVED_TEXT)).toBe(false)
  })

  it('terminates `completed` when emitted as visible text (no tool use)', () => {
    const outcome = decideForTurn(USER_OBSERVED_TEXT, undefined, 0)
    expect(outcome.kind).toBe('terminate')
    if (outcome.kind === 'terminate') {
      expect(outcome.reason).toBe('completed')
    }
  })

  it('thinking is IGNORED when visible text is present — even thinking that declares intent', () => {
    // The model "thought" about taking action, but the visible reply is the
    // question. Production scans the visible text (it is non-empty), so the
    // intent-declaring thinking does NOT rescue the turn into a continuation.
    const intentThinking = '用户没指定方向。我现在开始修改 PaymentService 的退款逻辑。'
    const scanned = pickScanSource(USER_OBSERVED_TEXT, intentThinking)
    expect(scanned).toBe(USER_OBSERVED_TEXT) // text wins, thinking ignored

    const outcome = decideForTurn(USER_OBSERVED_TEXT, intentThinking, 0)
    expect(outcome.kind).toBe('terminate')
    if (outcome.kind === 'terminate') {
      expect(outcome.reason).toBe('completed')
    }
  })

  it('control: the SAME thinking, with EMPTY visible text, WOULD continue (fallback scans thinking)', () => {
    // Proves the fallback path exists and is the ONLY way thinking can affect
    // the decision: no visible text → thinking tail is scanned → intent fires.
    const intentThinking = '用户没指定方向。我现在开始修改 PaymentService 的退款逻辑。'
    const outcome = decideForTurn('', intentThinking, 0)
    expect(outcome.kind).toBe('continue')
    if (outcome.kind === 'continue') {
      expect(outcome.injectUserContent).toBe(buildDeclaredIntentDirective())
    }
  })

  it('the question is exempt by BOTH tail rules: trailing ？ and "需要我"', () => {
    // Either rule alone is sufficient; both fire on this sentence.
    expect(detectDeclaredIntentTail('需要我对哪个子系统展开分析？')).toBe(false) // ？
    expect(detectDeclaredIntentTail('看看需要我做点什么，先这样')).toBe(false) // 需要我 (no ？)
  })
})

describe('FIXED (Gap B, row 12e): thinking-only turn no longer silently completes', () => {
  // The user's real scenario: the loop ended ON a thinking block. The model
  // produced NO visible text, NO tool use; the question lived INSIDE the
  // thinking. Pre-fix this fell through to a silent `completed` (the user got
  // a thinking block and ZERO readable reply). The thinking-only silent-turn
  // guard (row 12e) now intercepts it and nudges the model once to surface a
  // visible reply or take action.
  it('thinking-only turn ending in the question now CONTINUES with the surface-or-act nudge', () => {
    const thinkingOnly =
      '用户让我分析工作区程序。各子系统都已大致浏览。' + USER_OBSERVED_TEXT
    const outcome = decideForTurn('', thinkingOnly)

    expect(outcome.kind).toBe('continue')
    if (outcome.kind === 'continue') {
      expect(outcome.injectUserContent).toBe(buildThinkingOnlySilentTurnDirective())
    }
  })

  it('a thinking-only turn ending in a PLAIN statement is also caught (not just questions)', () => {
    // The root cause is "no visible reply", not "question". A benign-looking
    // thinking tail that pre-fix would have completed silently is now nudged.
    const thinkingOnly = '各子系统都看过了。嗯，那就先这样吧。'
    const outcome = decideForTurn('', thinkingOnly)
    expect(outcome.kind).toBe('continue')
  })

  it('one-shot: after the budget is spent, a second thinking-only turn terminates `completed`', () => {
    const thinkingOnly = '各子系统都看过了。' + USER_OBSERVED_TEXT
    const outcome = decideForTurn('', thinkingOnly, 0, /* thinkingOnlyNudgeCount */ 1)
    expect(outcome.kind).toBe('terminate')
    if (outcome.kind === 'terminate') {
      expect(outcome.reason).toBe('completed')
    }
  })

  it('declared-intent (row 12b) still wins over the thinking-only guard', () => {
    // When the thinking tail DECLARES an action, the more specific 12b
    // directive should drive the continuation, not the generic 12e one.
    const thinkingDeclaresIntent =
      '用户让我分析工作区程序。我现在开始编制 orchestration 子系统的设计文档。'
    const outcome = decideForTurn('', thinkingDeclaresIntent)
    expect(outcome.kind).toBe('continue')
    if (outcome.kind === 'continue') {
      expect(outcome.injectUserContent).toBe(buildDeclaredIntentDirective())
    }
  })

  it('a turn WITH visible text + thinking is untouched (guard requires empty visible text)', () => {
    // The model gave a real visible reply (a question to the user) — that is
    // a legitimate turn end. Neither guard fires; row 13 `completed` stands.
    const outcome = decideForTurn(USER_OBSERVED_TEXT, '一些内部推理')
    expect(outcome.kind).toBe('terminate')
    if (outcome.kind === 'terminate') {
      expect(outcome.reason).toBe('completed')
    }
  })
})
