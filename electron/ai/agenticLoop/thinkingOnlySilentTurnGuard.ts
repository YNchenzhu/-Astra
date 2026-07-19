/**
 * Thinking-only silent-turn guard — 2026-06 silent-stop audit (Gap B).
 *
 * Failure mode (user-reported): the model produces a no-tool-use turn that
 * has NO user-visible text at all — its entire output (analysis, and often a
 * question like "需要我对哪个子系统展开分析？") lives inside the THINKING
 * block. The no-tool decision table then routes to a benign `completed`
 * termination, and the user is left with a thinking block and ZERO visible
 * reply. From the user's seat the loop "ended on thinking": no answer, no
 * question they can act on, no tool evidence — a silent dead-end.
 *
 * Why the existing guards miss it:
 *   - `declaredIntentGuard` (row 12b) scans the thinking tail when the
 *     visible text is empty, but only fires when the tail DECLARES an
 *     imminent action; a thinking-only turn that ends in a question (or a
 *     plain statement) matches no intent pattern AND is exempt, so it falls
 *     through to `completed`.
 *   - `activeTodoPanelGuard` / `allToolsFailedGuard` / `verificationGate`
 *     all require unrelated preconditions (todos / failed batch / unverified
 *     edits).
 *
 * This guard closes the gap with the correct root-cause check: a turn with
 * NO visible text + NO tool use + SOME thinking is a degenerate output. It
 * continues ONCE with a side-channel directive — surface your reply (answer
 * or question) to the user as visible text, or take the action you were
 * reasoning about. One-shot per stall episode
 * (`state.thinkingOnlySilentTurnNudgeCount`, reset on genuine forward
 * progress in `iteration.ts`) so a model that, after the nudge, still
 * produces nothing is allowed to end — no infinite nudge loop.
 *
 * Priority: the LOWEST continuation interceptor in the no-tool table — it
 * sits below every other guard (todo / declared-intent / all-tools-failed /
 * verification gate) and only intercepts the would-be `completed` path.
 * Safety-net terminations (forceStop / circuit breaker / stall) always win.
 *
 * Disable via `POLE_THINKING_ONLY_SILENT_TURN_GUARD=0`.
 */

/** Marker for tests / telemetry greps. */
export const THINKING_ONLY_SILENT_TURN_MARKER =
  '[Thinking-only turn, no visible reply — host check]'

export function isThinkingOnlySilentTurnGuardEnabled(): boolean {
  const raw = process.env.POLE_THINKING_ONLY_SILENT_TURN_GUARD?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

/**
 * Directive body injected as a `<system-reminder>` side-channel message
 * (the caller wraps it via `injectSideChannelKind`, same plumbing as the
 * other no-tool guards).
 */
export function buildThinkingOnlySilentTurnDirective(): string {
  return (
    `${THINKING_ONLY_SILENT_TURN_MARKER}\n\n` +
    `Your last turn produced only internal reasoning — there was no ` +
    `user-visible reply and no tool call, so the user received nothing they ` +
    `can read or act on. Do not end a turn this way. Pick exactly one:\n` +
    `  (a) if you were about to act, call the appropriate tool(s) NOW; or\n` +
    `  (b) if you need an answer or a decision from the user, ASK them in ` +
    `visible text (a question that lives only in your thinking was never ` +
    `shown to the user); or\n` +
    `  (c) if you have a conclusion, state it to the user in visible text.\n\n` +
    `Reasoning in the thinking block is not a reply — the user only sees what ` +
    `you write as visible text or the tools you run.`
  )
}
