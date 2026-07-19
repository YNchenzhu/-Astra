/**
 * TaskListTool — list all managed tasks (V2 task system).
 *
 * Returns all tasks with their ID, status, subject, and relationships.
 * Also shows background tasks and pill label for status bar.
 */

import { taskManager } from './TaskManager'
import { getBackgroundTasks, getAllTaskStates } from './tasks/taskStateManager'
import { getPillLabel } from './tasks/pillLabel'
import { emptyToolInputZod } from './toolInputZod'
import { buildTool } from './buildTool'
import { isTodoV2Enabled } from './todoMode'

export const taskListTool = buildTool({
  name: 'TaskList',
  zInputSchema: emptyToolInputZod,
  // 星构Astra coexist extension: see `todoMode.ts`. Hidden only in
  // the explicit `'v1-only'` deployment mode.
  isEnabled: () => isTodoV2Enabled(),
  description:
    'List all managed tasks. Returns task ID, subject, status, owner, and dependency info. ' +
    'Also shows background task summary and status bar pill label. ' +
    'Use this to understand current task state before making updates.',
  inputSchema: [],
  isReadOnly: true,
  isConcurrencySafe: true,
  async call() {
    const tasks = taskManager.listTasks()

    // Also include background tasks from the state manager
    const bgTasks = getBackgroundTasks()
    const allStates = getAllTaskStates()
    const pill = getPillLabel(bgTasks)

    if (tasks.length === 0 && allStates.length === 0) {
      return { success: true, output: 'No tasks. Use TaskCreate to create a managed task, or TodoWrite for your session checklist.' }
    }

    const lines: string[] = []

    // V2 managed tasks
    if (tasks.length > 0) {
      lines.push('Managed tasks:')
      for (const t of tasks) {
        lines.push(
          `  [${t.status.toUpperCase()}] ${t.taskId}: ${t.subject}${t.activeForm && t.status === 'in_progress' ? ` (${t.activeForm})` : ''}${t.blockedBy.length > 0 ? ` blockedBy: ${t.blockedBy.join(',')}` : ''}`,
        )
      }
      lines.push('')
    }

    // Background tasks from state manager
    if (bgTasks.length > 0) {
      lines.push(`Background tasks (${bgTasks.length}):`)
      for (const t of bgTasks) {
        const label = t.isBackgrounded ? 'BG' : 'FG'
        lines.push(`  [${label} ${t.status}] ${t.id} (${t.type}): ${t.description}`)
      }
      lines.push('')
    }

    // Pill label for status bar
    if (pill.label) {
      lines.push(`Status bar: ${pill.label}${pill.needsCta ? ' (down arrow to view)' : ''}`)
    }

    return { success: true, output: lines.join('\n') }
  },
})
