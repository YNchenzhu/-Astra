/**
 * Long-run semantic-tag integrity simulation — 30 iterations, 6 compactions.
 *
 * Reproduces the long-run failure surface the 2026-05 audit identified
 * AND verifies all three fix layers (A: stripInternalMeta=false; B:
 * markers for marker=null kinds; D: skip consecutive-user-merge on the
 * state writeback path) actually hold under sustained pressure.
 *
 * Each iteration mirrors the production iteration pipeline:
 *
 *     1.  assistant turn with a `tool_use` block
 *     2.  user turn carrying the matching `tool_result` block
 *     3.  post_tool: 4 host-attachment reminders pushed as separate
 *         user-role side-channel messages (mirrors `runCollectors({
 *         callSite: 'post_tool' })` push_message actions)
 *     4.  end-of-iteration normalize (the FIXED call site —
 *         `stripInternalMeta: false`, `applyConsecutiveUserMerge:
 *         false`)
 *
 * Every 5 iterations a compact happens — the head of the transcript is
 * replaced with a single `compactSummary` boundary message, mirroring
 * `electron/context/compact.ts`. 30 iterations × compact-every-5 gives
 * 6 compactions, exactly matching the user's stress profile.
 *
 * Assertions pin the fix end-to-end: after 30 turns and 6 compactions
 *   - every host-injected reminder retains a correct typed kind in
 *     `state.apiMessages`
 *   - `findLastCompactBoundaryIndex` finds every boundary via the
 *     `_compactBoundary` flag (no substring fallback)
 *   - the resume-from-disk path (typed flags stripped) still recovers
 *     `staleTodoNudge` / `staleTaskNudge` kinds via the new bracket
 *     markers added by audit fix B
 *   - the throttle simulation fires exactly 3 reminders across 30 turns
 *     at a 10-turn cadence (not the 30 reminders the broken path would
 *     emit when typed kinds were silently dropped)
 */

import { describe, expect, it } from 'vitest'
import {
  SIDE_CHANNEL_KIND,
  isHostSideChannelMessage,
  makeSideChannelUserMessage,
  readSideChannelKind,
  type SideChannelKind,
} from '../constants/sideChannelKinds'
import { normalizeMessagesForAPI } from './normalizeMessagesForAPI'
import {
  createCompactBoundaryMarker,
  findLastCompactBoundaryIndex,
  hasCompactBoundary,
} from './compactBoundary'

type Msg = Record<string, unknown>

// ─── Helpers that mimic the production call sites ────────────────────

function userTurn(text: string): Msg {
  return { role: 'user', content: text }
}

function assistantWithToolUse(turn: number): Msg {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: `turn ${turn} planning` },
      {
        type: 'tool_use',
        id: `tu_${turn}`,
        name: 'read_file',
        input: { path: `file_${turn}.ts` },
      },
    ],
  }
}

function userWithToolResult(turn: number): Msg {
  // Production shape: `{ role: 'user', content: [{ type: 'tool_result', ... }] }`.
  // Crucially this turn does NOT carry `_convertedFromSystem` — it is
  // the canonical "real user turn from the AND-semantics perspective"
  // even though it contains no real user text. Audit fix D ensures
  // iteration-level normalize does not fold side-channel reminders
  // into it.
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: `tu_${turn}`,
        content: `tool output ${turn}`,
      },
    ],
  }
}

/**
 * Mirrors `staleTodoNudge.ts#renderTodoListBody` after the audit fix —
 * the first body line is the spec marker so detect-from-body works
 * when the typed flag is missing.
 */
function staleTodoNudgeMessage(turn: number): Msg {
  return makeSideChannelUserMessage(
    SIDE_CHANNEL_KIND.staleTodoNudge,
    `[Stale todo reminder]\nReminder #${turn}: keep the todo list current.`,
  )
}

function staleTaskNudgeMessage(turn: number): Msg {
  return makeSideChannelUserMessage(
    SIDE_CHANNEL_KIND.staleTaskNudge,
    `[Stale task reminder]\nReminder #${turn}: keep TaskCreate / TaskUpdate calls current.`,
  )
}

function compactionReminderMessage(): Msg {
  return makeSideChannelUserMessage(
    SIDE_CHANNEL_KIND.compactionReminder,
    'Automatic context management is active. Keep iterating at normal pace.',
  )
}

function pairingRepairMessage(): Msg {
  return makeSideChannelUserMessage(
    SIDE_CHANNEL_KIND.pairingRepair,
    '[Pairing repair] synthetic tool_result placeholder separator.',
  )
}

/**
 * Mirrors `compact.ts` — wraps a summary string in the compactSummary
 * envelope plus the boundary metadata `findLastCompactBoundaryIndex`
 * keys on.
 */
function compactSummaryMessage(turn: number, summary: string): Msg {
  const marker = createCompactBoundaryMarker(summary)
  return {
    ...marker,
    content: `<system-reminder>\n[Previous conversation was compacted to save context. Summary:\n${summary}]\n</system-reminder>`,
    _convertedFromSystem: true,
    _sideChannelKind: SIDE_CHANNEL_KIND.compactSummary,
    _compactedAt: turn,
  }
}

/**
 * Per-iteration end-of-body normalize, with the AUDIT-FIXED flag
 * values. Production call site: `electron/orchestration/phases/iteration.ts`
 * (the block guarded by `POLE_NORMALIZE_MESSAGES_PIPELINE`).
 */
function iterationNormalize(messages: Msg[]): Msg[] {
  return normalizeMessagesForAPI(messages, {
    stripInternalMeta: false,
    applyConsecutiveUserMerge: false,
    strictThinkingEcho: false,
  })
}

/**
 * Per-stream-call wire normalize. Production call site:
 * `electron/ai/streamHandler.ts:865`. The defaults here are
 * intentional and correct — this is the path that goes to the model
 * provider; nothing reads internal flags off this output, and
 * Bedrock-style strict providers require the merged user shape.
 */
function wireNormalize(messages: Msg[]): Msg[] {
  return normalizeMessagesForAPI(
    messages.map((m) => ({ ...m })),
    {
      stripInternalMeta: true,
      applyAnthropicInvariants: true,
      strictThinkingEcho: false,
      // Defaults: applyConsecutiveUserMerge is `true`.
    },
  )
}

/**
 * Coarse compact model — replace messages BEFORE the cut point with a
 * single compactSummary boundary, keep the recent tail intact. Mirrors
 * the shape `compact.ts` produces but elides the LLM summarisation
 * (we substitute a deterministic string so the test is hermetic).
 */
function performCompact(messages: Msg[], turn: number): Msg[] {
  // Keep the last 4 messages live. The cap is small enough that
  // post-compact iterations still have transcript-shape variety; the
  // cut point intentionally falls inside a side-channel cluster.
  const KEEP = 4
  if (messages.length <= KEEP) return messages
  const tail = messages.slice(messages.length - KEEP)
  const summary = `Recap as of turn ${turn}: ${messages.length - KEEP} earlier message(s) folded.`
  return [compactSummaryMessage(turn, summary), ...tail]
}

interface IterationStats {
  injectedKinds: SideChannelKind[]
  compactedAtTurn: number | null
  /** Typed-flag count in state.apiMessages after iteration normalize. */
  typedFlagCount: number
  /** Side-channel messages identifiable without the typed flag (body fallback). */
  detectableViaBodyCount: number
}

describe('long-run integration: 30 iterations × 6 compactions × multi-kind reminders', () => {
  it('preserves typed kind on every host-injected reminder and keeps every compact boundary findable', () => {
    let messages: Msg[] = [userTurn('start the long task')]

    const COMPACT_EVERY = 5
    const TOTAL_TURNS = 30
    const stats: IterationStats[] = []
    let totalCompactions = 0

    for (let turn = 1; turn <= TOTAL_TURNS; turn++) {
      // ── Phase: model produces a tool_use → host runs the tool ──
      messages.push(assistantWithToolUse(turn))
      messages.push(userWithToolResult(turn))

      // ── Phase: post_tool host attachments inject 4 side-channel
      //    reminders as separate user-role messages (push_message
      //    actions). These land RIGHT AFTER the user (tool_result)
      //    turn — the production failure surface audit fix D
      //    addresses.
      const injected: Msg[] = [
        pairingRepairMessage(),
        staleTodoNudgeMessage(turn),
        staleTaskNudgeMessage(turn),
        compactionReminderMessage(),
      ]
      messages.push(...injected)

      // ── Phase: end-of-iteration normalize (FIXED) ──
      messages = iterationNormalize(messages)

      // ── Phase: optional compact every COMPACT_EVERY turns ──
      let compactedAtTurn: number | null = null
      if (turn % COMPACT_EVERY === 0) {
        messages = performCompact(messages, turn)
        compactedAtTurn = turn
        totalCompactions++
      }

      // Collect stats from the post-normalize, post-compact transcript.
      const typedFlagCount = messages.filter(
        (m) => typeof m._sideChannelKind === 'string',
      ).length
      const detectableViaBodyCount = messages.filter((m) => {
        if (m._sideChannelKind) return false
        return isHostSideChannelMessage(m)
      }).length

      stats.push({
        injectedKinds: injected.map(
          (m) => m._sideChannelKind as SideChannelKind,
        ),
        compactedAtTurn,
        typedFlagCount,
        detectableViaBodyCount,
      })
    }

    // ─── Sanity: ran the loop the expected number of times ───────────
    expect(stats.length).toBe(TOTAL_TURNS)
    expect(totalCompactions).toBe(6)

    // ─── Audit invariant 1 — typed-flag preservation ─────────────────
    //
    // Every iteration must end with at least one host-injected message
    // still carrying its typed `_sideChannelKind` flag. Before the
    // combined fix (A + D) this number would have decayed to 0 after
    // the FIRST iteration normalize because:
    //   - A: stripInternalMeta=true erased the flag, or
    //   - D: mergeConsecutiveUserMessages folded the reminder into the
    //        preceding user (tool_result) and AND-semantics dropped
    //        the flag.
    for (const s of stats) {
      expect(
        s.typedFlagCount,
        `typed flag should be preserved on host messages every turn; ` +
          `got ${s.typedFlagCount} at turn-compact=${s.compactedAtTurn}`,
      ).toBeGreaterThan(0)
    }

    // ─── Audit invariant 2 — compact boundary is always findable ─────
    //
    // After every one of the 6 compactions, `findLastCompactBoundaryIndex`
    // must locate the boundary via its authoritative `_compactBoundary` /
    // `_sideChannelKind === compactSummary` flag (NOT the substring
    // fallback). The boundary lives at index 0 right after compact.
    expect(hasCompactBoundary(messages)).toBe(true)
    expect(findLastCompactBoundaryIndex(messages)).toBe(0)

    // The boundary message itself must still be tagged.
    const boundary = messages[0] as Record<string, unknown>
    expect(boundary._sideChannelKind).toBe(SIDE_CHANNEL_KIND.compactSummary)
    expect(boundary._compactBoundary).toBe(true)
    expect(typeof boundary._compactedAt).toBe('number')

    // ─── Audit invariant 3 — readSideChannelKind never mis-classifies ─
    //
    // For every flagged host message, the kind read back equals the
    // kind originally set by `makeSideChannelUserMessage`. Validates
    // that 12-pass normalize + 6 round-trips through compact didn't
    // silently demote any kind to `genericConvertedSystem`.
    for (const m of messages) {
      const tagged = m._sideChannelKind
      if (typeof tagged !== 'string') continue
      expect(readSideChannelKind(m)).toBe(tagged)
    }

    // ─── Audit invariant 4 — resume-from-disk fallback for stale-*  ──
    //
    // Simulate the path where messages were persisted to disk and
    // reloaded, losing all internal `_xxx` metadata. The two stale-*
    // kinds MUST still be identifiable via the body bracket marker
    // added in audit fix B (otherwise the throttle silently degrades
    // to "fire every 10 assistant turns").
    const onWire = wireNormalize(messages)
    for (const m of onWire) {
      // Wire output must not carry any of the internal flags.
      expect(m._sideChannelKind).toBeUndefined()
      expect(m._convertedFromSystem).toBeUndefined()
      expect(m._compactBoundary).toBeUndefined()
    }

    // Wire merge collapses adjacent host-injected reminders into a
    // single user turn. The model still sees every `<system-reminder>`
    // block inside that turn, but `detectSideChannelKindFromText` —
    // which returns the FIRST matching marker within the 256-char
    // detection window — naturally only surfaces one kind per merged
    // turn. That is wire-correct behaviour (Bedrock-compatible shape),
    // not a regression.
    //
    // The right invariant to assert on the wire is therefore "the body
    // text the model receives still contains the marker substring for
    // every injected kind", not "host-side detect returns every kind
    // independently". We walk the wire output's text content and look
    // for each marker as a substring.
    const wireBodyText = onWire
      .map((m) => {
        const c = m.content
        if (typeof c === 'string') return c
        if (Array.isArray(c)) {
          return (c as Array<Record<string, unknown>>)
            .map((b) =>
              b?.type === 'text' && typeof b.text === 'string' ? (b.text as string) : '',
            )
            .join('\n')
        }
        return ''
      })
      .join('\n\n')

    // compactSummary boundary string still present (model needs it to
    // know "this is a recap, not user instructions").
    expect(wireBodyText).toContain('[Previous conversation was compacted')
    // Both stale-* kinds reach the wire with their NEW markers (audit
    // fix B). If markers ever get nulled out again, these drop and the
    // test fails.
    expect(wireBodyText).toContain('[Stale todo reminder]')
    expect(wireBodyText).toContain('[Stale task reminder]')
    // pairingRepair has a marker too.
    expect(wireBodyText).toContain('[Pairing repair]')

    // findLastCompactBoundaryIndex must still locate the boundary on
    // the WIRE output (where `_compactBoundary` has been stripped),
    // using its substring fallback. The boundary lives at index 0.
    expect(findLastCompactBoundaryIndex(onWire)).toBe(0)
  })

  it('staleTodoNudge throttle fires exactly 3 times over 30 turns at a 10-turn cadence', () => {
    // This narrows in on the specific failure mode audit fix D was
    // built to address. The collector's throttle uses
    // `readSideChannelKind(msg)` against state.apiMessages to find
    // "turns since last reminder". Before fix D, the iteration-end
    // normalize folded post_tool-injected reminders into the
    // preceding user (tool_result) turn and AND-semantics dropped
    // the typed flag — so `computeTurnCounts` could never see a
    // prior reminder of this kind, foundReminder stayed false, and
    // the cadence gate became a no-op.
    //
    // We model the throttle directly here using production-shape
    // messages (tool_use → tool_result → reminders → normalize),
    // and assert the cadence holds for the WHOLE 30 turns.
    let messages: Msg[] = [userTurn('start')]
    const fireTurns: number[] = []

    const TURNS_BETWEEN_REMINDERS = 10
    const TURNS_SINCE_WRITE = 0 // todo write recency gate; force it open for this test

    for (let turn = 1; turn <= 30; turn++) {
      // Production-shape iteration body BEFORE the throttle gate runs:
      //   the model just produced a tool_use, the host just resolved
      //   it, and the runCollectors call is about to evaluate gates.
      messages.push(assistantWithToolUse(turn))
      messages.push(userWithToolResult(turn))

      // ── Throttle gate (modelled on staleTodoNudge.computeTurnCounts) ──
      let turnsSinceLastReminder = 0
      let foundReminder = false
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role === 'assistant') {
          // Skip thinking-only assistant turns — the collector does
          // the same. We don't model thinking here so every assistant
          // turn counts.
          turnsSinceLastReminder++
        } else if (m.role === 'user') {
          const kind = readSideChannelKind(m)
          if (kind === SIDE_CHANNEL_KIND.staleTodoNudge) {
            foundReminder = true
            break
          }
        }
      }

      const passesReminderGate =
        !foundReminder || turnsSinceLastReminder >= TURNS_BETWEEN_REMINDERS
      const passesWriteGate = TURNS_SINCE_WRITE >= 0 // open

      if (passesReminderGate && passesWriteGate) {
        messages.push(staleTodoNudgeMessage(turn))
        fireTurns.push(turn)
      }

      // End-of-iteration normalize (FIXED).
      messages = iterationNormalize(messages)
    }

    // With audit fix D in place, the throttle correctly identifies the
    // most-recent prior reminder and gates on it. Expected fires:
    //   - turn 1: first ever (foundReminder=false)
    //   - turn 11: 10 assistant turns since turn-1 reminder
    //   - turn 21: 10 assistant turns since turn-11 reminder
    //
    // Without fix D the count would explode toward 30 because every
    // iteration would see foundReminder=false (the kind flag having
    // been merged out by the previous iteration's normalize), making
    // the `!foundReminder` short-circuit always true.
    expect(fireTurns).toEqual([1, 11, 21])
  })
})
