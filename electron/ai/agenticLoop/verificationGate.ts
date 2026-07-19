/**
 * Verification gate — no-tool completion guard (row 12d).
 *
 * Closes the loop opened by `electron/planning/verificationGateState.ts`:
 * when the MAIN chat is about to end a turn (`completed`) after making
 * substantive, not-yet-PASS-verified workspace edits, this guard nudges
 * the model ONCE to run independent verification (delegate to the
 * Verification sub-agent, or run build/tests/typecheck itself) before
 * claiming the work is done — or to address a previous `FAIL`.
 *
 * ## Bounded completion gate
 *
 * Same anti-spiral rationale as `declaredIntentGuard` / `allToolsFailedGuard`:
 * the guard intercepts the benign "model edited code then stopped without
 * verifying" path exactly once per stall episode. If the model verifies,
 * the gate state clears on a PASS/PARTIAL verdict. If it ignores the nudge
 * and stops again, the loop terminates as `verification_required` instead
 * of falsely reporting `completed`. This is bounded (one continuation) and
 * cannot spiral to `max_turns` when verification is genuinely unavailable.
 *
 * ## Gating
 *
 * - **On by default**. Opt out via `POLE_VERIFICATION_GATE=0`.
 * - Main chat only (the caller in `noTools.ts` enforces this).
 * - **Coding work package only.** The gate forces *code-style* verification
 *   (build / tests / typecheck), which is meaningless for a writing or
 *   general-chat work package — running `npm run build` on a prose draft is
 *   pure busywork. Per product decision (2026-06) it activates ONLY for the
 *   preset coding bundle (`code-dev`). Every other work package — writing,
 *   general, AND any user-created or imported bundle — owns "did I verify my
 *   output?" through its OWN system prompt, never a host-enforced loop. See
 *   {@link activeBundleUsesCodeVerification}.
 * - Fires after `MIN_MUTATIONS_BEFORE_GATE` (default 1) successful
 *   file-mutation tool call since the last clearing verdict. An operator may
 *   raise the threshold, but the built-in `code-dev` default treats every
 *   successful code mutation as requiring completion evidence.
 * - Lowest-priority continuation (below every other no-tool row, above
 *   `completed`).
 */

import {
  getVerificationGateState,
  type VerificationGateEntry,
} from '../../planning/verificationGateState'
import { getActiveBundle } from '../../agents/bundles/bundleRegistryQueries'
import { CODE_DEV_BUNDLE_ID, type BundleVerificationPolicy } from '../../agents/bundles/types'
import { getAgentContext } from '../../agents/agentContext'
import { appendEphemeralGoalRecitation } from './goalRecitation'

/** Marker for tests / telemetry greps. */
export const VERIFICATION_GATE_MARKER = '[Unverified implementation — host check]'

/**
 * Minimum mutating batches before the gate is allowed to fire. The built-in
 * code-dev package defaults to one successful mutation so even a focused fix
 * must provide completion evidence. Tunable via env (operator override).
 */
export const MIN_MUTATIONS_BEFORE_GATE = parseMinMutations(
  process.env.POLE_VERIFICATION_GATE_MIN_MUTATIONS,
)

function parseMinMutations(raw: string | undefined): number {
  if (!raw) return 1
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 1
}

export function isVerificationGateEnabled(): boolean {
  const raw = process.env.POLE_VERIFICATION_GATE?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

/**
 * Resolve the active work package's declared verification kind.
 *
 * Resolution order:
 *   1. No active bundle (registry not hydrated in this process, early boot,
 *      headless / CLI) → `'none'`. Product rule (2026-06, re-affirmed
 *      2026-07): ONLY the preset coding bundle walks the host verification
 *      loop; every other work package owns verification through its own
 *      prompt. When the host cannot AFFIRMATIVELY resolve a code work
 *      package it must not force build/test nudges — the old `'code'`
 *      fallback made a 售前/writing conversation (whose process never
 *      hydrated the bundle registry) eat "run the build / tests /
 *      typecheck" directives against prose documents (observed 2026-07).
 *   2. The bundle declares `executionPolicy.verification` → use it verbatim.
 *      This is how ANY work package — a user-forked coding bundle, a writing
 *      bundle, a legal bundle — opts into (or out of) host-driven
 *      verification without being the preset `code-dev` id.
 *   3. No declared policy → legacy id check: `code-dev` → `'code'`, everything
 *      else → `'none'`. Identical to the pre-policy behaviour, so existing
 *      bundles are unaffected until they add a policy.
 */
export function getActiveBundleVerificationPolicy(): BundleVerificationPolicy {
  const bundle = getActiveBundle()
  if (!bundle) return { kind: 'none' }
  const declared = bundle.executionPolicy?.verification
  if (declared) return declared
  return bundle.meta.id === CODE_DEV_BUNDLE_ID ? { kind: 'code' } : { kind: 'none' }
}

/**
 * Does the active work package verify via a code toolchain (build / tests /
 * typecheck / lint)? The verification gate forces code-style verification, so
 * it activates ONLY when the resolved policy kind is `'code'`. Non-code
 * policies (`none` / `self-review` / `delegate`) own verification through the
 * bundle's own prompt / reviewer agent, not this host build-test loop.
 */
export function activeBundleUsesCodeVerification(): boolean {
  return getActiveBundleVerificationPolicy().kind === 'code'
}

/**
 * F3 (2026-07 会话审计) — SHARED "does the host's code-verification scope
 * apply?" predicate. Product design: only the built-in `code-dev` work
 * package (or a bundle explicitly declaring
 * `executionPolicy.verification.kind === 'code'`) walks the host's
 * internal verification loops; other domains are prompt-driven.
 *
 * Semantics: NO active bundle (the default coding-agent experience, or a
 * process that never hydrated the registry while still being the base
 * product) ⇒ applies; bundle present ⇒ resolved policy must be `'code'`.
 *
 * Consumers sharing this judgment:
 *   - `completionEvidenceGate.completionEvidenceHandshakeApplies`
 *   - `systemDriveContext.hostQualityGatesApply` (quality gate +
 *     completion criteria sections)
 *
 * DELIBERATE EXCEPTION — `buildVerificationGateSignal` (row 12d) keeps
 * its stricter rule (no bundle ⇒ OFF): forcing "run the build / tests"
 * nudges requires AFFIRMATIVE knowledge of a code work package, because
 * a non-hydrated registry in a writing/售前 conversation must never eat
 * build directives against prose (documented 2026-07 product decision in
 * {@link getActiveBundleVerificationPolicy}). Advisory surfaces (prompt
 * sections, evidence ritual) tolerate the default-on reading; the
 * hard-nudging gate does not.
 */
export function hostVerificationScopeApplies(): boolean {
  if (!getActiveBundle()) return true
  return getActiveBundleVerificationPolicy().kind === 'code'
}

/**
 * Work-package-neutral phrasing for "how to verify a finished unit of work",
 * derived from the active bundle's verification policy. Used by the TodoWrite
 * / TaskUpdate completion nudges so a writing / legal / general work package
 * is never told to "run tests". Returns `null` when the policy is `none`
 * (the work package owns verification through its own prompt — no host nudge).
 */
export function describeVerificationAction(): string | null {
  const policy = getActiveBundleVerificationPolicy()
  switch (policy.kind) {
    case 'none':
      return null
    case 'code':
      return 'running the tests / build / typecheck (or invoking the Verification sub-agent)'
    case 'self-review': {
      const cl =
        policy.checklist && policy.checklist.length > 0
          ? ` against your checklist (${policy.checklist.join('; ')})`
          : ''
      return `a self-review pass of your output${cl}`
    }
    case 'delegate':
      return `the "${policy.agentType}" reviewer agent (via the Agent tool)`
  }
}

/**
 * Pure predicate: should the gate fire for this conversation's current
 * state? Exported for tests. Fires when there is an unverified substantive
 * mutation (≥ {@link MIN_MUTATIONS_BEFORE_GATE}) and either no verdict was
 * ever produced or the last verdict was `FAIL`.
 */
export function shouldFireVerificationGate(
  entry: VerificationGateEntry | undefined,
): boolean {
  if (!entry) return false
  if (!entry.needsVerification) return false
  if (entry.mutationCount < MIN_MUTATIONS_BEFORE_GATE) return false
  // A PASS/PARTIAL already cleared `needsVerification`; the only verdicts
  // that can coexist with `needsVerification === true` are `undefined`
  // (never verified) and `FAIL`. Both warrant the nudge.
  return entry.lastVerdict === undefined || entry.lastVerdict === 'FAIL'
}

/**
 * Build the side-channel directive. Two variants: never-verified vs the
 * model ran verification but it returned `FAIL` and was not addressed.
 */
export function buildVerificationGateDirective(
  entry: VerificationGateEntry,
): string {
  if (entry.lastVerdict === 'FAIL') {
    const detail = entry.failDetail?.trim()
    return (
      `${VERIFICATION_GATE_MARKER}\n\n` +
      `Independent verification of your changes returned VERDICT: FAIL and you have ` +
      `not addressed it. Before ending this turn:\n` +
      `  (a) fix the reported failure(s), then re-run verification until it passes; OR\n` +
      `  (b) if the failure is not actionable (external contract, environment limit), ` +
      `say so explicitly and tell the user what remains broken.\n\n` +
      `Do not claim the work is complete while verification is failing.` +
      (detail ? `\n\nLast verification report (excerpt):\n${detail}` : '')
    )
  }
  return (
    `${VERIFICATION_GATE_MARKER}\n\n` +
    `You made ${entry.mutationCount} workspace file edit(s) but the turn is ` +
    `ending without any independent verification. You cannot self-certify — reading ` +
    `your own diff is not verification. Pick exactly one:\n` +
    `  (a) delegate to the Verification agent (Agent tool, agentType "Verification"), ` +
    `passing the original task, the files you changed, and your approach — it returns a ` +
    `PASS/FAIL/PARTIAL verdict with command evidence; OR\n` +
    `  (b) verify it yourself NOW — run the build / tests / typecheck and exercise the ` +
    `changed behavior, then report what you ran and observed; OR\n` +
    `  (c) if verification is genuinely impossible here, say so explicitly and tell the ` +
    `user what they should run.\n\n` +
    `Never report work as complete without verification evidence in this conversation.`
  )
}

/** First body line — marker for tests / telemetry greps. */
export const VERIFICATION_PENDING_REMINDER_MARKER =
  '[Verification pending — host-generated]'

/**
 * One-line ephemeral tail reminder (2026-07 "验证节点前移" fix).
 *
 * The row-12d gate is purely REACTIVE: the host only learns the model
 * intends to finish when the turn ends with no tool use — at which point
 * the final declaration has already been streamed to the user in full.
 * Firing the gate there produces the worst-case UX: complete answer →
 * forced re-verification → the model re-outputs the whole result a
 * second time (observed in production, 2026-07 code-dev double-output
 * report). Same failure shape and same fix as the completion-evidence
 * reminder (`buildCompletionEvidenceReminderText`): re-surface the duty
 * at the absolute tail of the request's WIRE COPY while the gate is
 * armed, so the model verifies BEFORE composing its final reply and the
 * reactive gate stays a rarely-hit backstop. Never persisted, prompt-
 * cache prefix untouched. Pure — caller gates + appends.
 */
export function buildVerificationPendingReminderText(
  entry: VerificationGateEntry,
): string {
  const failTail =
    entry.lastVerdict === 'FAIL'
      ? ` A previous verification returned VERDICT: FAIL — address it (or explain why it is not actionable) before claiming completion.`
      : ''
  return (
    `${VERIFICATION_PENDING_REMINDER_MARKER}\n` +
    `This conversation has ${entry.mutationCount} workspace file edit(s) with no ` +
    `independent verification yet. BEFORE you write a final reply that reports the ` +
    `work as done, verify it: run the build / tests / typecheck (or delegate to the ` +
    `Verification agent) and include what you ran and observed. Re-reading your own ` +
    `edits does not count. If you are not finishing yet (more work, or a question ` +
    `to the user), ignore this.` +
    failTail
  )
}

/**
 * Production wrapper used by `stream.ts` — appends the one-line reminder
 * to the END of a COPY of `messages` (reuses the goal-recitation append
 * helper: same side-channel wrap, same tail-merge rules). Returns the
 * SAME array reference when the reminder does not apply:
 *   - gate disabled, or
 *   - not the main chat (sub-agents have their own discipline), or
 *   - the active work package does not verify via a code toolchain
 *     (writing / general / imported bundles own their verification), or
 *   - the gate is not armed for this conversation (no substantive
 *     unverified edits, or a PASS/PARTIAL/inline verification already
 *     cleared it) — so pure Q&A turns and already-verified work pay
 *     zero tokens.
 */
export function withEphemeralVerificationPendingReminder(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (!isVerificationGateEnabled()) return messages
  if (messages.length === 0) return messages
  const ctx = getAgentContext()
  const agentId = ctx?.agentId ?? 'main'
  if (agentId !== 'main') return messages
  if (getActiveBundleVerificationPolicy().kind !== 'code') return messages
  const cid = ctx?.streamConversationId?.trim()
  if (!cid) return messages
  const entry = getVerificationGateState(cid)
  if (!shouldFireVerificationGate(entry)) return messages
  return appendEphemeralGoalRecitation(
    messages,
    buildVerificationPendingReminderText(entry!),
  )
}

/**
 * Convenience for the caller: returns the directive body when the gate
 * should fire for `conversationId`, else `undefined`. Keeps the env check
 * + state lookup + predicate in one place so `noTools.ts` stays terse.
 */
export function buildVerificationGateSignal(
  conversationId: string | undefined,
): { directiveBody: string } | undefined {
  const policy = getActiveBundleVerificationPolicy()
  const enabled = isVerificationGateEnabled()
  const cid = conversationId?.trim()
  const entry = cid ? getVerificationGateState(cid) : undefined

  if (!enabled) return undefined
  // Non-coding work packages (writing / general / user-created / imported)
  // verify through their own prompt, never this build/test loop.
  if (policy.kind !== 'code') return undefined
  if (!cid) return undefined
  if (!shouldFireVerificationGate(entry)) return undefined
  return { directiveBody: buildVerificationGateDirective(entry!) }
}
