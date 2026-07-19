/**
 * teamIdleNotifier — writes a `kind=idle_notification` envelope into the
 * team lead's mailbox at the end of every teammate turn so the lead can
 * surface a `<team-inbox>` block on its next user-role attachment.
 *
 * Best-effort by design: failures must NOT propagate into the teammate's
 * main agentic loop. All disk / lookup errors are caught and warned, the
 * teammate then exits as if no idle notifier ran.
 *
 * Reference implementation: upstream-main
 * - `src/utils/swarm/inProcessRunner.ts:1317-1342` (post-turn trigger)
 * - `src/utils/swarm/inProcessRunner.ts:569-588` (createIdleNotification → sendMessageToLeader)
 * - `src/utils/teammateMailbox.ts:410-429` (payload field shapes)
 */

import {
  TEAM_INTER_AGENT_SCHEMA,
  stringifyTeamInterAgentMessage,
  type TeamInterAgentMessage,
} from './teamInterAgentProtocol'
import { appendTeamMailbox } from '../tools/teamMailbox'
import { formatTeamMailboxEnvelopeLine } from '../tools/TeamCreateTool'
import { getWorkspacePath } from '../tools/workspaceState'
import { isTeamActiveLoopEnabled } from './teamActiveLoopFlag'
import { getLastPeerDmSummary, type PeerDmTranscriptEntry } from './peerDmSummary'

/**
 * Idle reasons recognised on the wire.
 *
 * Native (cursor-ui-clone original) values describe what the teammate
 * was doing when its turn ended:
 * - `turn_complete`  — finished a turn and is now waiting (the default).
 * - `no_more_tasks`  — finished a turn AND drained every task it could claim.
 * - `shutdown_pending` — the teammate received `shutdown_request` and is winding down.
 *
 * upstream aliases (S3 alignment) describe lifecycle outcome instead:
 * - `available`   — equivalent to `turn_complete`; teammate is idle and ready to receive work.
 * - `interrupted` — the teammate's turn was aborted (user stop / timeout / abortController).
 * - `failed`     — the teammate's turn threw an unrecoverable error.
 *
 * Both vocabularies are accepted on the protocol so a renderer or
 * downstream consumer may pick whichever it understands. Producers SHOULD
 * prefer the most specific reason that actually applies; pick a upstream
 * alias when modelling lifecycle outcomes (failure / abort) and a native
 * value when modelling work-state (just finished a turn / drained tasks).
 */
export type TeamIdleReason =
  // native values
  | 'turn_complete'
  | 'no_more_tasks'
  | 'shutdown_pending'
  // upstream aliases
  | 'available'
  | 'interrupted'
  | 'failed'

export interface SendTeammateIdleNotificationArgs {
  /** Stable id of the teammate that just finished a turn. */
  teammateAgentId: string
  /** Optional human name (preferred for sender attribution). */
  teammateName?: string
  /** Optional agentType for sender attribution (e.g. `researcher`). */
  teammateAgentType?: string
  /** Routing target — typically `team-lead@<teamName>` or the lead's stable id. */
  leadAgentId: string
  /** Mailbox file key (must match the lead's tracked TeamFile name). */
  teamName: string
  reason: TeamIdleReason
  /**
   * Optional transcript snapshot — used purely to derive `peerDmSummary`.
   * Pass the teammate's last-N messages; large transcripts are fine, the
   * scan is O(messages * content-blocks) with an early-exit on the first
   * qualifying peer DM.
   */
  recentMessages?: ReadonlyArray<PeerDmTranscriptEntry>
  /**
   * Optional list of task ids that this teammate CLAIMED this run.
   * Note: claimed ≠ completed — the teammate may not have called
   * `TaskUpdate(status=completed)` for every claim. The lead should
   * read the surfaced `<claimed-tasks>` block as "in-flight or done by
   * this teammate this run", not as a completion certificate. Audit
   * fix F-01: renamed from `completedTaskIds` which lied about state.
   */
  claimedTaskIds?: ReadonlyArray<string>
  /**
   * Optional override for the workspace root. Defaults to
   * `getWorkspacePath()`; nullable so callers can opt out without
   * branching at every call site.
   */
  workspaceRoot?: string | null
}

export interface TeamIdleNotificationResult {
  /** False when the active-loop flag is off, fields are missing, or write failed. */
  delivered: boolean
  /** Captured failure reason for diagnostics; absent on success. */
  skipReason?: 'flag_off' | 'missing_fields' | 'no_workspace' | 'write_error'
  /** The exact envelope line written (for tests / observability). */
  envelopeLine?: string
}

/**
 * Compose and persist a single `idle_notification` envelope. Returns a
 * result struct instead of throwing so the teammate runner can keep
 * going regardless of feature-flag / configuration state.
 */
export async function sendTeammateIdleNotification(
  args: SendTeammateIdleNotificationArgs,
): Promise<TeamIdleNotificationResult> {
  if (!isTeamActiveLoopEnabled()) {
    return { delivered: false, skipReason: 'flag_off' }
  }

  const teammateAgentId = args.teammateAgentId?.trim()
  const leadAgentId = args.leadAgentId?.trim()
  const teamName = args.teamName?.trim()
  if (!teammateAgentId || !leadAgentId || !teamName) {
    return { delivered: false, skipReason: 'missing_fields' }
  }

  const workspaceRoot =
    args.workspaceRoot === null ? null : args.workspaceRoot ?? getWorkspacePath()
  if (!workspaceRoot) {
    return { delivered: false, skipReason: 'no_workspace' }
  }

  const peerDmSummary =
    args.recentMessages && args.recentMessages.length > 0
      ? getLastPeerDmSummary(args.recentMessages)
      : null

  const claimedTaskIds =
    args.claimedTaskIds && args.claimedTaskIds.length > 0
      ? args.claimedTaskIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
      : undefined

  // The protocol's typed view (`TeamInterAgentMessage`) only models a few
  // hot fields — peerDmSummary / claimedTaskIds ride along via the
  // mailbox envelope's outer `metadata` block, which downstream readers
  // see thanks to the schema's `.passthrough()`.
  const proto: TeamInterAgentMessage = {
    schema: TEAM_INTER_AGENT_SCHEMA,
    kind: 'idle_notification',
    detail: args.reason,
    ...(args.teammateName || args.teammateAgentType
      ? {
          from: {
            agentId: teammateAgentId,
            ...(args.teammateAgentType ? { agentType: args.teammateAgentType } : {}),
          },
        }
      : {}),
  }

  const metadata: Record<string, unknown> = {}
  if (peerDmSummary) metadata.peerDmSummary = peerDmSummary
  if (claimedTaskIds && claimedTaskIds.length > 0) {
    // Audit fix F-01: field name reflects the actual semantic ("tasks
    // this teammate claimed this run") rather than the misleading
    // legacy `completedTaskIds`. The teammate may not have marked
    // every claimed task `completed` yet — the lead should treat this
    // as in-flight or just-finished work, not a completion certificate.
    metadata.claimedTaskIds = claimedTaskIds
  }
  if (args.teammateName) metadata.fromName = args.teammateName

  // Encode the protocol object as the envelope's `payload`. This matches
  // the existing nested-payload shape that `parseTeamInterAgentLine` and
  // `mirrorTeamMailboxToInboxFiles` already understand.
  const envelopeLine = formatTeamMailboxEnvelopeLine({
    from: args.teammateName?.trim() || teammateAgentId,
    to: leadAgentId,
    teamName,
    type: 'idle_notification',
    payload: stringifyTeamInterAgentMessage(proto),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  })

  try {
    await appendTeamMailbox(workspaceRoot, teamName, leadAgentId, envelopeLine)
    return { delivered: true, envelopeLine }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[teamIdleNotifier] failed to write idle_notification for "${teammateAgentId}" → "${leadAgentId}" on team "${teamName}": ${msg}`,
    )
    return { delivered: false, skipReason: 'write_error', envelopeLine }
  }
}
