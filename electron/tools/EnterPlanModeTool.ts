import { setPermissionMode } from '../ai/interactionState'
import { enterPlanModeInputZod } from './toolInputZod'
import { buildTool } from './buildTool'

export const enterPlanModeTool = buildTool({
  name: 'EnterPlanMode',
  description:
    'Requests permission to enter plan mode for complex tasks requiring exploration and design.',
  inputSchema: [],
  zInputSchema: enterPlanModeInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call() {
    setPermissionMode('plan')
    return {
      success: true,
      output:
        'Entered plan mode. Focus on read-only exploration and design. Use ExitPlanMode when ready for user approval to implement.',
    }
  },
})
