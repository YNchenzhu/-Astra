/**
 * Pending tool-use summary collector — consumes the haiku-generated
 * recap of the PREVIOUS iteration's tool batch and folds it into the
 * current iteration's tail user message.
 *
 * ## upstream parity (with intentional divergence)
 *
 * upstream (`src/query.ts` ~line 1054) yields the summary as a stream
 * event (UI-only — model never sees it). We inject into `apiMessages`
 * instead.
 *
 * 2026-06 long-run hallucination fix: the producing haiku call is now
 * OPT-IN (`POLE_TOOL_USE_SUMMARY=1`, see `toolExec.ts`), so by default
 * `state.pendingToolUseSummary` stays `null` and this collector no-ops.
 * Rationale: each injected recap is a host-authored past-tense
 * completion claim ("Fixed X") — accumulated over long runs they prime
 * the model to emit premature completion text before invoking tools.
 * The collector itself stays registered for the opt-in path.
 *
 * ## Call-site contract
 *
 * `iteration_top` ONLY. The summary is kicked off by
 * `executeToolBatch` at the end of iteration N (haiku is fire-and-
 * forget, ~1s typical). It's awaited / consumed at the TOP of
 * iteration N+1 — i.e. before iteration N+1's `executeToolBatch`
 * starts a NEW haiku and clobbers `state.pendingToolUseSummary`. If
 * we tried to consume at `post_tool` of the SAME iteration we'd race
 * the just-started haiku for iteration N+1's tools and consume an
 * incomplete promise.
 *
 * The 2s timeout matches the pre-migration behaviour — if haiku
 * hasn't settled within 2s of the next iteration starting, we drop
 * the summary rather than block the loop.
 */

import type { Collector } from '../hostAttachments'
import { formatToolUseSummaryForInjection } from '../../toolUseSummary'
import type { ToolUseSummaryResult } from '../../toolUseSummary'
import {
  SIDE_CHANNEL_KIND,
  makeSideChannelUserMessage,
} from '../../../constants/sideChannelKinds'

const AWAIT_TIMEOUT_MS = 2000

export const pendingToolUseSummaryCollector: Collector = {
  name: 'pending_tool_use_summary',
  callSites: ['iteration_top'],

  async run(ctx) {
    const { state } = ctx
    const pending = state.pendingToolUseSummary
    if (!pending) return null

    // Take the promise OUT of state before awaiting so a thrown
    // race or a no-op timeout cannot result in double-consumption
    // on the next iteration.
    state.pendingToolUseSummary = null

    let resolved: ToolUseSummaryResult | null
    try {
      resolved = await Promise.race<ToolUseSummaryResult | null>([
        pending as Promise<ToolUseSummaryResult | null>,
        new Promise<null>((r) => setTimeout(() => r(null), AWAIT_TIMEOUT_MS)),
      ])
    } catch {
      // Haiku itself threw — silently drop. Telemetry already captured
      // it inside `generateToolUseSummary`.
      return null
    }
    if (!resolved) return null

    const summaryText = formatToolUseSummaryForInjection(
      resolved,
      state.config.id,
    )
    if (!summaryText.trim()) return null

    // Audit fix R4-L7 (2026-05): emit as a standalone side-channel
    // user message instead of `concat_to_last_user`. The earlier mode
    // appended the haiku-generated recap to the END of whatever the
    // last user message was — which in practice is OFTEN the human's
    // actual prompt text, since the iteration-top call site runs
    // before any new user-meta has been pushed for the current
    // iteration. The model then reads the recap as if it were part
    // of what the human typed. Wrapping in the canonical
    // `<system-reminder>` / `toolUseSummary` envelope (via
    // {@link makeSideChannelUserMessage}) preserves the recap's
    // existing marker (`[Previous tool execution summary ...]`) so
    // smoosh/dedup/normalize keep working.
    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.toolUseSummary,
      message: makeSideChannelUserMessage(
        SIDE_CHANNEL_KIND.toolUseSummary,
        summaryText,
      ),
    }
  },
}
