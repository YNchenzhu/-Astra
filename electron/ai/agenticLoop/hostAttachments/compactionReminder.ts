/**
 * Compaction reminder collector — upstream parity for
 * `src/utils/messages.ts` case `'compaction_reminder'`:
 *
 *   "Auto-compact is enabled. When the context window is nearly full,
 *    older messages will be automatically summarized so you can
 *    continue working seamlessly. There is no need to stop or rush —
 *    you have unlimited context through automatic compaction."
 *
 * Counters the model's tendency to "rush to wrap up" when it senses
 * context pressure. Replaces (and is the strict-opposite of) the
 * deleted 80%-iteration "wind down" directives that contradicted
 * upstream design.
 *
 * ## Gating contract
 *
 * Fires when ALL of:
 *   - `state.iteration > 1`            — no value firing on turn one
 *   - main chat (`agentId === 'main'`) — sub-agents have their own
 *                                         programmatic budgets
 *   - context usage ≥ 50% of window    — the moment context pressure
 *                                         becomes perceptible
 *   - `!state._compactionReminderInjected` — one-shot per session
 *
 * ## Call-site contract
 *
 * Runs ONLY at `'post_tool'`. The upstream analog runs in
 * `getAttachmentMessages` which is invoked after tool execution
 * (`query.ts` ~line 1580). The model then perceives the reminder as
 * "a system note attached to the just-finished tool batch" rather
 * than "a fresh user instruction appearing mid-conversation".
 *
 * Previously (pre-Phase-A) we injected at iteration top, which made
 * the reminder look like a brand-new user turn — the upstream-aligned
 * position is more semantically honest.
 */

import { getAgentContext } from '../../../agents/agentContext'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'
import type { Collector } from '../hostAttachments'

const REMINDER_BODY =
  'Automatic context management is active. When the context ' +
  'window approaches its limit, older messages are condensed ' +
  'automatically (history snip / micro-compact / auto-compact) ' +
  'so you can keep working without interruption. There is no ' +
  'need to stop, rush, or summarize prematurely — keep ' +
  'iterating on the task at your normal pace.'

/** Trigger threshold expressed as `usagePercentOfWindow` (0..100). */
export const COMPACTION_REMINDER_USAGE_THRESHOLD = 50

export const compactionReminderCollector: Collector = {
  name: 'compaction_reminder',
  callSites: ['post_tool'],

  async run(ctx) {
    const { state } = ctx

    if (state._compactionReminderInjected) return null
    if (state.iteration <= 1) return null

    const agentCtx = getAgentContext()
    const isMainChat = !agentCtx || agentCtx.agentId === 'main'
    if (!isMainChat) return null

    const ctxState = state.loopContextManager.getState()
    const usagePct = ctxState.usagePercentOfWindow ?? 0
    if (usagePct < COMPACTION_REMINDER_USAGE_THRESHOLD) return null

    // Mark as injected BEFORE returning the action so a future retry
    // / re-invocation from another call site (defensive) cannot
    // re-fire. The orchestrator applies actions synchronously after
    // collectors resolve, so this mutation is safe to do here.
    state._compactionReminderInjected = true

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      usagePercentOfWindow: usagePct,
    })

    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.compactionReminder,
      message: {
        role: 'user',
        content: wrapSideChannelBody(
          SIDE_CHANNEL_KIND.compactionReminder,
          REMINDER_BODY,
        ),
        _convertedFromSystem: true,
        _sideChannelKind: SIDE_CHANNEL_KIND.compactionReminder,
      },
    }
  },
}
