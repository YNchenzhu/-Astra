/**
 * Token usage collector — upstream parity for `token_usage` attachment
 * (`src/utils/attachments.ts#getTokenUsageAttachment`,
 *  `src/utils/messages.ts` case `'token_usage'`).
 *
 * upstream message format:
 *   "Token usage: {used}/{total}; {remaining} remaining"
 *
 * Surfaces the current context-window utilisation to the model so it
 * can make informed decisions about how much output to produce / when
 * to summarise. Especially useful in long agentic sessions where the
 * model's own context-pressure intuition diverges from reality.
 *
 * ## Gating
 *
 * **On by default**. Disable via `POLE_TOKEN_USAGE_ATTACHMENT=0`.
 *
 * Caveat: this collector emits on EVERY post_tool boundary where
 * `usagePercentOfWindow > 0`, so long sessions accumulate many
 * notices. upstream's equivalent has the same property — they opted
 * in via env; we ship default-on to surface usage proactively. If
 * the volume becomes a problem in practice, add a per-conversation
 * "only emit when usagePct moved by ≥N%" throttle in a follow-up
 * (the snipNudgeTracker pattern is a ready template).
 *
 * Main-chat only (sub-agents have their own per-budget reporting).
 *
 * ## Data sources
 *
 * - `used`: `state.loopContextManager.getState().estimatedTokens` —
 *   the same number the auto-compact pipeline uses for its threshold
 *   decisions. Single source of truth.
 * - `total`: same getter's `usagePercentOfWindow` field combined
 *   with `estimatedTokens` to derive the effective window — or
 *   re-derived if unavailable. Defaults to a safe sentinel rather
 *   than a fake number.
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'

/** Env flag — feature is ON by default; only an explicit `0` disables. */
function isTokenUsageAttachmentEnabled(): boolean {
  const raw = process.env.POLE_TOKEN_USAGE_ATTACHMENT?.trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

/**
 * Audit fix R4-L4 (2026-05) — per-conversation delta throttle so
 * long sessions don't accumulate 20-30 near-identical "Token usage:
 * X/Y" notices across N silent post_tool boundaries. Emit only when
 * the usage-percent delta moves by at least {@link TOKEN_USAGE_DELTA_PCT}
 * vs the last emission, OR when this conversation has never seen one
 * (first-emission always fires so the model has the baseline).
 */
const TOKEN_USAGE_DELTA_PCT = 5
const LAST_EMITTED_PCT_BY_CONV = new Map<string, number>()
const LAST_EMITTED_PCT_MAX_BUCKETS = 32

function recordLastEmittedPct(convId: string, pct: number): void {
  if (LAST_EMITTED_PCT_BY_CONV.delete(convId)) {
    LAST_EMITTED_PCT_BY_CONV.set(convId, pct)
    return
  }
  LAST_EMITTED_PCT_BY_CONV.set(convId, pct)
  while (LAST_EMITTED_PCT_BY_CONV.size > LAST_EMITTED_PCT_MAX_BUCKETS) {
    const oldest = LAST_EMITTED_PCT_BY_CONV.keys().next().value
    if (oldest === undefined || oldest === convId) break
    LAST_EMITTED_PCT_BY_CONV.delete(oldest)
  }
}

/** @internal Test-only seam. */
export function __resetTokenUsageThrottleForTests(): void {
  LAST_EMITTED_PCT_BY_CONV.clear()
}

export const tokenUsageCollector: Collector = {
  name: 'token_usage',
  callSites: ['post_tool'],

  async run(ctx) {
    if (!isTokenUsageAttachmentEnabled()) return null
    const { state } = ctx

    const agentCtx = getAgentContext()
    const isMainChat = !agentCtx?.agentId || agentCtx.agentId === 'main'
    if (!isMainChat) return null

    const ctxState = state.loopContextManager.getState()
    const used = ctxState.estimatedTokens
    const usagePct = ctxState.usagePercentOfWindow
    if (!Number.isFinite(used) || used <= 0) return null
    if (usagePct === undefined || usagePct <= 0) return null

    // Audit fix R4-L4 — delta throttle. Skip when we already emitted
    // at a nearby percent for this conversation. First emission per
    // conv always passes (no prior bookkeeping).
    const convId = agentCtx?.streamConversationId?.trim()
    if (convId) {
      const lastPct = LAST_EMITTED_PCT_BY_CONV.get(convId)
      if (lastPct !== undefined && Math.abs(usagePct - lastPct) < TOKEN_USAGE_DELTA_PCT) {
        return null
      }
      recordLastEmittedPct(convId, usagePct)
    }

    // Derive the effective window from estimatedTokens + usagePct:
    //   usagePct = used / total * 100  →  total = used * 100 / usagePct
    const total = Math.round((used * 100) / usagePct)
    const remaining = Math.max(0, total - used)

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'token_usage',
      used,
      total,
      remaining,
    })

    const body = `Token usage: ${used}/${total}; ${remaining} remaining`

    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      message: {
        role: 'user',
        content: wrapSideChannelBody(
          SIDE_CHANNEL_KIND.genericConvertedSystem,
          body,
        ),
        _convertedFromSystem: true,
        _sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      },
    }
  },
}
