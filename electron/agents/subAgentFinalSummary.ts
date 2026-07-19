/**
 * Final-summary rescue turn for sub-agents that exit abnormally.
 *
 * When a sub-agent terminates by hitting `maxIterations` or being aborted
 * (wall-clock timeout, parent budget, etc.) WITHOUT ever producing a
 * tool-free final assistant turn, the parent agent typically receives
 * a single fragment like "Now let me read the …" — whatever scrap of
 * text the model happened to emit before its first tool call. That is
 * useless to the parent and forces it to either retry blind or stop.
 *
 * This module runs ONE additional non-streaming turn with **tools
 * disabled**, on the same conversation transcript, asking the model to
 * write its final report based on what it has already gathered. Because
 * tools are off, the model is forced to emit a pure text turn, which we
 * capture as the sub-agent's deliverable.
 *
 * Design points:
 *
 *   - Runs on a **fresh, short-budget AbortController** so the parent's
 *     already-fired timeout does not abort the rescue before it streams
 *     anything. The parent's `signal` (user / hard cancel) is still
 *     forwarded so the user can interrupt.
 *   - Uses `enableTools: false` + `toolDefinitionsOverride: []` so the
 *     model cannot loop. `maxIterationsOverride: 1` is belt-and-braces.
 *   - Calls `runAgenticLoop` directly (same in-process agentic loop the
 *     normal run uses) so all wire-level invariants (`ensureToolUseResult-
 *     Pairing`, transformer pipelines, prompt cache handling) apply
 *     identically — no duplicate "mini-client" to maintain.
 *   - Caller decides whether to invoke this: see `subAgentRunner.ts` for
 *     the gate (`shouldRunFinalSummaryRescue`).
 */

import {
  createInMemoryAgentLoopHost,
  runHostedAgentLoop,
} from '../orchestration/hostedAgentLoop'
import type { ProviderConfig } from '../ai/client'
import type { SystemPromptLayers } from '../ai/systemPrompt'
import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'

/**
 * Default wall-clock budget for the rescue turn (single non-tool model call).
 *
 * Raised 30s → 60s: the rescue is now a first-class "graceful wind-down"
 * report path (also used on the worker spawn path), not just an emergency
 * squeeze, so it needs headroom to emit a complete structured report from a
 * large gathered transcript rather than timing out mid-report.
 */
export const FINAL_SUMMARY_RESCUE_BUDGET_MS_DEFAULT = 60_000

/** Floor for env-overridden budget; anything below this is too short to be useful. */
export const FINAL_SUMMARY_RESCUE_BUDGET_MIN_MS = 3_000

/** Ceiling for env-overridden budget; protects against runaway configs. */
export const FINAL_SUMMARY_RESCUE_BUDGET_MAX_MS = 180_000

/** Env override (ms). Set to `0` to disable the rescue entirely. */
const ENV_BUDGET_KEY = 'POLE_SUBAGENT_FINAL_SUMMARY_BUDGET_MS'

/**
 * Resolve the rescue budget from env, clamped to safe bounds.
 * Returns `0` when explicitly disabled (`POLE_SUBAGENT_FINAL_SUMMARY_BUDGET_MS=0`).
 */
export function resolveFinalSummaryRescueBudgetMs(
  envValue: string | undefined = process.env[ENV_BUDGET_KEY],
): number {
  if (envValue === undefined || envValue === '') return FINAL_SUMMARY_RESCUE_BUDGET_MS_DEFAULT
  const n = Number(envValue)
  if (!Number.isFinite(n) || n < 0) return FINAL_SUMMARY_RESCUE_BUDGET_MS_DEFAULT
  if (n === 0) return 0
  return Math.min(
    FINAL_SUMMARY_RESCUE_BUDGET_MAX_MS,
    Math.max(FINAL_SUMMARY_RESCUE_BUDGET_MIN_MS, Math.floor(n)),
  )
}

export type FinalSummaryRescueReason = 'max_iterations' | 'aborted'

/**
 * Build the user-message text injected ahead of the rescue turn. Wrapped in
 * a side-channel marker so the standing system prompt instructs the model
 * to treat it as host-injected guidance rather than fresh user input.
 */
export function buildFinalSummaryRescuePrompt(opts: {
  reason: FinalSummaryRescueReason
  abortReason?: string
  toolCallsMade: number
}): string {
  const cause =
    opts.reason === 'max_iterations'
      ? `You have reached your maximum iteration limit after ${opts.toolCallsMade} tool call(s).`
      : `You have been stopped before completion${
          opts.abortReason ? ` (${opts.abortReason})` : ''
        } after ${opts.toolCallsMade} tool call(s).`

  const body = [
    `${cause} You CANNOT call any more tools — this turn has none available.`,
    '',
    'Write your final report NOW based ONLY on what you have already gathered. The parent agent reads this text as your deliverable; do not waste it on apologies or restating intent.',
    '',
    'Required structure (use markdown headings):',
    '',
    '## Findings',
    '- Concrete things you learned (file paths, function names, line numbers, error messages, command output snippets). One bullet per fact.',
    '',
    '## Conclusion',
    '- The single most important answer to the original task in 1–3 sentences. If you cannot answer, say which specific evidence is still missing.',
    '',
    '## Unfinished work',
    '- The specific next steps the parent agent (or a follow-up sub-agent) must take. File paths and tool/argument shapes when possible.',
    '',
    'Rules:',
    '- DO NOT narrate what you were about to do.',
    '- DO NOT apologize or claim you ran out of time as a substitute for the report.',
    '- DO NOT propose calling tools — there are none.',
    '- Start the reply at `## Findings`. No preamble.',
  ].join('\n')

  return wrapSideChannelBody(SIDE_CHANNEL_KIND.subAgentBudgetExhausted, body)
}

/**
 * Should we run the rescue at all?
 *
 * Conditions, all required:
 *   - Run terminated abnormally (`reachedMaxIterations || aborted`).
 *   - No tool-free final turn captured (`lastFinalText` empty / negligible).
 *   - Transcript walkback (upstream `finalizeAgentTool` parity) did
 *     not find a usable assistant text block either — otherwise the
 *     resolver's new second-priority fallback already covers the
 *     parent's needs and the rescue turn would just burn tokens
 *     re-synthesising what we already have.
 *   - We have a transcript with at least one assistant turn — otherwise the
 *     model has nothing to summarize and the rescue would degenerate into
 *     "make stuff up".
 *   - Budget > 0 (env opt-out is `=0`).
 *   - Parent signal not already aborted (a user-cancel parent run is on its
 *     way out — don't make them wait another 30s).
 */
export function shouldRunFinalSummaryRescue(opts: {
  reachedMaxIterations: boolean
  aborted: boolean
  lastFinalText: string
  /**
   * Joined text of the most recent assistant message with a text
   * block, pulled from the failed-loop transcript. Optional — callers
   * that don't compute it (legacy / worker path) pass `undefined`,
   * leaving rescue gated purely on `lastFinalText` like before.
   */
  transcriptLastAssistantText?: string
  apiMessageCount: number
  parentSignalAborted: boolean
  budgetMs: number
}): boolean {
  if (opts.budgetMs <= 0) return false
  if (opts.parentSignalAborted) return false
  if (!opts.reachedMaxIterations && !opts.aborted) return false
  if (opts.lastFinalText.trim().length >= 200) return false
  if ((opts.transcriptLastAssistantText ?? '').trim().length >= 200) return false
  if (opts.apiMessageCount < 2) return false
  return true
}

export interface FinalSummaryRescueParams {
  config: ProviderConfig
  model: string
  systemPrompt: string
  systemPromptLayers?: SystemPromptLayers
  /** Full API message transcript from the failed run (assistant + user / tool_result pairs). */
  apiMessages: Array<Record<string, unknown>>
  reason: FinalSummaryRescueReason
  abortReason?: string
  toolCallsMade: number
  /** Parent / user signal — when aborted, the rescue stops too. */
  parentSignal: AbortSignal
  budgetMs: number
  /** Forwarded to UI / sidechain log so the rescue turn is visible. */
  onTextDelta?: (text: string) => void
  /** Optional structured "rescue starting / finished" event sink. */
  onEvent?: (event: FinalSummaryRescueEvent) => void
  /** Forward provider usage so the outer accounting stays correct. */
  onStreamUsage?: (usage: { inputTokens: number; outputTokens: number }) => void
}

export type FinalSummaryRescueEvent =
  | { type: 'rescue_start'; budgetMs: number; reason: FinalSummaryRescueReason }
  | { type: 'rescue_text'; text: string }
  | { type: 'rescue_complete'; chars: number; durationMs: number }
  | { type: 'rescue_error'; error: string; durationMs: number }
  | { type: 'rescue_timeout'; durationMs: number }

export interface FinalSummaryRescueResult {
  /** The text the model produced. Empty when no text streamed. */
  text: string
  /** True when the rescue's own budget fired (not the parent's signal). */
  timedOut: boolean
  /** True when an error other than timeout was caught. */
  errored: boolean
  /** Wall-clock duration of the rescue call. */
  durationMs: number
}

/**
 * Run one no-tool turn on the existing transcript and return whatever text
 * the model produces. Never throws — all errors are swallowed and reported
 * via the result / event channel.
 */
export async function runSubAgentFinalSummaryRescue(
  params: FinalSummaryRescueParams,
): Promise<FinalSummaryRescueResult> {
  const startedAt = Date.now()
  params.onEvent?.({ type: 'rescue_start', budgetMs: params.budgetMs, reason: params.reason })

  // Fresh controller — the parent's `effectiveLoopSignal` is already
  // aborted in the maxIter/timeout path, so we cannot reuse it. We do
  // forward the *user* signal so Ctrl+C still wins.
  const rescueAc = new AbortController()
  const onParentAbort = (): void => rescueAc.abort()
  if (params.parentSignal.aborted) {
    rescueAc.abort()
  } else {
    params.parentSignal.addEventListener('abort', onParentAbort, { once: true })
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    rescueAc.abort()
  }, Math.max(1, params.budgetMs))

  // Append the rescue user message; runAgenticLoop applies
  // `ensureToolUseResultPairing` internally so orphan tool_use blocks
  // from the aborted iteration get synthetic tool_results paired in
  // before the wire send.
  const rescuePrompt = buildFinalSummaryRescuePrompt({
    reason: params.reason,
    abortReason: params.abortReason,
    toolCallsMade: params.toolCallsMade,
  })
  const transcriptWithRescue: Array<Record<string, unknown>> = [
    ...params.apiMessages,
    {
      role: 'user',
      content: [{ type: 'text', text: rescuePrompt }],
    },
  ]

  let captured = ''
  let caughtError: string | undefined

  try {
    const loopParams = {
        config: params.config,
        model: params.model,
        messages: [],
        systemPrompt: params.systemPrompt,
        ...(params.systemPromptLayers
          ? { systemPromptLayers: params.systemPromptLayers }
          : {}),
        // Raised 4096 → 8192: a complete Findings/Conclusion/Unfinished
        // report over a large investigation transcript routinely needs more
        // than 4K output tokens; the old cap silently clipped the report.
        maxTokens: 8192,
        // Belt-and-braces: BOTH the tool override AND the master switch
        // are off so no codepath inside `runAgenticLoop` can re-enable
        // tools for this turn.
        enableTools: false,
        toolDefinitionsOverride: [],
        maxIterationsOverride: 1,
        initialApiMessages: transcriptWithRescue,
        signal: rescueAc.signal,
      }
    await runHostedAgentLoop(
      createInMemoryAgentLoopHost(loopParams),
      loopParams,
      {
        onTextDelta: (text: string) => {
          if (!text) return
          captured += text
          params.onTextDelta?.(text)
          params.onEvent?.({ type: 'rescue_text', text })
        },
        onToolStart: () => {
          // Tools are disabled, but if a provider ever decides to call
          // one anyway, swallow it — we are not equipped to run it here.
        },
        onToolResult: () => {},
        onStreamUsage: (usage) => params.onStreamUsage?.(usage),
        onMessageEnd: () => {},
        onError: (err: string) => {
          // Only the first error matters — subsequent fires are usually
          // cascading aborts triggered by the first.
          if (caughtError === undefined) caughtError = err
        },
      },
    )
  } catch (err) {
    if (caughtError === undefined) {
      caughtError = err instanceof Error ? err.message : String(err)
    }
  } finally {
    clearTimeout(timer)
    params.parentSignal.removeEventListener('abort', onParentAbort)
  }

  const durationMs = Date.now() - startedAt
  const text = captured.trim()
  if (timedOut) {
    params.onEvent?.({ type: 'rescue_timeout', durationMs })
  } else if (caughtError && !text) {
    params.onEvent?.({ type: 'rescue_error', error: caughtError, durationMs })
  } else {
    params.onEvent?.({ type: 'rescue_complete', chars: text.length, durationMs })
  }

  return {
    text,
    timedOut,
    errored: Boolean(caughtError) && !text,
    durationMs,
  }
}
