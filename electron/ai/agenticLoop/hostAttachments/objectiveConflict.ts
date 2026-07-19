/**
 * Objective-conflict reminder — keeps the recitation loop honest when the
 * user changes direction mid-conversation (2026-07 deep-loop uplift, #12).
 *
 * ## Why
 *
 * Goal recitation (todo list / objective / user-query fallback) re-surfaces
 * the recorded goal at the tail of EVERY request. That is drift protection
 * while the goal is current — and a drift AMPLIFIER the moment it is
 * stale: if the user redirects the task but the model forgets to update
 * the TodoWrite `objective`, the host keeps chanting the OLD goal into
 * recent attention for the rest of the session.
 *
 * This collector fires ONCE per (objective, user-turn) pair when a new
 * genuine user turn shares ZERO informative tokens with the recorded
 * objective — a cheap, deterministic proxy for "the user may have changed
 * direction". The nudge never asserts a conflict; it asks the model to
 * reconcile: update the objective/todos if the direction changed, or
 * simply continue if the new message is part of the same goal.
 *
 * ## Signal quality
 *
 * Zero-overlap on informative tokens (ASCII words ≥ 3 chars + CJK
 * bigrams) is deliberately conservative: any topical continuity ("再改一下
 * parser 的报错" vs objective "重构 parser") shares at least one token and
 * stays silent. Both texts must carry a minimum number of informative
 * tokens so greetings / "继续" / "go on" never trigger.
 *
 * ## Gating
 *
 * - `iteration_top` only, first iteration of a turn (`state.iteration <= 1`).
 * - Main chat only; needs a recorded objective AND ordinary user text.
 * - Once per (conversation, objective-hash, query-hash) — reissuing the
 *   same turn (retry / regenerate) does not double-nudge.
 * - On by default. Disable via `POLE_OBJECTIVE_CONFLICT_NUDGE=0`.
 */

import { createHash } from 'node:crypto'
import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import { getTodoObjective } from '../../../tools/TodoWriteTool'
import { extractCurrentUserQueryText } from '../../../context/anchorUserQuery'
import { looksLikeDirectionChange } from '../../../context/informativeTokens'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'

/** Marker for tests / telemetry greps. */
export const OBJECTIVE_CONFLICT_MARKER = '[Objective check — host reminder]'

const MAX_SCOPE_BUCKETS = 32
const MAX_QUOTED_CHARS = 200

function isEnabled(): boolean {
  const raw = process.env.POLE_OBJECTIVE_CONFLICT_NUDGE?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

// ─── Tokenization (CJK-aware, deterministic) ───────────────────────────
//
// 2026-07 复审 — extracted to `electron/context/informativeTokens.ts` so
// `TodoWriteTool.setTodoObjective` can run the SAME comparison at objective
// WRITE time (cycle-free). Re-exported verbatim to keep this module's
// public test surface stable.
export {
  MIN_INFORMATIVE_TOKENS,
  informativeTokens,
  looksLikeDirectionChange,
} from '../../../context/informativeTokens'

// ─── Once-per-pair latch ────────────────────────────────────────────────

const lastEmittedKeyByScope = new Map<string, string>()

function pairKey(objective: string, query: string): string {
  return createHash('sha256')
    .update(objective)
    .update('\u0000')
    .update(query)
    .digest('hex')
    .slice(0, 16)
}

/** @internal Test-only seam. */
export function __resetObjectiveConflictTrackingForTests(): void {
  lastEmittedKeyByScope.clear()
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= MAX_QUOTED_CHARS ? flat : `${flat.slice(0, MAX_QUOTED_CHARS - 1)}…`
}

export const objectiveConflictCollector: Collector = {
  name: 'objective_conflict',
  callSites: ['iteration_top'],

  async run(ctx) {
    if (!isEnabled()) return null
    const { state } = ctx
    // Only the FIRST iteration of a turn — that's when the fresh user
    // message is the transcript tail and the comparison is meaningful.
    if (state.iteration > 1) return null

    const agentCtx = getAgentContext()
    if ((agentCtx?.agentId ?? 'main') !== 'main') return null

    const objective = getTodoObjective(agentCtx?.agentId ?? 'main')?.trim()
    if (!objective) return null

    const query = extractCurrentUserQueryText(state.apiMessages)?.trim()
    if (!query) return null

    if (!looksLikeDirectionChange(objective, query)) return null

    const scopeKey = agentCtx?.streamConversationId?.trim() || 'main'
    const key = pairKey(objective, query)
    if (lastEmittedKeyByScope.get(scopeKey) === key) return null
    lastEmittedKeyByScope.set(scopeKey, key)
    while (lastEmittedKeyByScope.size > MAX_SCOPE_BUCKETS) {
      const oldest = lastEmittedKeyByScope.keys().next().value
      if (oldest === undefined) break
      lastEmittedKeyByScope.delete(oldest)
    }

    const body =
      `${OBJECTIVE_CONFLICT_MARKER}\n\n` +
      `The user's new message shares no obvious overlap with the recorded objective. ` +
      `This may mean the direction changed — or it may just be a side request.\n\n` +
      `Recorded objective: ${truncate(objective)}\n` +
      `New message: ${truncate(query)}\n\n` +
      `Before diving in: if the user has redirected the task, update the objective and ` +
      `prune stale todos/plan steps (TodoWrite / TaskUpdate) so the host stops reciting ` +
      `the old goal. If this is a side request within the same goal, just handle it — ` +
      `no update needed. Do not treat this reminder as new work.`

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'objective_conflict',
    })

    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      message: {
        role: 'user',
        content: wrapSideChannelBody(SIDE_CHANNEL_KIND.genericConvertedSystem, body),
        _convertedFromSystem: true,
        _sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      },
    }
  },
}
