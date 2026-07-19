/**
 * Destructive long-run simulation — "declared intent without action" silent
 * stop, under sustained context-compaction pressure.
 *
 * Scenario the user asked to reproduce:
 *   - 256K-context model (window forced via POLE_CONTEXT_WINDOW_TOKENS).
 *   - 80 rounds of conversation.
 *   - ~128K tokens of working context consumed per round (thinking + tool_use
 *     + tool_result filler), so the REAL ContextManager fires its compaction
 *     ladder (soft_clear → history_snip → micro_compact → auto_compact)
 *     many times across the run.
 *   - Each round ends with a NO-TOOL assistant turn whose text DECLARES an
 *     imminent action ("我现在开始修改 X" / "Let me now run the tests") — the
 *     exact degradation the declared-intent guard exists to catch.
 *
 * Question under test: after all that compaction, does the loop still let a
 * "declared intent then stopped" no-tool turn slip through to a SILENT
 * `completed` termination?
 *
 * This is hermetic: it wires the REAL pieces that actually decide the
 * outcome —
 *   - `electron/context/manager.ts` ContextManager (real tier logic +
 *     real compaction; the auto-compact LLM call is mocked to a
 *     deterministic summary, same seam as destructiveContextInjection.50x120).
 *   - `detectDeclaredIntentTail` (real tail scan — the guard's eyes).
 *   - `decideIterationOutcome` (real no-tool decision table — row 12b vs
 *     row 13 `completed`).
 *   - The one-shot budget semantics copied verbatim from the production
 *     call sites: `state.declaredIntentNudgeCount` resets to 0 on a
 *     successful tool batch (iteration.ts) and increments when the guard
 *     drives a continuation (noTools.ts).
 *
 * Key insight it verifies: the guard scans the CURRENT turn's text, not
 * history, so compaction of history can never blind it.
 */

import { describe, it, expect, vi } from 'vitest'
import { ContextManager } from '../../context/manager'
import type { CompactOptions } from '../../context/compact'
import { estimateConversationTokens } from '../../context/tokenCounter'
import {
  DECLARED_INTENT_MARKER,
  buildDeclaredIntentDirective,
  detectDeclaredIntentTail,
  isDeclaredIntentGuardEnabled,
} from './declaredIntentGuard'
import { decideIterationOutcome } from './iterationDecision'
import type { StopFamilyHookOutcome } from '../../tools/hooks/engine'
import { silenceExpectedConsoleWarnAndError } from '../../testHelpers/silenceExpectedConsole'

// ─── Deterministic auto-compact summarizer (hermetic LLM substitute) ──
// Same seam destructiveContextInjection.50x120 uses: the compaction path is
// real, only the summarizing LLM call is replaced by a fixed string.
vi.mock('../client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../client')>()
  return {
    ...orig,
    streamText: vi.fn(
      async (
        _config: unknown,
        _params: unknown,
        callbacks: {
          onTextDelta?: (t: string) => void
          onMessageEnd?: () => void
        },
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

type Msg = Record<string, unknown>

// ─── Stress profile ───────────────────────────────────────────────────
const ROUNDS = 80
const TOOL_ITERS_PER_ROUND = 4
const SYSTEM_PROMPT = 'You are the IDE agent under declared-intent silent-stop stress testing.'
const TOOL_DEFS_TOKENS = 6_000
const MODEL = 'claude-sonnet-4-6'
const AGENT_ID = 'silentstop-main'
const CONTEXT_WINDOW = 256_000

// ~128K tokens of working context per round. ASCII estimates at length/4, so
// ~512K chars / round. Spread across TOOL_ITERS_PER_ROUND tool batches. The
// filler is a single shared immutable string reference (cheap to push many
// times) so memory stays flat even though the per-round char count is large.
const PER_RESULT_CHARS = Math.ceil((128_000 * 4) / TOOL_ITERS_PER_ROUND)
const TOOL_RESULT_FILLER = 'x'.repeat(PER_RESULT_CHARS)
const THINKING_FILLER = 'reasoning over the refund idempotency batch. '.repeat(40)

const noStop: StopFamilyHookOutcome = { kind: 'neutral' }

/** Alternating Chinese / English "declared intent, no action" tail texts. */
function declaredIntentText(round: number): string {
  return round % 2 === 0
    ? `第 ${round} 轮分析完毕。我现在开始修改 PaymentService 的退款幂等逻辑。`
    : `Round ${round} analysis done. Let me now run the tests to confirm the fix.`
}

/** A legitimately-terminal tail (completion / question) — must NOT be nudged. */
function benignTerminalText(round: number): string {
  return round % 2 === 0
    ? `第 ${round} 轮的改造已全部完成。`
    : `Round ${round} is all done. Anything else you want me to change?`
}

function buildToolBatch(round: number, iter: number): { assistant: Msg; result: Msg } {
  const id = `tu_r${round}_i${iter}`
  const assistant: Msg = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: `r${round}/i${iter} ${THINKING_FILLER}` },
      { type: 'tool_use', id, name: 'read_file', input: { file_path: `g:/fake/src/m${round}/f${iter}.ts` } },
      { type: 'text', text: `第 ${round} 轮第 ${iter} 批：读取并核对退款幂等改造。` },
    ],
  }
  const result: Msg = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: `ok r${round}/i${iter}: ${TOOL_RESULT_FILLER}`, is_error: false }],
  }
  return { assistant, result }
}

interface SimResult {
  compactCount: number
  tierCounts: Record<string, number>
  /** Rounds whose FIRST declared-intent no-tool turn was intercepted (continue). */
  interceptedRounds: number
  /** BUG: declared-intent first-stall turns that silently terminated `completed`. */
  silentStops: Array<{ round: number; detail: string }>
  /** Detection misses: declared-intent text the tail scan failed to flag. */
  detectionMisses: number
  /** Double-stall (2nd consecutive no-tool, budget spent) → intended `completed`. */
  oneShotTerminations: number
  /** Benign terminal tails that were correctly NOT nudged (terminate completed). */
  benignTerminations: number
  /** Benign tails that were wrongly nudged (over-fire). */
  benignOverFires: number
  peakTokens: number
}

async function runSimulation(): Promise<SimResult> {
  const mgr = new ContextManager()
  const tierCounts: Record<string, number> = {}
  let messages: Msg[] = []

  // Real production-shaped one-shot budget (mirrors LoopState.declaredIntentNudgeCount).
  let declaredIntentNudgeCount = 0

  const out: SimResult = {
    compactCount: 0,
    tierCounts,
    interceptedRounds: 0,
    silentStops: [],
    detectionMisses: 0,
    oneShotTerminations: 0,
    benignTerminations: 0,
    benignOverFires: 0,
    peakTokens: 0,
  }

  const compactOptions = (msgs: Msg[]): CompactOptions => ({
    config: { id: 'mock', name: 'mock', apiKey: 'x' } as unknown as CompactOptions['config'],
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    messages: msgs,
    signal: new AbortController().signal,
    agentId: AGENT_ID,
    transcriptPath: 'g:/fake/.conversations/silentstop-80x128k.json',
  })

  // Evaluate the no-tool turn exactly the way the production pipeline does:
  // build the row-12b signal only when the one-shot budget is unspent AND the
  // tail scan flags an imminent action; feed it through the REAL decision
  // table; apply the REAL one-shot accounting on a guard-driven continue.
  const decideNoTool = (turnText: string): ReturnType<typeof decideIterationOutcome> => {
    const detected = detectDeclaredIntentTail(turnText)
    const declaredIntentGuard =
      isDeclaredIntentGuardEnabled() &&
      declaredIntentNudgeCount === 0 &&
      detected
        ? { directiveBody: buildDeclaredIntentDirective() }
        : undefined
    const outcome = decideIterationOutcome({
      noToolUse: {
        interAgentInjected: false,
        stopHook: noStop,
        stopHookActiveSkipped: false,
        circuitBreakerWouldTrip: false,
        ...(declaredIntentGuard ? { declaredIntentGuard } : {}),
      },
    })
    if (
      declaredIntentGuard &&
      outcome.kind === 'continue' &&
      outcome.injectUserContent === declaredIntentGuard.directiveBody
    ) {
      declaredIntentNudgeCount += 1 // mirrors noTools.ts one-shot spend
    }
    return outcome
  }

  for (let round = 1; round <= ROUNDS; round++) {
    messages.push({ role: 'user', content: `第 ${round} 轮：继续按总目标处理模块 m${round}。` })

    // ── Phase A: tool batches build ~128K tokens, real compaction runs. ──
    for (let iter = 1; iter <= TOOL_ITERS_PER_ROUND; iter++) {
      const { assistant, result } = buildToolBatch(round, iter)
      messages.push(assistant, result)

      const evalResult = mgr.evaluate(messages, SYSTEM_PROMPT, TOOL_DEFS_TOKENS, MODEL)
      tierCounts[evalResult.action] = (tierCounts[evalResult.action] ?? 0) + 1
      const handled = await mgr.handleContext(messages, SYSTEM_PROMPT, compactOptions(messages), TOOL_DEFS_TOKENS)
      messages = handled.messages

      // A successful tool batch is "genuine forward progress" → the loop
      // resets the declared-intent one-shot budget (iteration.ts).
      declaredIntentNudgeCount = 0
    }

    out.peakTokens = Math.max(
      out.peakTokens,
      estimateConversationTokens(messages, SYSTEM_PROMPT) + TOOL_DEFS_TOKENS,
    )

    // ── Phase B: the degraded NO-TOOL turn — declares intent, no tool_use. ──
    const turnText = declaredIntentText(round)
    if (!detectDeclaredIntentTail(turnText)) out.detectionMisses += 1

    const outcome = decideNoTool(turnText)
    if (outcome.kind === 'continue') {
      out.interceptedRounds += 1
      // Faithful: the directive really is the host's declared-intent directive.
      expect(outcome.injectUserContent).toBe(buildDeclaredIntentDirective())
    } else {
      out.silentStops.push({
        round,
        detail: `first declared-intent no-tool turn terminated '${outcome.reason}' instead of being intercepted`,
      })
    }

    // ── Phase B2 (every 10th round): a SECOND consecutive no-tool declared
    //    turn with NO tool batch between — budget now spent → intended
    //    one-shot `completed`. Documents that the guard does not loop forever. ──
    if (round % 10 === 0) {
      const outcome2 = decideNoTool(declaredIntentText(round))
      if (outcome2.kind === 'terminate' && outcome2.reason === 'completed') {
        out.oneShotTerminations += 1
      } else {
        out.silentStops.push({
          round,
          detail: `second consecutive stall did not resolve to one-shot 'completed' (got ${outcome2.kind})`,
        })
      }
      declaredIntentNudgeCount = 0 // a tool batch would have reset it; emulate next round
    }

    // ── Phase B3 (every 7th round): a benign terminal tail — must NOT nudge. ──
    if (round % 7 === 0) {
      declaredIntentNudgeCount = 0
      const benign = benignTerminalText(round)
      const benignOutcome = decideNoTool(benign)
      if (benignOutcome.kind === 'terminate' && benignOutcome.reason === 'completed') {
        out.benignTerminations += 1
      } else {
        out.benignOverFires += 1
      }
      declaredIntentNudgeCount = 0
    }
  }

  out.compactCount = mgr.getState().compactCount
  return out
}

describe('declared-intent silent stop — 80 rounds × ~128K, 256K window, real compaction', () => {
  it(
    'never lets a declared-intent no-tool turn slip to a silent completion, even after repeated compaction',
    { timeout: 180_000 },
    async () => {
      process.env.POLE_CONTEXT_WINDOW_TOKENS = String(CONTEXT_WINDOW)
      delete process.env.POLE_DECLARED_INTENT_GUARD // ensure default-on
      let res: SimResult
      try {
        res = await runSimulation()
      } finally {
        delete process.env.POLE_CONTEXT_WINDOW_TOKENS
      }

      // eslint-disable-next-line no-console
      console.log('[declared-intent-silentstop-80x128k]', JSON.stringify({
        rounds: ROUNDS,
        perRoundTargetTokens: 128_000,
        contextWindow: CONTEXT_WINDOW,
        compactCount: res.compactCount,
        tierCounts: res.tierCounts,
        interceptedRounds: res.interceptedRounds,
        silentStops: res.silentStops,
        detectionMisses: res.detectionMisses,
        oneShotTerminations: res.oneShotTerminations,
        benignTerminations: res.benignTerminations,
        benignOverFires: res.benignOverFires,
        peakTokens: res.peakTokens,
        marker: DECLARED_INTENT_MARKER,
      }, null, 2))

      // ── The test was actually destructive: compaction fired repeatedly. ──
      expect(res.compactCount, 'auto-compact never fired — pressure was not real').toBeGreaterThan(5)
      expect(res.peakTokens, 'per-round working context never approached the 128K target').toBeGreaterThan(100_000)

      // ── Detection survived compaction every round (guard scans current
      //    turn text, not compacted history). ──
      expect(res.detectionMisses, 'declared-intent tail scan missed some turns').toBe(0)

      // ── THE answer: zero silent stops across all 80 rounds. ──
      expect(res.silentStops, 'declared-intent turns silently terminated').toEqual([])
      expect(res.interceptedRounds, 'not every round was intercepted').toBe(ROUNDS)

      // ── One-shot anti-loop upheld: the 2nd consecutive stall terminates. ──
      expect(res.oneShotTerminations).toBe(Math.floor(ROUNDS / 10))

      // ── Guard does not over-fire on legitimate completion/question tails. ──
      expect(res.benignOverFires, 'guard nudged a benign terminal turn').toBe(0)
      expect(res.benignTerminations).toBe(Math.floor(ROUNDS / 7))
    },
  )
})
