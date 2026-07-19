/**
 * TaskCreateTool — upstream TodoV2-style create-only surface (thin wrapper over {@link taskManager}).
 * Prefer {@link taskUpdateTool} for updates; this tool exists for API / allowlist parity with upstream reports.
 */

import { taskManager } from './TaskManager'
import { buildTool } from './buildTool'
import { isTodoV2Enabled } from './todoMode'
import { setTodoObjective } from './TodoWriteTool'
import { taskCreateInputZod } from './toolInputZod'
import { getAgentContext } from '../agents/agentContext'

export const taskCreateTool = buildTool({
  name: 'TaskCreate',
  zInputSchema: taskCreateInputZod,
  // 星构Astra coexist extension: V2 Task* and V1 TodoWrite are
  // simultaneously available by default. See `todoMode.ts`. The mode
  // gate still lets users force `'v2-only'` (this returns true) or
  // `'v1-only'` (this returns false, tool disappears from `getAll()`).
  isEnabled: () => isTodoV2Enabled(),
  description:
    'Create a new managed task (durable / cross-conversation). Requires subject. Optional description, activeForm, owner, source, status, addBlockedBy. ' +
    'Use this for work that should persist across sessions, has dependencies (blockedBy), or may be claimed by another agent — the task is written to disk and survives restarts. ' +
    'For an ephemeral within-conversation checklist that disappears when the task ends, use TodoWrite instead — it is lighter, shows live in the user\'s task panel, and does NOT persist. ' +
    'To update an existing managed task, use TaskUpdate with a real taskId from TaskList or a prior create result.',
  inputSchema: [
    { name: 'subject', type: 'string', description: 'Task title (imperative form)', required: true },
    { name: 'description', type: 'string', description: 'Detailed description' },
    { name: 'activeForm', type: 'string', description: 'Present continuous label while in progress' },
    { name: 'owner', type: 'string', description: 'Owner identifier' },
    {
      name: 'source',
      type: 'string',
      description: 'Origin: user | plan | coordinator | system (default user)',
      enum: ['user', 'plan', 'coordinator', 'system'],
    },
    {
      name: 'status',
      type: 'string',
      description: 'Initial status: pending | in_progress | completed | failed | cancelled (default pending)',
      enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled'],
    },
    { name: 'addBlockedBy', type: 'string', description: 'Comma-separated task IDs this task is blocked by' },
    {
      name: 'objective',
      type: 'string',
      description:
        "One sentence stating the user's UNDERLYING OBJECTIVE — the *why* / the outcome that makes this work a success, NOT a restatement of the subject. Re-surfaced during long runs to keep deep intent in focus.",
      required: false,
    },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,
  maxResultChars: 8_000,
  async call({ subject, description, activeForm, owner, source, status, addBlockedBy, objective }, ctx) {
    const subjectStr = String(subject ?? '').trim()
    if (!subjectStr) {
      return { success: false, error: 'subject is required.' }
    }
    // P2-V2: record the objective into the shared store so goal recitation
    // can re-surface it in V2 / v2-only flows (no V1 todo list to anchor it).
    if (typeof objective === 'string' && objective.trim()) {
      setTodoObjective(ctx?.agentId, objective)
    }
    const blockedBy = addBlockedBy
      ? addBlockedBy.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined
    const allowed = new Set(['user', 'plan', 'coordinator', 'system'])
    const raw = source?.trim().toLowerCase()
    const resolvedSource =
      raw && allowed.has(raw) ? (raw as 'user' | 'plan' | 'coordinator' | 'system') : 'user'

    // Bind the task to the active conversation so the stale-task nudge (and
    // any other conversation-scoped reader) only surfaces it to THIS chat,
    // not to every parallel conversation (audit F-16). Falls back to
    // unscoped when there's no conversation context (headless / tests),
    // which the nudge treats as a workspace-global task.
    const conversationId = getAgentContext()?.streamConversationId?.trim() || undefined

    const task = taskManager.create({
      subject: subjectStr,
      description,
      activeForm,
      owner,
      source: resolvedSource,
      status,
      addBlockedBy: blockedBy,
      ...(conversationId ? { conversationId } : {}),
    })
    return {
      success: true,
      output: `Created task ${task.taskId}: ${task.subject} [${task.status}]`,
    }
  },
})
