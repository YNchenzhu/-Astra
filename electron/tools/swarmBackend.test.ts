import { describe, it, expect, afterEach } from 'vitest'
import {
  detectSwarmBackend,
  isExternalSwarmBackendAvailable,
  buildTeamSwarmMetadata,
} from './swarmBackend'

describe('swarmBackend (AC-7.2)', () => {
  afterEach(() => {
    delete process.env.ASTRA_SWARM_FORCE_BACKEND
  })

  it('defaults to in-process on win32', () => {
    if (process.platform !== 'win32') return
    expect(detectSwarmBackend()).toBe('in-process')
    expect(isExternalSwarmBackendAvailable()).toBe(false)
  })

  it('ASTRA_SWARM_FORCE_BACKEND overrides detection', () => {
    process.env.ASTRA_SWARM_FORCE_BACKEND = 'tmux'
    expect(detectSwarmBackend()).toBe('tmux')
    expect(isExternalSwarmBackendAvailable()).toBe(true)
    process.env.ASTRA_SWARM_FORCE_BACKEND = 'in-process'
    expect(detectSwarmBackend()).toBe('in-process')
  })

  it('buildTeamSwarmMetadata returns team file path', () => {
    process.env.ASTRA_SWARM_FORCE_BACKEND = 'in-process'
    const m = buildTeamSwarmMetadata('/ws', 'my-team')
    expect(m.swarmBackend).toBe('in-process')
    expect(m.teamFilePath).toContain('my-team')
    expect(m.teamFilePath).toContain('.claude')
    expect(m.teamFilePath).toContain('teams')
  })
})
