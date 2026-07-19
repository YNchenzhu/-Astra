/**
 * Date change collector — upstream parity for `date_change` attachment
 * (`src/utils/attachments.ts#getDateChangeAttachments`,
 *  `src/utils/messages.ts` case `'date_change'`).
 *
 * upstream message:
 *   "The date has changed. Today's date is now {newDate}. DO NOT
 *    mention this to the user explicitly because they are already aware."
 *
 * Long-running sessions can span midnight. The model otherwise keeps
 * thinking it's "today = the date when the conversation started" and
 * answers stale date-relative questions ("when is next Friday?") with
 * wrong dates. This collector fires when the local-ISO date changes
 * vs the last value emitted for the same conversation.
 *
 * ## Cross-iteration state
 *
 * upstream uses bootstrap-state globals (`getLastEmittedDate` /
 * `setLastEmittedDate`) because it's a single-conversation CLI. We
 * have many conversations live at once (multi-agent, multi-window),
 * so the tracking is keyed by `streamConversationId` in a
 * module-level Map. Missing conversation id → fall back to a
 * single global slot (defensive; should never happen in production
 * because the agentic loop always runs inside an AgentContext).
 *
 * ## First-turn handling
 *
 * First time we see a conversation: record the date but emit no
 * attachment (upstream parity — there's no "change" to announce yet).
 *
 * ## Gating
 *
 * - Runs at BOTH `iteration_top` AND `post_tool`. Audit fix R4-L5
 *   (2026-05): the previous `post_tool`-only registration left a
 *   midnight blind spot — a non-agentic turn (user sends a question
 *   that the model answers in pure text without tool calls) that
 *   crosses midnight would never trigger this collector, so the
 *   model kept using the old date until the next user message
 *   happened to land after a tool batch. `iteration_top` fires at
 *   the start of each iteration regardless of whether the previous
 *   turn used tools, plugging the gap. Idempotency is handled by
 *   the `lastEmittedDateByConversation` map (same conv + same date
 *   → no-op), so registering on both sites cannot double-emit.
 * - No env gate by default (small + low-cost notice; safe to always
 *   emit when the date actually changes).
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'

/** Per-conversation last-emitted-date cache. Module-local. */
const lastEmittedDateByConversation = new Map<string, string>()

/** Fallback slot when no `streamConversationId` is available. */
const GLOBAL_KEY = '__global__'

function getLocalISODate(): string {
  // ISO date in local timezone (YYYY-MM-DD).
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** Test seam — drop a single conversation's tracking. */
export function __resetDateChangeStateForTests(conversationId?: string): void {
  if (conversationId) lastEmittedDateByConversation.delete(conversationId)
  else lastEmittedDateByConversation.clear()
}

export const dateChangeCollector: Collector = {
  name: 'date_change',
  // Audit fix R4-L5 — fire at both call sites so a non-agentic
  // response (no tool calls) that spans midnight still gets the
  // date-change notice before the next iteration's model call. Map-
  // based dedup keeps a single emission per date per conversation.
  callSites: ['iteration_top', 'post_tool'],

  async run(ctx) {
    const { state } = ctx
    const convId =
      getAgentContext()?.streamConversationId?.trim() || GLOBAL_KEY

    const currentDate = getLocalISODate()
    const lastDate = lastEmittedDateByConversation.get(convId)

    if (lastDate === undefined) {
      // First observation for this conversation — record but don't
      // emit. Matches upstream's `lastDate === null` branch.
      lastEmittedDateByConversation.set(convId, currentDate)
      return null
    }
    if (currentDate === lastDate) return null

    lastEmittedDateByConversation.set(convId, currentDate)

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'date_change',
      newDate: currentDate,
      previousDate: lastDate,
    })

    const body =
      `The date has changed. Today's date is now ${currentDate}. ` +
      `DO NOT mention this to the user explicitly because they are already aware.`

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
