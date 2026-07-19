/**
 * Plan P1 — env-gated tools register only when enabled (registry + policy parity).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initAgentTools, toolRegistry } from './registry'
import { isRendererToolInvokeAllowed } from '../security/rendererToolPolicy'

describe('optional env tool registration', () => {
  beforeEach(() => {
    toolRegistry.unregister('ReadDiagnostics')
    toolRegistry.unregister('SpawnTeammate')
    delete process.env.ASTRA_READ_DIAGNOSTICS
    delete process.env.ASTRA_SPAWN_TEAMMATE
  })

  afterEach(() => {
    toolRegistry.unregister('ReadDiagnostics')
    toolRegistry.unregister('SpawnTeammate')
    delete process.env.ASTRA_READ_DIAGNOSTICS
    delete process.env.ASTRA_SPAWN_TEAMMATE
  })

  it('does not register ReadDiagnostics or SpawnTeammate without env', () => {
    initAgentTools(undefined, undefined)
    expect(toolRegistry.has('ReadDiagnostics')).toBe(false)
    expect(toolRegistry.has('SpawnTeammate')).toBe(false)
    expect(isRendererToolInvokeAllowed('ReadDiagnostics')).toBe(false)
  })

  it('registers ReadDiagnostics when ASTRA_READ_DIAGNOSTICS=1 and allows renderer invoke', () => {
    process.env.ASTRA_READ_DIAGNOSTICS = '1'
    initAgentTools(undefined, undefined)
    expect(toolRegistry.has('ReadDiagnostics')).toBe(true)
    expect(isRendererToolInvokeAllowed('ReadDiagnostics')).toBe(true)
  })

  it('registers SpawnTeammate when ASTRA_SPAWN_TEAMMATE=1', () => {
    process.env.ASTRA_SPAWN_TEAMMATE = 'true'
    initAgentTools(undefined, undefined)
    expect(toolRegistry.has('SpawnTeammate')).toBe(true)
  })
})
