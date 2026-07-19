/**
 * TaskGetTool — fetch one managed task by id (upstream TaskGet analogue).
 */

import { taskManager, type Task } from './TaskManager'
import { buildTool } from './buildTool'
import { isTodoV2Enabled } from './todoMode'
import { taskGetInputZod } from './toolInputZod'

function formatTaskJson(task: Task | undefined): string {
  if (!task) return ''
  const {
    taskId,
    subject,
    description,
    activeForm,
    status,
    owner,
    source,
    blockedBy,
    metadata,
    createdAt,
    updatedAt,
    startedAt,
    finishedAt,
    error,
    summary,
  } = task
  return JSON.stringify(
    {
      taskId,
      subject,
      description,
      activeForm,
      status,
      owner,
      source,
      blockedBy,
      metadata,
      createdAt,
      updatedAt,
      startedAt,
      finishedAt,
      error,
      summary,
    },
    null,
    2,
  )
}

export const taskGetTool = buildTool({
  name: 'TaskGet',
  zInputSchema: taskGetInputZod,
  // 星构Astra coexist extension: see `todoMode.ts`. Hidden only in
  // the explicit `'v1-only'` deployment mode.
  isEnabled: () => isTodoV2Enabled(),
  description:
    'Get a single managed task by taskId. Returns JSON with status, subject, dependencies, and timestamps.',
  inputSchema: [{ name: 'taskId', type: 'string', description: 'Task id from TaskList / TaskCreate / TaskUpdate', required: true }],
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 100_000,
  async call({ taskId }) {
    const id = String(taskId ?? '').trim()
    if (!id) {
      return { success: false, error: 'taskId is required.' }
    }
    const task = taskManager.getTask(id)
    if (!task) {
      return { success: false, error: `Unknown task: ${id}` }
    }
    return { success: true, output: formatTaskJson(task) }
  },
})
