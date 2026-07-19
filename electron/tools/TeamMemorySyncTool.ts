import { z } from 'zod'
import { runTeamMemorySync } from '../memory/service'
import { buildTool } from './buildTool'
import { validateNoOp } from './toolValidateCommon'

const teamMemorySyncInputZod = z.object({})

export const teamMemorySyncTool = buildTool({
  name: 'TeamMemorySync',
  description:
    'Synchronize project memory with team-shared memory directory. Exports local memories to .claude/team-memory and imports newer team memories back into local memory.',
  inputSchema: [],
  zInputSchema: teamMemorySyncInputZod,
  isReadOnly: false,
  isDestructive: true,
  searchHint: 'team memory export import .claude/team-memory',
  validateInput: validateNoOp,
  async call() {
    const result = runTeamMemorySync()
    if (!result.teamDir) {
      return {
        success: false,
        error: 'No active workspace. Open a project workspace first, then run TeamMemorySync.',
      }
    }

    // Surface blocked-by-secret-guard files in-line so the agent can decide
    // whether to rewrite the offending memory (move the secret out of team
    // scope) on the next turn. Without this the agent sees the export count
    // as if everything went through.
    const blockedSummary =
      result.blockedSecrets.length > 0
        ? `\nBlocked (secret guard): ${result.blockedSecrets
            .map((b) => `${b.filename} — ${b.reason}`)
            .join('; ')}`
        : ''

    return {
      success: true,
      output:
        `Team memory sync complete. Exported: ${result.exported}, ` +
        `Imported: ${result.imported}, Team dir: ${result.teamDir}.` +
        blockedSummary,
    }
  },
})
