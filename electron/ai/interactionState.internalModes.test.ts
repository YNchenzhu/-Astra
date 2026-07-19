import { afterEach, describe, expect, it } from 'vitest'
import { runWithAgentContext, type AgentContext } from '../agents/agentContext'
import type { ProviderConfig } from './client'
import { getPermissionMode, setPermissionMode } from './interactionState'

describe('interactionState internal permission modes', () => {
  afterEach(() => {
    setPermissionMode('default')
  })

  it('bubble maps to default for getPermissionMode()', () => {
    setPermissionMode('bubble')
    expect(getPermissionMode()).toBe('default')
  })

  it('uses AgentContext.permissionModeOverride inside ALS (report §3.1)', () => {
    setPermissionMode('default')
    const cfg: ProviderConfig = { id: 'anthropic', name: 't', apiKey: '' }
    const ctx: AgentContext = {
      config: cfg,
      model: 'm',
      systemPrompt: '',
      messages: [],
      signal: new AbortController().signal,
      agentId: 'als-perm-test',
      permissionModeOverride: 'plan',
    }
    runWithAgentContext(ctx, () => {
      expect(getPermissionMode()).toBe('plan')
    })
    expect(getPermissionMode()).toBe('default')
  })
})
