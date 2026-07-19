/**
 * teamTaskAssignmentNotifier — emit a `kind=task_assignment` envelope into
 * the new owner's team mailbox whenever a task's `owner` is set or changed.
 *
 * Symmetric counterpart of {@link sendTeammateIdleNotification}: idle
 * notifications flow teammate → lead; assignment notifications flow
 * (typically) lead → teammate. Same envelope shape, same best-effort
 * error handling.
 *
 * Reference implementation: upstream-main
 * `src/tools/TaskUpdateTool/TaskUpdateTool.ts:276-297` — original site
 * that turned a passive "owner field write" into a wake-up signal so the
 * recipient doesn't have to poll the task list.
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

export interface SendTaskAssignmentNotificationArgs {
  /** New owner name / id — also used as the mailbox file key. */
  toOwner: string
  /** Task identifier (also goes into `detail` for legacy parsers). */
  taskId: string
  /** Optional task subject for richer envelope metadata. */
  taskSubject?: string
  /** Optional sender attribution (typically the calling agent's id). */
  assignedBy?: string
  /** Optional sender agentType (e.g. `team-lead`, `coordinator`). */
  assignedByAgentType?: string
  /** TeamFile name — required for mailbox routing. */
  teamName: string
  /** Workspace root override; defaults to {@link getWorkspacePath}. */
  workspaceRoot?: string | null
}

export interface TaskAssignmentNotificationResult {
  delivered: boolean
  skipReason?: 'flag_off' | 'missing_fields' | 'no_workspace' | 'write_error'
  envelopeLine?: string
}

export async function sendTaskAssignmentNotification(
  args: SendTaskAssignmentNotificationArgs,
): Promise<TaskAssignmentNotificationResult> {
  if (!isTeamActiveLoopEnabled()) {
    return { delivered: false, skipReason: 'flag_off' }
  }

  const toOwner = args.toOwner?.trim()
  const taskId = args.taskId?.trim()
  const teamName = args.teamName?.trim()
  if (!toOwner || !taskId || !teamName) {
    return { delivered: false, skipReason: 'missing_fields' }
  }

  const workspaceRoot =
    args.workspaceRoot === null ? null : args.workspaceRoot ?? getWorkspacePath()
  if (!workspaceRoot) {
    return { delivered: false, skipReason: 'no_workspace' }
  }

  const taskSubject = args.taskSubject?.trim() || undefined
  const assignedBy = args.assignedBy?.trim() || undefined

  const proto: TeamInterAgentMessage = {
    schema: TEAM_INTER_AGENT_SCHEMA,
    kind: 'task_assignment',
    detail: taskId,
    ...(assignedBy
      ? {
          from: {
            agentId: assignedBy,
            ...(args.assignedByAgentType ? { agentType: args.assignedByAgentType } : {}),
          },
        }
      : {}),
  }

  // task_assignment schema requires `metadata.taskId`. Per the schema
  // we also surface `taskSubject` and `assignedBy` for receivers that
  // want them — these survive the round-trip thanks to `passthrough()`.
  const metadata: Record<string, unknown> = { taskId }
  if (taskSubject) metadata.taskSubject = taskSubject
  if (assignedBy) metadata.assignedBy = assignedBy

  const protoWithMetadata = {
    ...proto,
    metadata,
  } as TeamInterAgentMessage & { metadata: Record<string, unknown> }

  const envelopeLine = formatTeamMailboxEnvelopeLine({
    from: assignedBy || 'system',
    to: toOwner,
    teamName,
    type: 'task_assignment',
    payload: stringifyTeamInterAgentMessage(protoWithMetadata),
    metadata,
  })

  try {
    await appendTeamMailbox(workspaceRoot, teamName, toOwner, envelopeLine)
    return { delivered: true, envelopeLine }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[teamTaskAssignmentNotifier] failed to notify owner "${toOwner}" about task "${taskId}" on team "${teamName}": ${msg}`,
    )
    return { delivered: false, skipReason: 'write_error', envelopeLine }
  }
}
