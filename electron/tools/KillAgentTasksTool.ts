/**
 * KillAgentTasksTool — kill all tasks for a specific agent.
 *
 * Mirrors upstream's killShellTasksForAgent pattern. Prevents zombie
 * processes when an agent exits without cleaning up.
 */

import { killTasksByAgent } from './tasks/taskDispatcher'
import { killShellTasksForAgent } from './tasks/ShellTaskManager'
import { buildTool } from './buildTool'
import { killAgentTasksInputZod } from './toolInputZod'
import { asAgentId } from './ids'

export const killAgentTasksTool = buildTool({
  name: 'KillAgentTasks',
  zInputSchema: killAgentTasksInputZod,
  description:
    'Kill all running tasks for a specific agent ID. Use this when an agent ' +
    'has exited or failed, to clean up any remaining shell processes or sub-tasks.',
  inputSchema: [
    { name: 'agentId', type: 'string', description: 'Agent ID to kill tasks for', required: true },
    {
      name: 'scope',
      type: 'string',
      description: 'What to kill: "all" (default) or "shells" (only shell tasks)',
      enum: ['all', 'shells'],
    },
  ],
  isReadOnly: false,
  isConcurrencySafe: false,
  async call({ agentId, scope }) {
    if (!agentId) {
      return { success: false, error: 'agentId is required' }
    }

    const id = asAgentId(agentId)

    if (scope === 'shells') {
      const killed = await killShellTasksForAgent(id)
      return {
        success: true,
        output: `Killed ${killed.length} shell task(s) for agent ${id}`,
      }
    }

    const killed = await killTasksByAgent(id)
    return {
      success: true,
      output: `Killed ${killed.length} task(s) for agent ${id}: ${killed.join(', ') || '(none)'}`,
    }
  },
})
