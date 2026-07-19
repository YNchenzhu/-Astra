/**
 * All-tools-failed guard — 2026-06 silent-stop audit (Gap A).
 *
 * Failure mode: the model calls one or more tools, EVERY result comes back
 * an error (e.g. an MCP server is down, a command keeps failing), and on the
 * next turn the model produces no tool_use and stops. The no-tool decision
 * table (`iterationDecision.ts`) then routes to a benign `completed`
 * termination — no error event, the turn looks like a normal success, but
 * the user's task never got done. From the user's seat this reads as the
 * agent "silently stopping" on a half-finished task.
 *
 * This guard adds a deterministic, host-side check: when the PREVIOUS tool
 * batch was entirely errors (`state.lastToolBatchAllErrors`) and the model
 * then stops without acting, continue ONCE with a side-channel directive —
 * retry with a corrected approach, or explicitly tell the user why the task
 * cannot be completed. One-shot per turn (`state.allToolsFailedNudgeCount`,
 * reset on genuine forward progress in `iteration.ts`) so a model that
 * legitimately gives up after the nudge can still end the turn — no infinite
 * nudge loop.
 *
 * Priority: the LOWEST continuation interceptor in the no-tool table — it
 * sits below the active-todo guard and the declared-intent guard and only
 * intercepts the would-be `completed` path. Safety-net terminations
 * (forceStop / circuit breaker / stall) always win.
 *
 * Disable via `POLE_ALL_TOOLS_FAILED_GUARD=0`.
 */

/** Marker for tests / telemetry greps. */
export const ALL_TOOLS_FAILED_MARKER = '[All tool calls failed — host check]'

export function isAllToolsFailedGuardEnabled(): boolean {
  const raw = process.env.POLE_ALL_TOOLS_FAILED_GUARD?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

/**
 * Directive body injected as a `<system-reminder>` side-channel message
 * (the caller wraps it via `injectSideChannelKind`, same plumbing as the
 * active-todo and declared-intent guards).
 */
export function buildAllToolsFailedDirective(): string {
  return (
    `${ALL_TOOLS_FAILED_MARKER}\n\n` +
    `Every tool call in your previous step returned an error, and this turn ` +
    `ended without any further action. Do not stop silently on a failed step. ` +
    `Pick exactly one:\n` +
    `  (a) diagnose the failure and retry with a corrected approach (different ` +
    `arguments, a prerequisite step, or an alternative tool); or\n` +
    `  (b) if the task genuinely cannot be completed, tell the user plainly ` +
    `what failed and why you are stopping.\n\n` +
    `Do not report the task as done — the last step did not succeed.`
  )
}
