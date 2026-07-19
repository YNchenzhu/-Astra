/**
 * Agent definition listing delta collector — upstream parity for
 * `agent_listing_delta` attachment
 * (`src/utils/attachments.ts#getAgentListingDeltaAttachment`,
 *  `src/utils/messages.ts` case `'agent_listing_delta'`).
 *
 * ## What it surfaces
 *
 * When the available agent types change mid-conversation (a plugin
 * registers a new agent, a workspace `.md` agent definition is
 * added, an MCP-discovered agent comes online), the model needs to
 * know so it can route work via the `Agent` tool.
 *
 * Today the built-in agent list is compile-time static (see
 * `getBuiltInAgents()`), so this collector is effectively dormant
 * — it surfaces the initial agent list once per conversation, then
 * stays silent unless `bumpAgentDefinitionRevision()` is invoked
 * by a future plugin / MCP / workspace-loader integration.
 *
 * ## Per-conversation snapshot
 *
 * Mirrors the `mcpInstructionsTracker` pattern: a per-conversation
 * `lastSeen` map of `agentType → revisionAtSnapshot`. First call
 * for a conversation surfaces the full agent list; subsequent calls
 * short-circuit when the revision is unchanged.
 *
 * ## Gating
 *
 * - **On by default**. The fast-path (revision unchanged) makes
 *   subsequent iterations cost a single integer compare; only the
 *   first-time observation per conversation duplicates the agent
 *   listing that the system prompt already conveys, and that's
 *   bounded by the built-in agent count. Disable via
 *   `POLE_AGENT_LISTING_DELTA=0` if the duplication is a concern.
 * - `post_tool` call site.
 * - Requires `streamConversationId`.
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import {
  getBuiltInAgents,
} from '../../../agents/builtInAgents'
import {
  getAgentDefinitionRevision,
} from '../../../agents/agentRegistryRevision'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'

function isAgentListingDeltaEnabled(): boolean {
  const raw = process.env.POLE_AGENT_LISTING_DELTA?.trim().toLowerCase()
  // Default-on: only an explicit `0` / `false` / `no` disables.
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

/** Per-conversation snapshot — agent type set + revision at snapshot time. */
interface AgentListingSnapshot {
  readonly revision: number
  readonly agentTypes: ReadonlyArray<string>
}

const lastSeenByConversation = new Map<string, AgentListingSnapshot>()

/** Test seam. */
export function __resetAgentListingSnapshotsForTests(): void {
  lastSeenByConversation.clear()
}

export const agentListingDeltaCollector: Collector = {
  name: 'agent_listing_delta',
  callSites: ['post_tool'],

  async run(ctx) {
    if (!isAgentListingDeltaEnabled()) return null
    const { state } = ctx

    const convId = getAgentContext()?.streamConversationId?.trim()
    if (!convId) return null

    const currentRevision = getAgentDefinitionRevision()
    const last = lastSeenByConversation.get(convId)

    // Fast path: revision unchanged → nothing new to report. Reading
    // the integer is O(1); skipping the agent list walk costs
    // basically nothing.
    if (last && last.revision === currentRevision) return null

    const currentAgents = getBuiltInAgents()
    const currentTypes = currentAgents.map((a) => a.agentType)

    const lastTypeSet = new Set(last?.agentTypes ?? [])
    const currentTypeSet = new Set(currentTypes)

    const added = currentTypes.filter((t) => !lastTypeSet.has(t))
    const removed = (last?.agentTypes ?? []).filter(
      (t) => !currentTypeSet.has(t),
    )

    // Audit fix R2-M6 — suppress the very first observation. The
    // system prompt already lists the full set of available agents at
    // session start; emitting a "newly available" delta on iteration 1
    // would duplicate that list and frame it as a directive ("you
    // should use these"). Snapshot still gets stored so subsequent
    // genuine deltas (plugin install / disable) fire correctly.
    const isFirstObservation = last === undefined
    lastSeenByConversation.set(convId, {
      revision: currentRevision,
      agentTypes: [...currentTypes],
    })
    if (isFirstObservation) return null

    if (added.length === 0 && removed.length === 0) return null

    const sections: string[] = []
    if (added.length > 0) {
      const lines = added
        .map((t) => {
          const def = currentAgents.find((a) => a.agentType === t)
          // Prefer `whenToUse` (the routing sentence) over `capability`
          // when both exist — matches the system-prompt agent listing
          // which surfaces `whenToUse` for the router.
          const desc = def?.whenToUse?.trim() || def?.capability?.trim()
          return desc ? `- ${t} — ${desc}` : `- ${t}`
        })
        .join('\n')
      // Audit fix R2-M6 — informational framing instead of directive
      // ("newly available for the Agent tool" used to read as
      // "you should now use these"). The marker on the first body line
      // tells the model this is a registry-change notification, not a
      // task assignment.
      sections.push(
        `The following agent types became available since the last turn (informational; invoke only if relevant to your current task):\n${lines}`,
      )
    }
    if (removed.length > 0) {
      sections.push(
        `Agent types no longer available:\n${removed.map((t) => `- ${t}`).join('\n')}`,
      )
    }
    // Audit fix R2-M6 — stable bracket marker on the first body line so
    // the model can pattern-match this against the side-channel kinds
    // documentation and treat it as background, not a directive.
    const body = `[Agent registry updated]\n${sections.join('\n\n')}`

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'agent_listing_delta',
      added: added.length,
      removed: removed.length,
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
