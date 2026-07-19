/**
 * Buddy state-change collector — surfaces in-conversation changes
 * to the user's companion (buddy) so the model can acknowledge or
 * adapt.
 *
 * ## Relation to upstream
 *
 * upstream's `companion_intro` attachment introduces the companion
 * once per conversation. Our equivalent extends that pattern: any
 * MEANINGFUL change to the buddy (newly hatched, species changed,
 * name / persona / mood updated, enabled / disabled) surfaces via
 * this collector. The first observation of a conversation also
 * acts as the "intro".
 *
 * The buddy is already declared in the system prompt
 * (`buildBuddySystemPrompt`), so the model has baseline awareness
 * at every turn. This collector exists for **change notification**
 * — system prompt is static within an iteration, but the buddy's
 * state can mutate mid-conversation via UI (hatching, renaming,
 * etc.) and the model needs to acknowledge.
 *
 * ## Per-conversation snapshot
 *
 * Mirrors `agentListingDelta` / `mcpInstructionsDelta`:
 *
 *   - `lastSeenByConversation: Map<convId, revision>`
 *   - Fast path: revision unchanged → no-op
 *   - Slow path: revision changed → emit + update snapshot
 *
 * ## Gating
 *
 * - **On by default**. The fast-path (revision unchanged) is a single
 *   integer compare; the first-time observation per conversation
 *   surfaces buddy identity (matches upstream's `companion_intro`
 *   semantics). Disable via `POLE_BUDDY_STATE_CHANGE=0` if the
 *   intro / change notifications aren't desired.
 * - `post_tool` call site.
 * - Skipped when buddy is disabled (`state.enabled === false`).
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import { getBuddyState } from '../../../buddy/service'
import { getBuddyStateRevision } from '../../../buddy/stateRevision'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'

function isBuddyStateChangeEnabled(): boolean {
  const raw = process.env.POLE_BUDDY_STATE_CHANGE?.trim().toLowerCase()
  // Default-on: only an explicit `0` / `false` / `no` disables.
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

const lastSeenByConversation = new Map<string, number>()

/** Test seam. */
export function __resetBuddyStateChangeSnapshotsForTests(): void {
  lastSeenByConversation.clear()
}

export const buddyStateChangeCollector: Collector = {
  name: 'buddy_state_change',
  callSites: ['post_tool'],

  async run(ctx) {
    if (!isBuddyStateChangeEnabled()) return null
    const { state } = ctx

    const convId = getAgentContext()?.streamConversationId?.trim()
    if (!convId) return null

    let buddy
    try {
      buddy = getBuddyState()
    } catch {
      return null
    }
    if (!buddy?.enabled) return null

    const currentRevision = getBuddyStateRevision()
    const lastRevision = lastSeenByConversation.get(convId)

    if (lastRevision === currentRevision) return null

    // Always advance the snapshot so the next genuine change fires
    // correctly, but suppress the FIRST observation per conversation
    // (audit fix R4-L6, 2026-05). The buddy's name / species /
    // persona is already declared in the system prompt via
    // `buildBuddySystemPrompt`; emitting a "Buddy in this
    // conversation:" introduction on iteration 1 was a duplicate
    // of static identity content, which the model would re-narrate
    // as fresh news (`"Hi, your buddy is X..."`).
    lastSeenByConversation.set(convId, currentRevision)
    const isInitialObservation = lastRevision === undefined
    if (isInitialObservation) return null

    const headline = `Buddy state has changed:`
    const lines = [
      `- Name: ${buddy.name || '(unnamed)'}`,
      `- Species: ${buddy.species || 'unknown'}`,
      buddy.rarity ? `- Rarity: ${buddy.rarity}` : undefined,
      `- Mood: ${buddy.mood || 'neutral'}`,
      buddy.persona ? `- Persona: ${buddy.persona}` : undefined,
    ].filter((s): s is string => !!s)
    const body =
      `${headline}\n${lines.join('\n')}\n\nThis is reference context. ` +
      `Do not address the buddy directly unless the user explicitly engages it.`

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'buddy_state_change',
      isInitialObservation,
      revision: currentRevision,
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
