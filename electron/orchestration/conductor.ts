/**
 * 阶段 3 — Kernel-level Conductor.
 *
 * The verification gate (`electron/planning/verificationGateState.ts` +
 * `electron/ai/agenticLoop/verificationGate.ts`) already turns the Verification
 * sub-agent's `VERDICT: …` into a persisted, host-readable signal AND nudges the
 * MODEL once per stall before a `completed` turn. But that closing of the loop is
 * model-discretionary: if the model ignores the nudge and ends the turn anyway
 * with an unaddressed `FAIL`, nothing at the orchestration layer acts on it.
 *
 * This module is the small pure brain that lets the kernel act autonomously on
 * that existing signal — the Cursor-3-Conductor behaviour: when a turn ends with
 * an unaddressed verification `FAIL` and there is outer-loop budget left, the
 * kernel either re-dispatches the turn (so the model gets another shot at the
 * gate's FAIL directive — optionally after rewinding to the last boundary
 * snapshot) or fans out a best-of-N exploration.
 *
 * Design:
 *   - {@link decideConductorAction} is a PURE function (no I/O, no env reads) so
 *     it is trivially unit-testable; the kernel feeds it the gate snapshot +
 *     outcome + budget.
 *   - Best-of-N execution is an injected {@link ConductorBestOfNPort} (faked in
 *     tests, wired to `runBestOfN` + `createSubAgentRunAttempt` by a higher
 *     layer) so this module — and the kernel — never hard-depend on the
 *     sub-agent / best-of-n machinery (avoids an import cycle through
 *     `bestOfNSubAgent → subAgentRunner → runOrchestratedSubAgent → kernel`).
 *   - Gated OFF by default; opt in with `POLE_KERNEL_CONDUCTOR`.
 */

import type { VerificationGateEntry } from '../planning/verificationGateState'

/** Default OFF. Opt in with `POLE_KERNEL_CONDUCTOR` ∈ {1,true,on,yes}. */
export function isConductorEnabled(): boolean {
  const raw = process.env.POLE_KERNEL_CONDUCTOR?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}

export type ConductorAction =
  | { kind: 'accept' }
  | { kind: 'rewind'; reason: string }
  | { kind: 'best_of_n'; reason: string }

/**
 * Injected execution port for the `best_of_n` action. Kept as a port (not a
 * direct `runBestOfN` import) so the kernel stays decoupled from the
 * sub-agent / best-of-n machinery. Returns whether a winner was integrated
 * (informational; the kernel accepts the turn either way).
 */
export interface ConductorBestOfNPort {
  run(input: { task: string; signal?: AbortSignal }): Promise<{ integrated: boolean } | void>
}

export interface ConductorDecisionInput {
  /** `isConductorEnabled()` — passed in so the decision stays pure. */
  enabled: boolean
  /** Whether the outer loop has at least one more iteration of budget. */
  budgetRemaining: boolean
  /** Current verification-gate snapshot for the conversation (may be undefined). */
  gate: VerificationGateEntry | undefined
  /** Termination reason of the turn that just finished (may be undefined). */
  outcomeReason: string | undefined
  /** Whether a {@link ConductorBestOfNPort} is wired (else best_of_n degrades to rewind). */
  bestOfNAvailable: boolean
}

/**
 * Decide what the kernel should do after a turn finished.
 *
 * Intervenes ONLY when:
 *   - the Conductor is enabled, AND
 *   - there is outer-loop budget left, AND
 *   - the turn ended cleanly (`completed`/unknown — NOT aborted/max_turns/error,
 *     where re-dispatch would be pointless or fight the user), AND
 *   - the verification gate still flags an unaddressed substantive `FAIL`.
 *
 * Prefers `best_of_n` (explore alternatives) when a port is available, else
 * falls back to `rewind` (re-attempt the turn so the model sees the gate's FAIL
 * directive again). Everything else → `accept`.
 */
export function decideConductorAction(input: ConductorDecisionInput): ConductorAction {
  if (!input.enabled) return { kind: 'accept' }
  if (!input.budgetRemaining) return { kind: 'accept' }
  // Only act on clean endings. An aborted / max_turns / model_error turn should
  // not be auto-re-dispatched (user cancel wins; budget exhaustion / provider
  // errors need different handling).
  if (input.outcomeReason && input.outcomeReason !== 'completed') {
    return { kind: 'accept' }
  }
  const gate = input.gate
  if (!gate) return { kind: 'accept' }
  if (gate.lastVerdict === 'FAIL' && gate.needsVerification) {
    return input.bestOfNAvailable
      ? { kind: 'best_of_n', reason: 'verification FAIL — exploring alternatives' }
      : { kind: 'rewind', reason: 'verification FAIL — re-attempting from last boundary' }
  }
  return { kind: 'accept' }
}
