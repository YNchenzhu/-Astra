/**
 * Sub-agent status digest collector — provides a per-iteration roll-up
 * of currently-running (and recently-terminated, not yet acknowledged)
 * background sub-agents the main chat spawned.
 *
 * ## Why this exists vs `subAgentOutputs`
 *
 * `subAgentOutputs` (also at `post_tool`) splices NEW streamed text /
 * terminal notices into the transcript — content-bearing, one-shot.
 * This collector is a status SNAPSHOT — counts + state + agent type
 * — so the model knows what's still running in the background even
 * when those agents haven't produced new output since last turn.
 *
 * upstream's `unified_tasks` attachment fills the same niche for
 * upstream's task framework. We don't have a separate task
 * framework — sub-agents ARE our tasks — so this collector adapts the
 * same idea against `activeAgentRegistry`.
 *
 * ## Gating
 *
 * - **On by default**. Skipped when no active agents (the common
 *   case in chats that don't spawn sub-agents), so the cost is zero
 *   for most users; chats that DO use sub-agents see a per-iteration
 *   status roll-up. Disable via `POLE_SUB_AGENT_STATUS_DIGEST=0`.
 * - Main chat only — sub-agents themselves shouldn't see sibling
 *   agent rollups (privacy / context bloat).
 * - `post_tool` call site.
 * - Skipped when no active agents.
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import { getActiveAgents } from '../../../agents/activeAgentRegistry'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'

function isSubAgentStatusDigestEnabled(): boolean {
  const raw = process.env.POLE_SUB_AGENT_STATUS_DIGEST?.trim().toLowerCase()
  // Default-on: only an explicit `0` / `false` / `no` disables.
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

const MAX_AGENTS_LISTED = 20

export const subAgentStatusDigestCollector: Collector = {
  name: 'sub_agent_status_digest',
  callSites: ['post_tool', 'no_tools_continue'],

  async run(ctx) {
    if (!isSubAgentStatusDigestEnabled()) return null
    const { state } = ctx

    const agentCtx = getAgentContext()
    const isMainChat = !agentCtx?.agentId || agentCtx.agentId === 'main'
    if (!isMainChat) return null

    const agents = [...getActiveAgents().values()]
    if (agents.length === 0) return null

    // Filter to "interesting" status only — completed/failed are
    // already surfaced via subAgentOutputs once each; the digest
    // focuses on RUNNING agents (which subAgentOutputs ignores until
    // they terminate) plus recent terminal states the parent might
    // not have noticed yet.
    const interesting = agents.filter(
      (a) => a.status === 'running' || a.status === 'failed',
    )
    if (interesting.length === 0) return null

    let running = 0
    let failed = 0
    const lines: string[] = []
    for (const agent of interesting.slice(0, MAX_AGENTS_LISTED)) {
      if (agent.status === 'running') running++
      else failed++
      const label = agent.name || agent.agentType
      const desc = agent.description?.trim()
      const descSuffix = desc ? ` — ${desc.slice(0, 80)}` : ''
      lines.push(`- [${agent.status}] ${label} (${agent.agentType})${descSuffix}`)
    }
    if (interesting.length > MAX_AGENTS_LISTED) {
      lines.push(`… (+${interesting.length - MAX_AGENTS_LISTED} more)`)
    }
    const totals = [
      running > 0 ? `${running} running` : null,
      failed > 0 ? `${failed} failed (unacknowledged)` : null,
    ]
      .filter((s): s is string => !!s)
      .join(', ')
    // Audit fix R2-M4 — first body line is a stable bracket marker so
    // the model treats the block as background, not first-person work.
    // The previous opening line ("Background sub-agents — N running:")
    // could read as a self-narrated working memory ("I have N agents
    // running") and led the model to claim sub-agent progress as its
    // own. The marker + explicit framing make ownership unambiguous.
    const body =
      `[Sub-agent status snapshot — background context, NOT your own work]\n` +
      `The following are independent sub-agents spawned earlier; their progress is not yours to narrate. ` +
      `Totals: ${totals}.\n${lines.join('\n')}`

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'sub_agent_status_digest',
      running,
      failed,
      listed: Math.min(interesting.length, MAX_AGENTS_LISTED),
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
