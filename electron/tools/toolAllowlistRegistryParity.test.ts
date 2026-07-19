/**
 * Plan P3 — coordinator runtime allowlist names must resolve to registered tools after init.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getCoordinatorModeAllowedToolNames } from '../agents/types'
import { initAgentTools, toolRegistry } from './registry'
import { registryPrimaryToolName } from './builtinToolAliases'

describe('toolAllowlistRegistryParity', () => {
  beforeEach(() => {
    toolRegistry.unregister('ReadDiagnostics')
    toolRegistry.unregister('SpawnTeammate')
    delete process.env.ASTRA_READ_DIAGNOSTICS
    delete process.env.ASTRA_SPAWN_TEAMMATE
    delete process.env.ASTRA_COORDINATOR_STRICT_OC_TOOLS
    delete process.env.CLAUDE_CODE_COORDINATOR_STRICT_TOOLS
  })

  afterEach(() => {
    toolRegistry.unregister('ReadDiagnostics')
    toolRegistry.unregister('SpawnTeammate')
    delete process.env.ASTRA_READ_DIAGNOSTICS
    delete process.env.ASTRA_SPAWN_TEAMMATE
  })

  it('every getCoordinatorModeAllowedToolNames entry exists on toolRegistry after initAgentTools', () => {
    initAgentTools(undefined, undefined)
    for (const n of getCoordinatorModeAllowedToolNames()) {
      const primary = registryPrimaryToolName(n)
      expect(toolRegistry.has(primary), `allowlist "${n}" -> "${primary}"`).toBe(true)
    }
  })
})
