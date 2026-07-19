/**
 * teamTaskCompletionNotifier — emit a `kind=task_completion` envelope into
 * the team lead's mailbox whenever a task transitions to `completed` or
 * `failed`.
 *
 * S6: cursor-ui-clone already had the `task_completion` Zod schema
 * registered (`teamInterAgentProtocol.ts`) and the `<team-inbox>` digest
 * renderer recognised it (`teamInboxAttachments.ts`'s `renderCompletion`),
 * but **no producer ever wrote one**. The lead therefore had to discover
 * task outcomes through `<peer-dm-summary>` chatter or by polling
 * `TaskList`, which defeats the active-loop notification design.
 *
 * Symmetric counterpart of {@link sendTaskAssignmentNotification}:
 * - assignment flows assigner → new owner (typically lead → teammate)
 * - completion flows worker → lead, so the lead's `<team-inbox>` digest
 *   surfaces a discrete `<task-completion taskId=…>` line per finished
 *   piece of work.
 *
 * Reference implementation: upstream-main does NOT use a dedicated
 * `task_completion` envelope — it folds completion into the teammate's
 * idle notification fields (`completedTaskId` / `completedStatus`). We
 * keep the cursor-ui-clone-native dedicated envelope (richer rendering,
 * survives idle-folding) but follow the same routing rule: target is
 * the lead's mailbox key.
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

export interface SendTaskCompletionNotificationArgs {
  /**
   * Lead mailbox key — typically the team's `leadAgentId` so the digest
   * collector picks it up. Pass the team's `leadAgentId` directly; do
   * NOT use the lead's NAME unless the caller has independently
   * verified that mailbox key works in the current installation.
   */
  toLeadAgentId: string
  /** Task identifier (also written to `detail` for legacy parsers). */
  taskId: string
  /** Optional task subject for richer envelope metadata. */
  taskSubject?: string
  /** Terminal status — passed through into envelope metadata for the digest renderer. */
  status: 'completed' | 'failed'
  /** Optional sender attribution (typically the worker's id). */
  completedBy?: string
  /** Optional sender agentType (e.g. `researcher`, `tester`). */
  completedByAgentType?: string
  /** TeamFile name — required for mailbox routing. */
  teamName: string
  /** Workspace root override; defaults to {@link getWorkspacePath}. */
  workspaceRoot?: string | null
}

export interface TaskCompletionNotificationResult {
  delivered: boolean
  skipReason?: 'flag_off' | 'missing_fields' | 'no_workspace' | 'write_error'
  envelopeLine?: string
}

export async function sendTaskCompletionNotification(
  args: SendTaskCompletionNotificationArgs,
): Promise<TaskCompletionNotificationResult> {
  if (!isTeamActiveLoopEnabled()) {
    return { delivered: false, skipReason: 'flag_off' }
  }

  const toLeadAgentId = args.toLeadAgentId?.trim()
  const taskId = args.taskId?.trim()
  const teamName = args.teamName?.trim()
  if (!toLeadAgentId || !taskId || !teamName) {
    return { delivered: false, skipReason: 'missing_fields' }
  }
  if (args.status !== 'completed' && args.status !== 'failed') {
    return { delivered: false, skipReason: 'missing_fields' }
  }

  const workspaceRoot =
    args.workspaceRoot === null ? null : args.workspaceRoot ?? getWorkspacePath()
  if (!workspaceRoot) {
    return { delivered: false, skipReason: 'no_workspace' }
  }

  const taskSubject = args.taskSubject?.trim() || undefined
  const completedBy = args.completedBy?.trim() || undefined

  const proto: TeamInterAgentMessage = {
    schema: TEAM_INTER_AGENT_SCHEMA,
    kind: 'task_completion',
    detail: taskId,
    ...(completedBy
      ? {
          from: {
            agentId: completedBy,
            ...(args.completedByAgentType
              ? { agentType: args.completedByAgentType }
              : {}),
          },
        }
      : {}),
  }

  // task_completion schema requires `metadata.taskId`. We additionally
  // surface `status` (the renderer in teamInboxAttachments looks for it)
  // and `taskSubject` / `completedBy` for richer digests.
  const metadata: Record<string, unknown> = { taskId, status: args.status }
  if (taskSubject) metadata.taskSubject = taskSubject
  if (completedBy) metadata.completedBy = completedBy

  const protoWithMetadata = {
    ...proto,
    metadata,
  } as TeamInterAgentMessage & { metadata: Record<string, unknown> }

  const envelopeLine = formatTeamMailboxEnvelopeLine({
    from: completedBy || 'system',
    to: toLeadAgentId,
    teamName,
    type: 'task_completion',
    payload: stringifyTeamInterAgentMessage(protoWithMetadata),
    metadata,
  })

  try {
    await appendTeamMailbox(workspaceRoot, teamName, toLeadAgentId, envelopeLine)
    return { delivered: true, envelopeLine }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[teamTaskCompletionNotifier] failed to notify lead "${toLeadAgentId}" about task "${taskId}" (${args.status}) on team "${teamName}": ${msg}`,
    )
    return { delivered: false, skipReason: 'write_error', envelopeLine }
  }
}
