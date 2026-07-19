/**
 * Context-efficiency collector — informational nudge about transcript
 * growth between host-side compact / snip events.
 *
 * ## Deliberate divergence from upstream
 *
 * upstream's `context_efficiency` attachment instructs the model to
 * "consider using SnipTool to free context" — an action-demanding
 * nudge tied to upstream's model-callable SnipTool. We deliberately
 * do NOT expose a SnipTool (compact is the host's job, not the
 * model's), so an action-demanding nudge would create a direct
 * contradiction with `compactionReminder`'s "no need to rush, the
 * host handles compaction" message.
 *
 * This collector ships as an **informational variant**: it tells
 * the model how much the transcript has grown since the last snip
 * / nudge, and that the host will manage when needed. The model
 * receives the signal but is not asked to act.
 *
 * See `electron/context/snipNudgeTracker.ts` for the state model
 * and growth-threshold gating.
 *
 * ## Gating
 *
 * - **On by default**. Throttled at the tracker layer
 *   (`DEFAULT_GROWTH_THRESHOLD_TOKENS` = 15k; capped at
 *   `DEFAULT_MAX_NUDGES_PER_CONVERSATION` = 5) — silent for most
 *   chats, max 5 short notices for very long sessions. Disable via
 *   `POLE_CONTEXT_EFFICIENCY_NUDGE=0` if any visibility is
 *   unwanted.
 * - `post_tool` call site.
 * - Main chat only.
 * - Skipped when no `streamConversationId` or no `usagePercentOfWindow`
 *   / `estimatedTokens` is available.
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'
import { shouldEmitContextEfficiencyNudge } from '../../../context/snipNudgeTracker'

function isContextEfficiencyNudgeEnabled(): boolean {
  const raw = process.env.POLE_CONTEXT_EFFICIENCY_NUDGE?.trim().toLowerCase()
  // Default-on: only an explicit `0` / `false` / `no` disables.
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

export const contextEfficiencyCollector: Collector = {
  name: 'context_efficiency',
  callSites: ['post_tool'],

  async run(ctx) {
    if (!isContextEfficiencyNudgeEnabled()) return null
    const { state } = ctx

    const agentCtx = getAgentContext()
    const isMainChat = !agentCtx?.agentId || agentCtx.agentId === 'main'
    if (!isMainChat) return null

    const convId = agentCtx?.streamConversationId?.trim()
    if (!convId) return null

    const ctxState = state.loopContextManager.getState()
    const currentTokens = ctxState.estimatedTokens
    if (!Number.isFinite(currentTokens) || currentTokens <= 0) return null

    const payload = shouldEmitContextEfficiencyNudge({
      conversationId: convId,
      currentTokenEstimate: currentTokens,
    })
    if (!payload) return null

    const recentFreedLine = payload.lastSnipFreedTokens > 0
      ? ` (most recent host-side snip freed ~${payload.lastSnipFreedTokens} tokens)`
      : ''
    const body =
      `Context has grown ~${payload.grownTokens} tokens since the last ` +
      `observation${recentFreedLine}. Current estimate: ${payload.currentTokens} tokens. ` +
      `Automatic host-side compaction will manage the window — no action required from you. ` +
      `Continue working at your normal pace.`

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'context_efficiency',
      grownTokens: payload.grownTokens,
      currentTokens: payload.currentTokens,
      nudgeIndex: payload.nudgeIndex,
    })

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
