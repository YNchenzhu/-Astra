/**
 * KillAllTasksTool — kill all running tasks (ESC cancel equivalent).
 *
 * Mirrors upstream's Ctrl+B + ESC cancel behavior. Kills all foreground
 * tasks first, then all background tasks, preventing duplicate notifications.
 */

import { killAllTasks, killAllAgentTasks } from './tasks'
import { backgroundAllForegroundTasks, hasForegroundTasks } from './tasks/foregroundTracker'
import { markAgentTasksNotified } from './tasks/AgentTaskManager'
import { markAllShellTasksNotified } from './tasks/ShellTaskManager'
import { buildTool } from './buildTool'
import { killAllTasksInputZod } from './toolInputZod'

export const killAllTasksTool = buildTool({
  name: 'KillAllTasks',
  zInputSchema: killAllTasksInputZod,
  description:
    'Kill all running tasks. Use this when you need to cancel everything ' +
    '(equivalent to pressing ESC in the terminal). Kills foreground tasks first, ' +
    'then background tasks. Suppresses duplicate notifications.',
  inputSchema: [
    {
      name: 'scope',
      type: 'string',
      description: 'What to kill: "all" (default) or "agents" (only agent tasks)',
      enum: ['all', 'agents'],
    },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,
  async call({ scope }) {
    const effectiveScope = scope ?? 'all'

    if (effectiveScope === 'agents') {
      const killed = await killAllAgentTasks()
      return {
        success: true,
        output: `Killed ${killed.length} agent task(s): ${killed.join(', ') || '(none)'}`,
      }
    }

    // Background all foreground tasks first
    let bgCount = 0
    if (hasForegroundTasks()) {
      const ids = backgroundAllForegroundTasks()
      bgCount = ids.length
    }

    // Suppress notifications before bulk kill. Audit fix R6 (2026-05): the
    // shell side used to be missing — agents stayed quiet on bulk kill but
    // shell tasks that completed naturally inside the kill window still
    // emitted `<status>completed</status>` XML the user just asked us to
    // suppress. Mark both sides quiet before dispatching the kill batch.
    markAgentTasksNotified()
    markAllShellTasksNotified()

    // Kill all tasks
    const killed = await killAllTasks()
    const total = bgCount + killed.length

    return {
      success: true,
      output: `Killed all tasks: ${total} total (${bgCount} foreground backgrounded, ${killed.length} killed)`,
    }
  },
})
