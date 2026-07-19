/**
 * Read-only sub-agent budget constants & helpers.
 *
 * Extracted from `subAgentRunner.ts` so both spawn paths can enforce the
 * same hard caps:
 *
 *   1. **In-process** (`runSubAgent` in `subAgentRunner.ts`) — already
 *      called these helpers inline at the `loopCallbacks` hook points
 *      (onMessageEnd for the token budget, the loop body for the tool-
 *      call cap).
 *   2. **worker_threads** (`subAgentWorkerClient.ts`) — previously had
 *      **no** budget enforcement at all. `Explore` / `Plan` /
 *      `Verification` sub-agents dispatched through the worker pool
 *      could burn unlimited tokens / tool calls before the loop's
 *      `maxIterationsOverride` cap finally tripped, defeating the
 *      whole "read-only sub-agents stop after ~120 tool calls / ~120k
 *      tokens" contract surfaced to parent agents.
 *
 * Pulling the helpers out also breaks a would-be circular import:
 * `subAgentRunner` already imports from `subAgentWorkerClient`, so
 * routing the client's `import` back through runner would close the
 * loop. Same rationale as `subAgentOutputResolver.ts`.
 *
 * The runner re-exports the public symbols (`READONLY_AGENT_TYPES`,
 * `shouldAbortReadonlyBudgetAfterMessageEnd`) so external callers
 * (`teamAutoLauncher.ts`, `subAgentRunner.p1-bugs.test.ts`) keep working
 * without an import-path change.
 */

import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'

/**
 * Hard cap on total tool calls for read-only sub-agents (Explore, Plan,
 * Verification). These agents have no file-modification tools and can
 * burn through 100+ iterations of Glob/Grep/Read without producing a
 * useful report. When this limit is reached, the sub-agent is
 * force-terminated and its accumulated output text is returned.
 */
const MAX_READONLY_SUBAGENT_TOOL_CALLS = 120

/** Warn when approaching the hard cap — gives the agent one last chance to produce a report. */
const READONLY_TOOL_CALL_WARN_AT = 90

const VERIFICATION_MAX_TOOL_CALLS = Math.max(
  MAX_READONLY_SUBAGENT_TOOL_CALLS,
  Number(process.env.POLE_VERIFICATION_SUBAGENT_TOOL_CALLS ?? '120'),
)

const VERIFICATION_TOOL_CALL_WARN_AT = Math.max(
  READONLY_TOOL_CALL_WARN_AT,
  Number(process.env.POLE_VERIFICATION_SUBAGENT_WARN_AT ?? '90'),
)

/**
 * Sub-agent types that are strictly read-only (no Write/Edit/Agent tools).
 *
 * Also exported so callers that synthesise prompts for these agents
 * (e.g. `teamAutoLauncher.buildTeamLaunchPlan`) can avoid instructing
 * them to call tools they don't have — every member of this set has
 * `SendMessage` and `TeamCreate` in its `disallowedTools`, and
 * `TeamStatus` is not in `ASYNC_AGENT_ALLOWED_TOOLS` either, so any
 * prompt-level mention of those tools is a no-op at best and a stall at
 * worst (model attempts the call, gets "unknown tool", retries, then
 * gives up — presenting to the parent as a "stuck on first turn"
 * report).
 */
export const READONLY_AGENT_TYPES = new Set<string>(['Explore', 'Plan', 'Verification'])

/**
 * Token budget for read-only sub-agents. When total tokens exceed this
 * threshold, the sub-agent is force-terminated to prevent runaway
 * costs. Default ~120K tokens — enough for thorough exploration of a
 * larger codebase before the rescue path kicks in. (Previously 32K,
 * then 96K; raised again after the tool-call cap was unified to 120 so
 * the token budget doesn't trip noticeably earlier than the tool-call
 * budget on long-running Explore/Plan runs.)
 */
const MAX_READONLY_SUBAGENT_TOKEN_BUDGET = 120_000

const MAX_VERIFICATION_SUBAGENT_TOKEN_BUDGET = Math.max(
  MAX_READONLY_SUBAGENT_TOKEN_BUDGET,
  Number(process.env.POLE_VERIFICATION_SUBAGENT_TOKEN_BUDGET ?? '96000'),
)

export function readonlyToolCallLimit(agentType: string): number {
  return agentType === 'Verification'
    ? VERIFICATION_MAX_TOOL_CALLS
    : MAX_READONLY_SUBAGENT_TOOL_CALLS
}

export function readonlyToolCallWarnAt(agentType: string): number {
  return agentType === 'Verification'
    ? VERIFICATION_TOOL_CALL_WARN_AT
    : READONLY_TOOL_CALL_WARN_AT
}

export function readonlyTokenBudget(agentType: string): number {
  return agentType === 'Verification'
    ? MAX_VERIFICATION_SUBAGENT_TOKEN_BUDGET
    : MAX_READONLY_SUBAGENT_TOKEN_BUDGET
}

/**
 * Fraction of the hard token budget at which a read-only sub-agent should be
 * told to STOP exploring and write its final report (graceful wind-down),
 * INSTEAD of being hard-killed once the budget is fully exhausted.
 *
 * This is the root-cause fix for "parent only ever gets a truncated result":
 * crossing this soft line injects a forced tool-free report turn while the
 * agent is still running, so the loop ends cleanly with `success: true` and a
 * complete structured report — rather than `bridgeAc.abort()` discarding the
 * in-progress work mid-exploration. Mirrors the tool-call wind-down, which
 * already fires at 85% of the tool-call warn threshold.
 */
const READONLY_TOKEN_WINDDOWN_FRACTION = 0.85

/**
 * Soft token line: when effective tokens cross this, the caller should inject
 * the wind-down directive (one forced tool-free report turn). Strictly below
 * the hard budget so the directive turn still fits before the backstop abort.
 */
export function readonlyTokenWindDownLine(agentType: string): number {
  return Math.max(
    1,
    Math.floor(readonlyTokenBudget(agentType) * READONLY_TOKEN_WINDDOWN_FRACTION),
  )
}

/**
 * Should we inject the graceful token-pressure wind-down directive?
 *
 * Pure predicate — the caller owns the once-only latch
 * (`ctx.budgetDirectiveInjected`) so the directive is injected at most once
 * per run regardless of whether tool-count or token pressure tripped first.
 */
export function shouldInjectReadonlyTokenWindDown(params: {
  agentType: string
  effectiveTokens: number
}): boolean {
  return (
    READONLY_AGENT_TYPES.has(params.agentType) &&
    params.effectiveTokens >= readonlyTokenWindDownLine(params.agentType)
  )
}

/** The graceful wind-down directive to inject as a forced tool-free turn. */
export interface ReadonlyWindDownDirective {
  /** Side-channel-wrapped user message instructing the agent to write its report now. */
  appendUserContent: string
  /** Always true — the wind-down turn must be tool-free so the model emits a report. */
  disableToolsForThisTurn: true
  /** Which budget dimension tripped the wind-down (for sidechain / telemetry). */
  trigger: 'tools' | 'tokens' | 'iterations'
}

/**
 * Compute the read-only sub-agent graceful wind-down directive, or `undefined`
 * when no wind-down is warranted yet.
 *
 * Shared by BOTH spawn paths so they inject byte-identical guidance:
 *   - in-process: `subAgentLoopCallbacks.ts` `onQueryLoopPreModel`.
 *   - worker_threads: `subAgentWorker.ts` fanOutTo `onQueryLoopPreModel`.
 *
 * Triggers (either is sufficient):
 *   - tool-call pressure: ≥85% of the tool-call warn threshold.
 *   - token pressure: ≥ the token wind-down line (85% of the hard budget).
 *
 * The caller owns the once-only latch — this is a pure function.
 */
export function computeReadonlyWindDownDirective(params: {
  agentType: string
  totalToolUses: number
  effectiveTokens: number
}): ReadonlyWindDownDirective | undefined {
  if (!READONLY_AGENT_TYPES.has(params.agentType)) return undefined
  const toolPressure =
    params.totalToolUses >=
    Math.max(1, Math.floor(readonlyToolCallWarnAt(params.agentType) * 0.85))
  const tokenPressure = shouldInjectReadonlyTokenWindDown({
    agentType: params.agentType,
    effectiveTokens: params.effectiveTokens,
  })
  if (!toolPressure && !tokenPressure) return undefined
  // Prefer the token framing only when token pressure is the SOLE trigger —
  // otherwise the tool-call wording stays (its threshold is the
  // historically-tuned one and most runs trip it first).
  const trigger: 'tools' | 'tokens' = tokenPressure && !toolPressure ? 'tokens' : 'tools'
  const usageDetail =
    trigger === 'tokens'
      ? `~${params.effectiveTokens} tokens of context`
      : `${params.totalToolUses} tool calls`
  const appendUserContent = wrapSideChannelBody(
    SIDE_CHANNEL_KIND.subAgentBudgetExhausted,
    `READ-ONLY SUB-AGENT INVESTIGATION BUDGET EXHAUSTED.\n\n` +
      `You have used ${usageDetail}. Your role is bounded investigation, not indefinite search.\n` +
      `STOP calling tools now. Do not call Read, Grep, Glob, Bash, or any other tool.\n` +
      `Use the evidence already gathered in this conversation and write your final structured report immediately.\n\n` +
      `Your final report must include:\n` +
      `1. Summary\n` +
      `2. Key findings\n` +
      `3. File locations\n` +
      `4. Remaining uncertainty, if any`,
  )
  return { appendUserContent, disableToolsForThisTurn: true, trigger }
}

/**
 * Final-turn abort gate, called after every `message_end`.
 *
 * The caller has already determined that the token budget was
 * exceeded; this function only decides whether it is **safe** to
 * abort right now — i.e. whether we'd be discarding a clean final
 * report.
 *
 *   - `toolsThisTurn > 0`   → this turn used tools, so the model
 *                              hasn't produced a final report yet;
 *                              aborting is OK.
 *   - `!finalText.trim()`   → this turn was tool-free but emitted no
 *                              actual text (e.g. an aborted stream
 *                              that produced only `thinking`
 *                              deltas); aborting is OK.
 *
 * Returning `false` means "let this turn complete" — the budget
 * trip is treated as a soft warning rather than a hard stop, so
 * already-finished reports don't get clobbered on the way out.
 */
export function shouldAbortReadonlyBudgetAfterMessageEnd(params: {
  toolsThisTurn: number
  finalText: string
}): boolean {
  return params.toolsThisTurn > 0 || !params.finalText.trim()
}

// ─── Iteration-limit graceful wind-down (ALL sub-agents) ─────────────────
//
// The read-only wind-down above only covers Explore / Plan / Verification
// against their own tool-call / token caps. It does NOT cover the generic
// `maxIterations` backstop, and it does not apply to write-capable agents.
// Without this, a sub-agent that runs to `maxIterations` exits mid-tool as
// `reachedMaxIterations` with only a "Now let me …" fragment, forcing the
// post-mortem final-summary rescue to reconstruct a report.
//
// This proactive path fires ONE forced tool-free report turn as the run
// approaches its iteration cap — while the agent is still alive — so it
// self-finishes with a complete report and the loop terminates `completed`
// (not `max_turns`). Applies to every agent type and every spawn path.

/**
 * How many iterations before the hard cap to trigger the graceful report
 * turn. `1` means: on the second-to-last allowed iteration, spend it on a
 * tool-free report instead of one more tool call the budget can't afford to
 * follow up on.
 */
export const ITERATION_WINDDOWN_LEAD = 1

/**
 * Should we inject the iteration-limit wind-down this turn?
 *
 * Pure predicate — the caller owns the once-only latch
 * (`ctx.budgetDirectiveInjected`) shared with the read-only wind-down, so at
 * most one wind-down turn fires per run regardless of which dimension tripped
 * first.
 *
 * Guards:
 *   - `maxIterations <= 2`: too small to spend a whole iteration winding down;
 *     the final-summary rescue backstop handles these.
 *   - `iteration` is 1-based (matches `state.iteration` in `iteration.ts`).
 */
export function shouldInjectIterationWindDown(params: {
  iteration: number
  maxIterations: number
}): boolean {
  if (!Number.isFinite(params.maxIterations) || params.maxIterations <= 2) return false
  return params.iteration >= params.maxIterations - ITERATION_WINDDOWN_LEAD
}

/**
 * Build the iteration-limit wind-down directive (a forced tool-free report
 * turn). Agent-agnostic wording — unlike the read-only variant it does not
 * assume the agent lacks write tools, so it asks for a summary of work done
 * plus findings and remaining next steps.
 */
export function buildIterationWindDownDirective(params: {
  iteration: number
  maxIterations: number
}): ReadonlyWindDownDirective {
  const appendUserContent = wrapSideChannelBody(
    SIDE_CHANNEL_KIND.subAgentBudgetExhausted,
    `ITERATION BUDGET NEARLY EXHAUSTED (iteration ${params.iteration} of ${params.maxIterations}).\n\n` +
      `This is effectively your LAST turn — no more tool calls will be available afterwards.\n` +
      `STOP calling tools now and write your final report immediately, based ONLY on what you have already done and gathered.\n\n` +
      `Your final report must include:\n` +
      `1. Summary of what you accomplished\n` +
      `2. Key findings / changes (file paths, function names, results, error messages)\n` +
      `3. Anything left unfinished and the concrete next steps for a follow-up`,
  )
  return { appendUserContent, disableToolsForThisTurn: true, trigger: 'iterations' }
}
