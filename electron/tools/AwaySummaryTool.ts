import { z } from 'zod'
import { getCurrentSession } from '../session/service'
import { buildAwaySummary } from '../services/AwaySummaryService'
import { buildTool } from './buildTool'
import { validateNoOp } from './toolValidateCommon'

const awaySummaryInputZod = z.object({})

export const awaySummaryTool = buildTool({
  name: 'AwaySummary',
  description:
    'Generate a concise away summary of current session progress: pending tasks, touched files, recent errors, and latest activity.',
  inputSchema: [],
  zInputSchema: awaySummaryInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: 'session summary progress away status',
  validateInput: validateNoOp,
  async call() {
    const note = getCurrentSession()
    const summary = buildAwaySummary(note)
    return { success: true, output: summary }
  },
})
