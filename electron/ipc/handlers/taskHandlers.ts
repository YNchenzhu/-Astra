/**
 * Background-task IPC handlers.
 *
 *   - `tasks:drain-notifications` consume pending task-completed / failed
 *     summaries as an XML blob the agent can inject on the next round.
 *   - `tasks:get-pill-label`      status-bar pill summary (bg / fg counts).
 *   - `tasks-v2:list`             snapshot the current V2 TaskManager
 *                                 (`TaskCreate` / `TaskUpdate` family) tasks
 *                                 so the renderer can paint without waiting
 *                                 for a lifecycle event.
 *
 * Handlers use `require()` rather than static `import` because the tasks
 * subsystem lives behind the AI stream pipeline and we don't want to pull
 * its module graph into the main entry's eager bundle. Each `require` is
 * scoped to the handler body so the module is only resolved when the
 * corresponding IPC channel fires.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- file-level:
   handlers intentionally lazy-load the tasks module graph per the design
   note above. Flip this to targeted line-disables if a new non-lazy
   require is ever added. */
import type { IpcMain } from 'electron'

export function registerTaskHandlers(ipcMain: IpcMain): void {
  // IPC handler for draining task notifications (called by renderer after tool rounds)
  ipcMain.handle('tasks:drain-notifications', () => {
    const { drainPendingTaskNotifications, hasPendingTaskNotifications } = require('../../tools/tasks/drainNotifications')
    return {
      hasNotifications: hasPendingTaskNotifications(),
      xml: drainPendingTaskNotifications(),
    }
  })

  // IPC handler for getting background task summary (for status bar pill)
  ipcMain.handle('tasks:get-pill-label', () => {
    const { getBackgroundTasks, getForegroundTasks } = require('../../tools/tasks/taskStateManager')
    const { getPillLabel } = require('../../tools/tasks/pillLabel')
    const bgTasks = getBackgroundTasks()
    const fgTasks = getForegroundTasks()
    return {
      pill: getPillLabel(bgTasks),
      backgroundCount: bgTasks.length,
      foregroundCount: fgTasks.length,
    }
  })

  // upstream parity (V2 surface): snapshot of TaskManager-managed tasks
  // so the renderer can paint a TaskListV2 panel without waiting for
  // a lifecycle event. Lifecycle events flow over `ai:stream-event`
  // (see `wireTaskManagerV2LifecycleBridge` in `systemHandlers.ts`).
  // Optional `conversationId` filter keeps the panel scoped to the
  // current chat the way upstream's `getTaskListId()` does.
  ipcMain.handle('tasks-v2:list', (_event, params: unknown) => {
    const { taskManager } = require('../../tools/TaskManager')
    const filterConvId =
      params && typeof params === 'object' &&
      typeof (params as Record<string, unknown>).conversationId === 'string'
        ? ((params as Record<string, string>).conversationId).trim() || undefined
        : undefined
    const all = taskManager.listTasks()
    const scoped = filterConvId
      ? all.filter((t: { conversationId?: string }) => t.conversationId === filterConvId)
      : all
    return { tasks: scoped }
  })
}
