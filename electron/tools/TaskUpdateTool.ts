/**
 * TaskUpdateTool — update an existing managed task (V2 task system).
 *
 * Use TaskCreate for new tasks. This tool still tolerates omitted taskId for
 * backward compatibility, but its prompt-side contract is update-only so
 * models do not invent task IDs before any task exists.
 */

import { taskManager, type TaskStatus } from './TaskManager'
import { taskUpdateInputZod } from './toolInputZod'
import { buildTool } from './buildTool'
import { isTodoV2Enabled } from './todoMode'
import { isResearchPhaseTodoSubject } from './hooks/verificationHook'
import { sendTaskAssignmentNotification } from '../agents/teamTaskAssignmentNotifier'
import { sendTaskCompletionNotification } from '../agents/teamTaskCompletionNotifier'
import { getAgentContext } from '../agents/agentContext'
import { describeVerificationAction } from '../ai/agenticLoop/verificationGate'
import { isTeamActiveLoopEnabled } from '../agents/teamActiveLoopFlag'
import { isCallerLead } from '../agents/teammateIdentity'
import { loadTeamFile } from './TeamCreateTool'
import { getWorkspacePath } from './workspaceState'

export const taskUpdateTool = buildTool({
  name: 'TaskUpdate',
  zInputSchema: taskUpdateInputZod,
  // 星构Astra coexist extension: see `TaskCreateTool.ts` and
  // `todoMode.ts` for the mode gate. Hidden only when the deployment
  // is explicitly set to `'v1-only'`.
  isEnabled: () => isTodoV2Enabled(),
  description:
    'Update an existing managed task by taskId. Use TodoWrite for the ephemeral session checklist (lighter, no persistence) and TaskCreate for a new durable / cross-conversation task. ' +
    'Before calling TaskUpdate, obtain an existing taskId from TaskList or a prior TaskCreate/TaskUpdate result. ' +
    'Supports setting subject, description, status, activeForm, owner, dependencies (blockedBy), and metadata. Set status to "deleted" to remove a task.',
  inputSchema: [
    { name: 'taskId', type: 'string', description: 'Existing task ID to update. Required for normal use; get it from TaskList or a prior create result.' },
    { name: 'task_id', type: 'string', description: 'Snake_case alias for taskId' },
    { name: 'subject', type: 'string', description: 'Task title/summary (imperative form, e.g. "Fix auth bug")' },
    { name: 'title', type: 'string', description: 'Alias for subject when creating a task' },
    { name: 'description', type: 'string', description: 'Detailed task description' },
    { name: 'activeForm', type: 'string', description: 'Present continuous form shown while task is in progress (e.g. "Fixing auth bug")' },
    { name: 'active_form', type: 'string', description: 'Snake_case alias for activeForm' },
    { name: 'status', type: 'string', description: 'Task status', enum: ['pending', 'in_progress', 'completed', 'failed', 'deleted'] },
    { name: 'owner', type: 'string', description: 'Task owner identifier' },
    {
      name: 'source',
      type: 'string',
      description:
        'Task origin: user (default for chat-created tasks), plan, coordinator, system. ' +
        'Background memory extraction skips plan/system. Omit for user.',
    },
    { name: 'addBlockedBy', type: 'string', description: 'Comma-separated task IDs that this task is blocked by' },
    { name: 'add_blocked_by', type: 'string', description: 'Snake_case alias for addBlockedBy' },
    { name: 'metadata', type: 'string', description: 'JSON object or stringified JSON; merged into the task' },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,
  async call({ taskId, subject, description, activeForm, status, owner, source, addBlockedBy, metadata }) {
    // Create mode: no taskId provided
    if (!taskId) {
      if (!subject) {
        return { success: false, error: 'subject is required when creating a new task' }
      }
      const blockedBy = addBlockedBy
        ? addBlockedBy.split(',').map(s => s.trim()).filter(Boolean)
        : undefined

      const allowedSources = new Set(['user', 'plan', 'coordinator', 'system'])
      const raw = source?.trim().toLowerCase()
      const resolvedSource =
        raw && allowedSources.has(raw) ? raw : 'user'

      const task = taskManager.create({
        subject,
        description,
        activeForm,
        owner,
        source: resolvedSource,
        addBlockedBy: blockedBy,
      })
      return {
        success: true,
        output: `Created task ${task.taskId}: ${task.subject} [${task.status}]`,
      }
    }

    // Update mode
    let parsedMetadata: Record<string, unknown> | undefined
    if (metadata) {
      try {
        parsedMetadata = JSON.parse(metadata)
      } catch {
        return { success: false, error: 'metadata must be a valid JSON object' }
      }
    }

    const blockedBy = addBlockedBy
      ? addBlockedBy.split(',').map(s => s.trim()).filter(Boolean)
      : undefined

    const allowedSources = new Set(['user', 'plan', 'coordinator', 'system'])
    const rawSrc = source?.trim().toLowerCase()
    const sourceUpdate =
      rawSrc !== undefined && rawSrc !== ''
        ? allowedSources.has(rawSrc)
          ? rawSrc
          : undefined
        : undefined

    // Team Active Loop (PR-3): snapshot the previous owner BEFORE the
    // update so we can detect a real owner-change and avoid spamming
    // task_assignment notifications when the owner field is touched
    // with the same value it already had.
    const priorOwner = taskManager.getTask(taskId)?.owner

    const result = taskManager.update(taskId, {
      subject,
      description,
      activeForm,
      status: status as TaskStatus | 'deleted' | undefined,
      owner,
      ...(sourceUpdate !== undefined ? { source: sourceUpdate } : {}),
      addBlockedBy: blockedBy,
      metadata: parsedMetadata,
    })

    if (!result.task && status !== 'deleted') {
      return { success: false, error: `Task not found: ${taskId}` }
    }

    if (status === 'deleted') {
      return { success: true, output: `Deleted task ${taskId}` }
    }

    // Team Active Loop (PR-3): notify the new owner via team mailbox when
    // owner is set or changed. Best-effort and gated — see
    // `[ref:upstream:src/tools/TaskUpdateTool/TaskUpdateTool.ts:276-297]`.
    // Wrapped in try/catch so a mailbox write failure can never bubble
    // up and crash the model's tool call.
    if (
      isTeamActiveLoopEnabled() &&
      typeof owner === 'string' &&
      owner.trim() &&
      owner.trim() !== (priorOwner ?? '').trim() &&
      result.task
    ) {
      const ctx = getAgentContext()
      const teamName = ctx?.teamId
      if (teamName && teamName.trim()) {
        try {
          await sendTaskAssignmentNotification({
            toOwner: owner.trim(),
            taskId: result.task.taskId,
            taskSubject: result.task.subject,
            assignedBy: ctx?.agentId,
            assignedByAgentType: ctx?.sessionAgentType,
            teamName: teamName.trim(),
          })
        } catch (err) {
          console.warn(
            `[TaskUpdateTool] task_assignment notify failed for "${owner}" on team "${teamName}":`,
            err instanceof Error ? err.message : err,
          )
        }
      }
    }

    // S6 — Team Active Loop completion notification. upstream-main folds
    // task completion into the worker's idle envelope; we keep our
    // dedicated `task_completion` envelope (already in the protocol +
    // renderer) so the digest surfaces a discrete `<task-completion>`
    // line rather than mixing it into idle noise. Best-effort and
    // flag-gated; the statusChange guard ensures we don't double-emit
    // when the status value didn't actually move (e.g. setting status
    // to its current value, or the deleted-only branch above).
    //
    // Audit fix A2 — when the caller IS the lead (top-level chat
    // session that created the team), suppress the notify. Otherwise
    // the lead would write to its own mailbox and read its own message
    // back through the next `<team-inbox>` digest — pointless noise,
    // and at scale a self-amplifying signal.
    if (
      isTeamActiveLoopEnabled() &&
      result.task &&
      result.statusChange &&
      (result.statusChange.to === 'completed' || result.statusChange.to === 'failed')
    ) {
      const ctx = getAgentContext()
      const teamName = ctx?.teamId?.trim()
      if (teamName && !isCallerLead(ctx, teamName)) {
        try {
          const ws = getWorkspacePath()
          const team = ws ? loadTeamFile(ws, teamName) : null
          const leadAgentId = team?.leadAgentId?.trim()
          if (leadAgentId) {
            await sendTaskCompletionNotification({
              toLeadAgentId: leadAgentId,
              taskId: result.task.taskId,
              taskSubject: result.task.subject,
              status: result.statusChange.to,
              completedBy: ctx?.agentId,
              completedByAgentType: ctx?.sessionAgentType,
              teamName,
            })
          }
        } catch (err) {
          console.warn(
            `[TaskUpdateTool] task_completion notify failed for task "${result.task.taskId}" on team "${teamName}":`,
            err instanceof Error ? err.message : err,
          )
        }
      }
    }

    const statusInfo = result.statusChange ? ` (${result.statusChange.from} → ${result.statusChange.to})` : ''

    // upstream parity (V2): verifier-after-N-completed nudge. upstream
    // does this inline in `TodoWriteTool.call()` when an "allDone"
    // batch with ≥3 items contained no verification step. The V2
    // analog watches per-conversation completion: if ≥3 closed-out
    // (`completed`) tasks in the active conversation have NO
    // verification keyword in their subject AND this latest
    // transition is not research-shaped, append a one-line nudge.
    //
    // No throttling state — the model gets the same hint on each
    // subsequent qualifying completion. 星构Astra's existing
    // `verifyPlanReminderCollector` handles the larger plan-mode
    // story; this nudge is the per-completion micro-cue.
    let nudge = ''
    if (
      result.statusChange?.to === 'completed' &&
      result.task &&
      !isResearchPhaseTodoSubject(result.task.subject)
    ) {
      const convId = getAgentContext()?.streamConversationId?.trim()
      if (convId) {
        const completedInConv = taskManager
          .findByConversation(convId)
          .filter((t) => t.status === 'completed')
        const completedWithoutVerifier = completedInConv.filter(
          (t) => !/verif|test|validate|qa\b/i.test(t.subject),
        )
        const verificationAction =
          completedInConv.length >= 3 && completedWithoutVerifier.length >= 3
            ? describeVerificationAction()
            : null
        if (verificationAction) {
          nudge =
            '\n\nNOTE: You have completed 3+ tasks in this conversation without an explicit verification step. ' +
            `Consider ${verificationAction} before declaring success.`
        }
      }
    }

    return {
      success: true,
      output: `Updated task ${taskId}: [${result.task!.status}] ${result.task!.subject}${statusInfo}${nudge}`,
    }
  },
})
