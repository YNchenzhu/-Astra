/**
 * Verification-gate state tracker — the closed loop that turns the
 * Verification sub-agent's adversarial `VERDICT: …` from advisory text
 * into a host-enforceable signal.
 *
 * ## Why this exists
 *
 * upstream (canonical Claude Code) ships a very strong adversarial
 * `verificationAgent` prompt ("your job is not to confirm it works — it's
 * to try to break it") that ends with a machine-parseable
 * `VERDICT: PASS|FAIL|PARTIAL`. The prompt says "parsed by caller" — but
 * upstream has no caller that actually parses it; verification is left to
 * the model's own discipline (delegate when you feel like it, trust the
 * report).
 *
 * This module is that missing caller. It records:
 *
 *   1. that the MAIN chat made substantive workspace mutations that have
 *      not yet been independently verified (`noteWorkspaceMutation`), and
 *   2. the VERDICT of any foreground Verification sub-agent the model ran
 *      (`recordVerificationVerdict`).
 *
 * The `verification_gate` no-tool guard (see
 * `electron/ai/agenticLoop/verificationGate.ts`) reads
 * {@link getVerificationGateState} and, exactly once per stall episode,
 * nudges a would-be `completed` termination into a continuation when the
 * model is about to end after substantive unverified edits — or after a
 * `FAIL` it never addressed.
 *
 * ## State model
 *
 * Per-conversation (keyed by `streamConversationId`), at most one entry.
 * Main-chat only — sub-agents have their own verification discipline and
 * the main chat re-verifies their delivered work anyway.
 *
 * ## Lifecycle
 *
 *   - `noteWorkspaceMutation`  → `needsVerification = true`, `++mutationCount`
 *   - `recordVerificationVerdict(PASS|PARTIAL)` → clears the gate
 *     (`needsVerification = false`, `mutationCount = 0`). PARTIAL is the
 *     agent's honest "couldn't fully verify due to environment", which we
 *     accept rather than nag forever.
 *   - `recordVerificationVerdict(FAIL)` → keeps `needsVerification = true`
 *     and stores a short `failDetail` so the gate directive can quote it.
 *   - `noteInlineVerification` → clears the gate the same way a PASS verdict
 *     does. Fired when the MAIN chat itself runs a SUCCESSFUL build / test /
 *     typecheck / lint command (option (b) of the gate directive). Without
 *     this, a model that verified its own work inline never cleared the gate
 *     — only a Verification *sub-agent* verdict did — so it got force-nudged
 *     into a redundant re-verification AFTER it had already declared done.
 *
 * Like the plan-verification tracker this lives in a module-level Map
 * (not on per-turn LoopState) because the implement→verify cycle spans
 * multiple top-level turns in the same conversation.
 */

export type VerificationVerdict = 'PASS' | 'FAIL' | 'PARTIAL'

export interface VerificationGateEntry {
  /** A substantive, not-yet-PASS-verified mutation exists in this conversation. */
  needsVerification: boolean
  /** Number of mutating tool batches since the last clearing verdict. */
  mutationCount: number
  /** Most recent verdict captured from a foreground Verification sub-agent. */
  lastVerdict?: VerificationVerdict
  /** Short excerpt of the failing report (only set when lastVerdict === 'FAIL'). */
  failDetail?: string
}

const FAIL_DETAIL_MAX_CHARS = 800

const gateByConversation = new Map<string, VerificationGateEntry>()

function getOrCreate(conversationId: string): VerificationGateEntry {
  let entry = gateByConversation.get(conversationId)
  if (!entry) {
    entry = { needsVerification: false, mutationCount: 0 }
    gateByConversation.set(conversationId, entry)
  }
  return entry
}

/**
 * Record that the main chat made substantive workspace mutations that
 * should be independently verified before the turn is allowed to end.
 *
 * `count` is the number of successful workspace file-mutation tool calls
 * in the batch (NOT the batch count) so `mutationCount` tracks edits the
 * way the Verification agent's "3+ file edits" heuristic means it — a
 * single assistant message with `edit_file ×3` advances the count by 3,
 * not 1. Non-positive / non-finite counts are clamped to 1 so a caller
 * that knows "something mutated" but not how many still arms the gate.
 */
export function noteWorkspaceMutation(conversationId: string, count = 1): void {
  if (!conversationId) return
  const inc = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1
  const entry = getOrCreate(conversationId)
  entry.needsVerification = true
  entry.mutationCount += inc
}

/**
 * Parse the canonical `VERDICT: PASS|FAIL|PARTIAL` line from a
 * Verification sub-agent's final output. The agent is instructed to end
 * with exactly one such line; we scan ALL matches and take the LAST so a
 * worked-example `VERDICT:` inside the report body cannot shadow the real
 * terminal verdict. Returns `undefined` when no verdict line is present.
 */
export function parseVerdict(text: string | undefined): VerificationVerdict | undefined {
  if (!text) return undefined
  const re = /VERDICT:\s*(PASS|FAIL|PARTIAL)\b/gi
  let match: RegExpExecArray | null
  let last: VerificationVerdict | undefined
  while ((match = re.exec(text)) !== null) {
    last = match[1]!.toUpperCase() as VerificationVerdict
  }
  return last
}

/**
 * Record the verdict of a completed foreground Verification sub-agent.
 * PASS / PARTIAL clear the gate; FAIL keeps it pending and stores a short
 * excerpt of the report so the gate directive can quote what failed.
 */
export function recordVerificationVerdict(
  conversationId: string,
  verdict: VerificationVerdict,
  report?: string,
): void {
  if (!conversationId) return
  const entry = getOrCreate(conversationId)
  entry.lastVerdict = verdict
  if (verdict === 'FAIL') {
    entry.needsVerification = true
    const trimmed = (report ?? '').trim()
    entry.failDetail = trimmed
      ? trimmed.slice(-FAIL_DETAIL_MAX_CHARS)
      : undefined
  } else {
    // PASS or PARTIAL — the work has been independently exercised. Clear
    // the pending mutation so the gate does not nag, and reset the count
    // so a fresh round of edits can re-arm the gate later.
    entry.needsVerification = false
    entry.mutationCount = 0
    entry.failDetail = undefined
  }
}

/**
 * Heuristic: does this shell command run an independent verification — a
 * test / build / typecheck / lint pass? Used by the tool-exec layer to
 * recognise that the MAIN chat verified its own work INLINE (option (b) of
 * the verification-gate directive) so the gate can be cleared instead of
 * forcing a redundant re-verification after the model declared the work
 * done. Conservative: matches recognised runner tokens only, so unrelated
 * shell work (`git status`, `npm install`, `ls`) never clears the gate.
 */
export function isInlineVerificationCommand(command: string | undefined): boolean {
  if (!command) return false
  const c = command.trim()
  if (!c) return false
  // Standalone runners across language toolchains / test frameworks.
  if (
    /\b(?:vitest|jest|mocha|ava|jasmine|pytest|phpunit|rspec|minitest|ctest|tox)\b/i.test(c) ||
    /\bplaywright\s+test\b/i.test(c) ||
    /\bcypress\s+run\b/i.test(c) ||
    /\btsc\b/i.test(c) ||
    /\beslint\b/i.test(c) ||
    /\bbiome\s+(?:check|lint|ci)\b/i.test(c) ||
    /\bgo\s+(?:test|vet|build)\b/i.test(c) ||
    /\bcargo\s+(?:test|build|check|clippy)\b/i.test(c) ||
    /\bmvn\s+(?:test|verify|package|install)\b/i.test(c) ||
    /\bgradlew?\b[^\n&|;]*\b(?:test|check|build)\b/i.test(c) ||
    /\bmake\s+(?:test|check|lint|build|ci)\b/i.test(c) ||
    /\bpython3?\s+-m\s+(?:pytest|unittest|mypy|tox)\b/i.test(c)
  ) {
    return true
  }
  // Package-manager script invocations: `npm|pnpm|yarn|bun (run) <script>`
  // whose script name signals a verification step.
  return /\b(?:npm|pnpm|yarn|bun)\b[^\n&|;]*\b(?:test|tests|typecheck|type-check|tsc|lint|build|check|verify|e2e|vitest|jest)\b/i.test(
    c,
  )
}

/**
 * Record that the MAIN chat ran a SUCCESSFUL inline verification command
 * (build / tests / typecheck / lint) in this conversation. Clears the gate
 * the same way a Verification sub-agent PASS verdict does, so a model that
 * verifies its own work BEFORE declaring done is not force-nudged into a
 * redundant re-verification afterwards. A later round of edits re-arms the
 * gate via `noteWorkspaceMutation`.
 *
 * No-op when the gate was never armed — we must not fabricate a phantom
 * verdict for a conversation that never mutated anything.
 */
export function noteInlineVerification(conversationId: string): void {
  if (!conversationId) return
  const entry = gateByConversation.get(conversationId)
  if (!entry) return
  entry.needsVerification = false
  entry.mutationCount = 0
  entry.lastVerdict = 'PASS'
  entry.failDetail = undefined
}

export function getVerificationGateState(
  conversationId: string,
): VerificationGateEntry | undefined {
  if (!conversationId) return undefined
  return gateByConversation.get(conversationId)
}

/**
 * Drop the gate entry for one conversation. Production seam — called when a
 * conversation is reset / deleted so a reused conversation id can't inherit a
 * stale mutation count.
 */
export function clearVerificationGateForConversation(conversationId: string): void {
  if (!conversationId) return
  gateByConversation.delete(conversationId)
}

/**
 * Drop ALL gate state. Production seam — called on work-package (bundle)
 * switch: the verification gate is coding-oriented, so an accumulated
 * `mutationCount` from a code bundle must not survive into a different work
 * package (and back), where it would otherwise mis-fire build/test nudges.
 */
export function clearAllVerificationGateState(): void {
  gateByConversation.clear()
}

/** Test seam — drop one or all entries. */
export function __resetVerificationGateStateForTests(
  conversationId?: string,
): void {
  if (conversationId) gateByConversation.delete(conversationId)
  else gateByConversation.clear()
}
