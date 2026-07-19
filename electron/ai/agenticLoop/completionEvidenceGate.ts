/**
 * Completion-evidence handshake (row 12f) — 2026-07 "证据满足，正常结束".
 *
 * Protocol: a MAIN-chat turn that used tools may end (row 13 `completed`)
 * only after the model attaches a completion-evidence tag to its final
 * visible reply:
 *
 *   `<complete-evidence>one short line of evidence</complete-evidence>`
 *
 * The host does NOT verify the evidence content ("真假都放行") — the value
 * is the challenge itself: a model with a dangling promise, forced to
 * attest completion, usually goes back and does the work instead; a model
 * that genuinely finished passes at zero cost. This replaces regex-based
 * dangling-promise detection as the FIRST line of defence (the
 * declared-intent regex guard, row 12b, stays as the second line for
 * turns with no tool work to prove).
 *
 * UX invariant (design requirement): the handshake must be invisible AND
 * add no perceptible tail latency:
 *   - Happy path: the system prompt tells the model to append the tag
 *     in-band at the end of its final reply, so completion needs ZERO
 *     extra model rounds — the host sees the tag and terminates
 *     immediately, `message_stop` timing unchanged.
 *   - The tag never reaches the renderer: {@link createCompleteEvidenceStreamFilter}
 *     strips it from the text-delta stream in the main process (with
 *     cross-chunk prefix holdback), so the user never sees the ritual.
 *   - Only a turn that used tools and ended WITHOUT the tag pays a hidden
 *     challenge round — which is exactly the suspicious case where a
 *     continuation ("说做就做") is the desired outcome anyway.
 *
 * Loop safety: challenges are capped per stall episode
 * (`state.completionEvidenceChallengeCount`, cap via
 * {@link completionEvidenceChallengeCap}; reset on a success-bearing tool
 * batch in `orchestration/phases/iteration.ts`). When the cap is spent the
 * gate stands down and row 13 completes normally. The stall guard (8b) and
 * the stop-hook circuit breaker (8) rank above every continuation row and
 * stay authoritative.
 *
 * Exemptions (both mirror the sibling guards):
 *   - Question tails — asking the user something and yielding the turn is
 *     correct behaviour, evidence or not.
 *   - Turns with no tool use — nothing happened that needs proof; pure
 *     Q&A must not pay any handshake latency.
 *
 * Disable via `POLE_COMPLETION_EVIDENCE_GATE=0`.
 */

import { getAgentContext } from '../../agents/agentContext'
import { appendEphemeralGoalRecitation } from './goalRecitation'
import { hostVerificationScopeApplies } from './verificationGate'

type Msg = Record<string, unknown>

/** Marker for tests / telemetry greps. */
export const COMPLETION_EVIDENCE_GATE_MARKER =
  '[Completion evidence required — host check]'

export const COMPLETE_EVIDENCE_OPEN = '<complete-evidence>'
export const COMPLETE_EVIDENCE_CLOSE = '</complete-evidence>'

export function isCompletionEvidenceGateEnabled(): boolean {
  const raw = process.env.POLE_COMPLETION_EVIDENCE_GATE?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

/**
 * Work-package gate (2026-07 复审 N1 fix) — the host-side completion
 * handshake is a CODE-verification loop: the evidence the model attests
 * ("what was done + how you know") is only host-meaningful where the host
 * also runs a verification state machine, and per product design ONLY the
 * built-in `code-dev` work package walks that internal verification path;
 * every other domain (writing, legal, …) drives quality through its own
 * bundle prompt. Before this fix the handshake applied to ALL work
 * packages — non-code bundles paid the full ritual cost (protocol prompt
 * block + tail reminder + up to 2 hidden challenge rounds) while the host
 * had no verification state their tag could possibly correspond to.
 *
 * Applies when:
 *   - NO bundle is active (the default coding-agent experience), or
 *   - the active bundle's resolved verification policy is `'code'`
 *     (the preset `code-dev`, or any bundle explicitly opting in via
 *     `executionPolicy.verification.kind === 'code'`).
 */
export function completionEvidenceHandshakeApplies(): boolean {
  // F3 (2026-07 会话审计) — delegate to the SHARED scope predicate so the
  // "no bundle / policy kind" judgment cannot drift between the evidence
  // handshake, the drive-contract quality gates, and future consumers.
  return hostVerificationScopeApplies()
}

/**
 * M1 (2026-07 会话审计监控) — per-completion-attempt outcome of the
 * evidence handshake, emitted as telemetry so the in-band compliance rate
 * is measurable. Motivation: the tail-slot reorder (item 6) moved the
 * protocol reminder AWAY from the closest-to-generation position; if tag
 * compliance drops, every completion pays a hidden challenge round
 * (user-visible as dead air before message_stop). This classification
 * makes the before/after comparison a telemetry query instead of a
 * guess.
 *
 *   - `not_applicable`   gate disabled / non-code workpack / sub-agent /
 *                        turn used no tools — no evidence owed.
 *   - `in_band_tag`      tag present in the final visible text — the
 *                        zero-latency happy path.
 *   - `question_tail`    turn ended with a genuine question to the user —
 *                        exempt by design.
 *   - `challenge_issued` no tag, budget available — a hidden challenge
 *                        round is warranted this turn (note: a
 *                        higher-priority guard may still preempt the
 *                        actual injection; this classifies the handshake
 *                        state, the existing `nudge` event records the
 *                        actual issuance).
 *   - `cap_exhausted`    budget spent and still no tag — the turn is
 *                        allowed to complete WITHOUT evidence (the
 *                        non-compliant tail we most want to count).
 */
export type CompletionEvidenceOutcome =
  | 'not_applicable'
  | 'in_band_tag'
  | 'question_tail'
  | 'challenge_issued'
  | 'cap_exhausted'

/** Pure classifier — exported for tests; `noTools.ts` derives BOTH the
 *  telemetry event and the row-12f gate condition from this single
 *  source so the two can never drift. */
export function classifyCompletionEvidenceOutcome(input: {
  enabled: boolean
  applies: boolean
  isMainChat: boolean
  turnUsedTools: boolean
  questionTail: boolean
  hasTag: boolean
  challengeCount: number
  cap: number
}): CompletionEvidenceOutcome {
  if (!input.enabled || !input.applies || !input.isMainChat || !input.turnUsedTools) {
    return 'not_applicable'
  }
  if (input.hasTag) return 'in_band_tag'
  if (input.questionTail) return 'question_tail'
  return input.challengeCount < input.cap ? 'challenge_issued' : 'cap_exhausted'
}

const DEFAULT_CHALLENGE_CAP = 2

/**
 * Max hidden challenge rounds per stall episode. Bounded so a model that
 * neither continues the work nor learns the tag protocol cannot burn
 * iterations until `max_turns` — after the cap the gate stands down and
 * the turn is allowed to complete.
 */
export function completionEvidenceChallengeCap(): number {
  const raw = process.env.POLE_COMPLETION_EVIDENCE_MAX_CHALLENGES?.trim()
  if (!raw) return DEFAULT_CHALLENGE_CAP
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHALLENGE_CAP
}

/**
 * `true` when the model submitted the evidence tag. Presence of the OPEN
 * marker is sufficient — content is deliberately not validated, and a
 * stream truncated before the closing tag still counts as an attempt
 * ("真假都放行" applies to malformed submissions too).
 */
export function hasCompleteEvidenceTag(text: string): boolean {
  return text.includes(COMPLETE_EVIDENCE_OPEN)
}

/**
 * Directive body injected as a `<system-reminder>` side-channel message
 * (caller wraps via `injectSideChannelKind`, same plumbing as the other
 * row-12 guards). First challenge explains the protocol; repeats are the
 * short "请完成你的承诺" push.
 */
export function buildCompletionEvidenceDirective(challengeCount: number): string {
  if (challengeCount <= 0) {
    return (
      `${COMPLETION_EVIDENCE_GATE_MARKER}\n\n` +
      `This turn used tools, but your final reply did not submit completion ` +
      `evidence. The host does not grant completion without it. Pick exactly one:\n` +
      `  (a) the work is genuinely finished — submit the evidence now by replying ` +
      `with ONLY the tag: ${COMPLETE_EVIDENCE_OPEN}one short line: what was done + ` +
      `how you know it is done${COMPLETE_EVIDENCE_CLOSE}; or\n` +
      `  (b) the work is NOT finished — continue it NOW with tool calls (submit ` +
      `the tag later, when it is actually done).\n\n` +
      `The tag is stripped before the user sees anything — do not mention it or ` +
      `add any other text around it.`
    )
  }
  return (
    `${COMPLETION_EVIDENCE_GATE_MARKER}\n\n` +
    `请完成你的承诺 — continue! You still have neither continued the work nor ` +
    `submitted ${COMPLETE_EVIDENCE_OPEN}…${COMPLETE_EVIDENCE_CLOSE}. Either ` +
    `finish the work with tool calls now, or submit the evidence tag if it is ` +
    `truly done.`
  )
}

/** First body line — marker for tests / telemetry greps. */
export const COMPLETION_EVIDENCE_REMINDER_MARKER =
  '[Completion-evidence reminder — host-generated]'

/**
 * One-line ephemeral tail reminder (2026-07 smoothness fix). The system-
 * prompt protocol block alone proved insufficient in long transcripts —
 * the model forgets the in-band tag, ends the turn bare, and every
 * completion then pays a hidden challenge round (~1 full model round of
 * dead air after the last visible sentence — the exact "停顿几秒才
 * complete" symptom). Same lesson and same mechanics as goal recitation
 * (`goalRecitation.ts`): re-surface the duty at the absolute tail of the
 * request's WIRE COPY, never persisted, prompt-cache prefix untouched.
 * Injected only when the turn has already used tools (pure Q&A turns owe
 * no evidence and pay zero tokens). Pure — caller gates + appends.
 */
export function buildCompletionEvidenceReminderText(): string {
  return (
    `${COMPLETION_EVIDENCE_REMINDER_MARKER}\n` +
    `This turn has used tools. When you end the turn with the work genuinely ` +
    `complete, append ${COMPLETE_EVIDENCE_OPEN}one short line: what was done + ` +
    `how you know${COMPLETE_EVIDENCE_CLOSE} at the VERY END of your visible ` +
    `reply — it is stripped before the user sees it; never mention it. If work ` +
    `remains, continue with tool calls instead. Do not attach it when ending ` +
    `with a question to the user.`
  )
}

/**
 * Production wrapper used by `stream.ts` — appends the one-line reminder
 * to the END of a COPY of `messages` (reuses the goal-recitation append
 * helper: same side-channel wrap, same tail-merge rules). Returns the
 * SAME array reference when the reminder does not apply:
 *   - gate disabled, or
 *   - not the main chat (sub-agents have their own lifecycle), or
 *   - the turn has not used tools yet (no evidence owed — zero cost for
 *     pure Q&A turns AND for the first iteration of every turn).
 */
export function withEphemeralCompletionEvidenceReminder(
  messages: Msg[],
  opts: {
    /** `state.transitionHistory.includes('tool_use')` — false ⇒ no-op. */
    turnUsedTools: boolean
  },
): Msg[] {
  if (!isCompletionEvidenceGateEnabled()) return messages
  // N1 fix — non-code work packages are prompt-driven; they owe the host
  // no evidence tag and must not pay the reminder tokens.
  if (!completionEvidenceHandshakeApplies()) return messages
  if (!opts.turnUsedTools) return messages
  if (messages.length === 0) return messages
  const agentId = getAgentContext()?.agentId ?? 'main'
  if (agentId !== 'main') return messages
  return appendEphemeralGoalRecitation(messages, buildCompletionEvidenceReminderText())
}

/**
 * Streaming filter that strips `<complete-evidence>…</complete-evidence>`
 * from the user-visible text-delta stream while leaving the transcript
 * copy (`accText`) untouched.
 *
 * Contract:
 *   - `push(chunk)` returns the text safe to emit to the renderer NOW.
 *     Text that could still turn out to be the opening marker (a proper
 *     prefix of it at the buffer tail) is held back until disambiguated,
 *     so a marker split across chunks never leaks.
 *   - Once the opening marker is seen, everything through the closing
 *     marker (or to end of stream) is suppressed; text after the closing
 *     marker resumes normally.
 *   - `flush()` must be called at end of stream: it releases a held-back
 *     false-positive prefix (it was not the tag after all) or drops the
 *     suppressed remainder of an unclosed tag.
 *
 * One instance per stream pass — recreate on `onStreamingFallback` (the
 * accumulators reset there too).
 */
export function createCompleteEvidenceStreamFilter(): {
  push: (chunk: string) => string
  flush: () => string
} {
  let pending = ''
  let suppressing = false

  const longestSuffixThatPrefixesOpen = (s: string): number => {
    const max = Math.min(s.length, COMPLETE_EVIDENCE_OPEN.length - 1)
    for (let len = max; len > 0; len--) {
      if (s.endsWith(COMPLETE_EVIDENCE_OPEN.slice(0, len))) return len
    }
    return 0
  }

  const push = (chunk: string): string => {
    pending += chunk
    let out = ''
    for (;;) {
      if (suppressing) {
        const closeIdx = pending.indexOf(COMPLETE_EVIDENCE_CLOSE)
        if (closeIdx === -1) {
          // Keep only the tail that could still complete the closing
          // marker across the next chunk boundary; the rest is evidence
          // content and can be dropped immediately (never emitted).
          pending = pending.slice(
            Math.max(0, pending.length - (COMPLETE_EVIDENCE_CLOSE.length - 1)),
          )
          return out
        }
        pending = pending.slice(closeIdx + COMPLETE_EVIDENCE_CLOSE.length)
        suppressing = false
        continue
      }
      const openIdx = pending.indexOf(COMPLETE_EVIDENCE_OPEN)
      if (openIdx !== -1) {
        out += pending.slice(0, openIdx)
        pending = pending.slice(openIdx + COMPLETE_EVIDENCE_OPEN.length)
        suppressing = true
        continue
      }
      const hold = longestSuffixThatPrefixesOpen(pending)
      out += pending.slice(0, pending.length - hold)
      pending = pending.slice(pending.length - hold)
      return out
    }
  }

  const flush = (): string => {
    if (suppressing) {
      pending = ''
      return ''
    }
    const out = pending
    pending = ''
    return out
  }

  return { push, flush }
}
