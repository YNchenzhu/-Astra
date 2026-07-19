/**
 * Team Inbox collector — lead-side digest for the Team Active Loop.
 *
 * Drains the lead's team mailbox (idle_notification / task_assignment /
 * task_completion envelopes) at the post-tool call site, folds same-
 * sender idle entries to the latest, and pushes a `<team-inbox>`
 * side-channel user message so the model perceives the digest as a
 * system observation attached to the just-finished tool batch — same
 * framing as the existing `inter_agent_queue` and `subagent_outputs`
 * collectors.
 *
 * Gates:
 *   - `POLE_TEAM_ACTIVE_LOOP=1`    — global feature flag (see
 *     `teamActiveLoopFlag.ts`)
 *   - main chat only              — sub-agents have their own
 *     `interAgentQueueCollector` path; the lead-side digest is
 *     specifically for the chat that called `TeamCreate`
 *   - `agentCtx.teamId` set        — no team, no digest
 *   - team file loadable + has a `leadAgentId` — otherwise the
 *     mailbox key is unknown
 *
 * Failure isolation: the parent `runCollectors` orchestrator wraps
 * `run` with `maybe()` so a thrown error becomes "no actions" plus a
 * console.warn. We still try/catch the mailbox read so transient disk
 * issues don't even surface as a warn.
 *
 * Reference: upstream-main `src/utils/teammateMailbox.ts:3611-3660`.
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import { isTeamActiveLoopEnabled } from '../../../agents/teamActiveLoopFlag'
import { readAndRenderTeamInbox } from '../../../agents/teamInboxAttachments'
import { loadTeamFile } from '../../../tools/TeamCreateTool'
import { getWorkspacePath } from '../../../tools/workspaceState'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'

export const teamInboxCollector: Collector = {
  name: 'team_inbox',
  callSites: ['post_tool', 'no_tools_continue'],

  async run() {
    if (!isTeamActiveLoopEnabled()) return null

    const agentCtx = getAgentContext()
    // Lead-side digest only — sub-agents drain via interAgentQueueCollector.
    const isMainChat = !agentCtx || agentCtx.agentId === 'main'
    if (!isMainChat) return null

    const teamName = agentCtx?.teamId?.trim()
    if (!teamName) return null

    const workspaceRoot = getWorkspacePath()
    if (!workspaceRoot) return null

    let leadAgentId: string | undefined
    try {
      const team = loadTeamFile(workspaceRoot, teamName)
      leadAgentId = team?.leadAgentId?.trim() || undefined
    } catch {
      /* loadTeamFile is already best-effort but guard anyway */
    }
    if (!leadAgentId) return null

    const xml = await readAndRenderTeamInbox({
      workspaceRoot,
      teamName,
      leadAgentId,
    })
    if (!xml) return null

    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.teamInbox,
      message: {
        role: 'user',
        content: wrapSideChannelBody(SIDE_CHANNEL_KIND.teamInbox, xml),
        _convertedFromSystem: true,
        _sideChannelKind: SIDE_CHANNEL_KIND.teamInbox,
      },
    }
  },
}
