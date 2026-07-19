import { describe, it, expect } from 'vitest'
import {
  resolveSubAgentPermissionOverride,
  OPENCLAUDE_BACKGROUND_SUBAGENT_TIMEOUT_MS,
} from './resolveSubAgentPermissionOverride'
import type { BuiltInAgentDefinition } from './types'

function mockDef(
  partial: Partial<BuiltInAgentDefinition> & Pick<BuiltInAgentDefinition, 'agentType' | 'getSystemPrompt'>,
): BuiltInAgentDefinition {
  return {
    source: 'built-in',
    whenToUse: 'test',
    getSystemPrompt: partial.getSystemPrompt ?? (() => 'x'),
    agentType: partial.agentType,
    ...partial,
  }
}

describe('resolveSubAgentPermissionOverride', () => {
  it('background without permissionMode uses dontAsk', () => {
    const o = resolveSubAgentPermissionOverride({
      agentDef: mockDef({ agentType: 'Explore', getSystemPrompt: () => '' }),
      runInBackground: true,
      parentEffectiveMode: 'default',
    })
    expect(o).toBe('dontAsk')
  })

  it('background with bubble inherits parent mode', () => {
    const o = resolveSubAgentPermissionOverride({
      agentDef: mockDef({
        agentType: 'Explore',
        getSystemPrompt: () => '',
        permissionMode: 'bubble',
      }),
      runInBackground: true,
      parentEffectiveMode: 'acceptEdits',
    })
    expect(o).toBe('acceptEdits')
  })

  it('foreground with explicit mode uses it', () => {
    const o = resolveSubAgentPermissionOverride({
      agentDef: mockDef({
        agentType: 'Explore',
        getSystemPrompt: () => '',
        permissionMode: 'plan',
      }),
      runInBackground: false,
      parentEffectiveMode: 'default',
    })
    expect(o).toBe('plan')
  })

  it('foreground without permissionMode returns undefined when not async_agent profile', () => {
    const o = resolveSubAgentPermissionOverride({
      agentDef: mockDef({ agentType: 'Debug', getSystemPrompt: () => '' }),
      runInBackground: false,
      parentEffectiveMode: 'default',
    })
    expect(o).toBeUndefined()
  })

  it('foreground async_agent with permissionMode default uses dontAsk (§3.2)', () => {
    const o = resolveSubAgentPermissionOverride({
      agentDef: mockDef({
        agentType: 'Explore',
        getSystemPrompt: () => '',
        subagentToolProfile: 'async_agent',
        permissionMode: 'default',
      }),
      runInBackground: false,
      parentEffectiveMode: 'default',
    })
    expect(o).toBe('dontAsk')
  })

  it('background async_agent with permissionMode default uses dontAsk', () => {
    const o = resolveSubAgentPermissionOverride({
      agentDef: mockDef({
        agentType: 'Explore',
        getSystemPrompt: () => '',
        subagentToolProfile: 'async_agent',
        permissionMode: 'default',
      }),
      runInBackground: true,
      parentEffectiveMode: 'acceptEdits',
    })
    expect(o).toBe('dontAsk')
  })

  it('foreground bubble uses parent snapshot', () => {
    const o = resolveSubAgentPermissionOverride({
      agentDef: mockDef({
        agentType: 'Explore',
        getSystemPrompt: () => '',
        permissionMode: 'bubble',
      }),
      runInBackground: false,
      parentEffectiveMode: 'dontAsk',
    })
    expect(o).toBe('dontAsk')
  })

  it('foreground with permissionMode default + parentPolicy inherit inherits parent mode', () => {
    const o = resolveSubAgentPermissionOverride({
      agentDef: mockDef({
        agentType: 'general-purpose',
        getSystemPrompt: () => '',
        permissionMode: 'default',
        parentPolicy: 'inherit',
      }),
      runInBackground: false,
      parentEffectiveMode: 'bypassPermissions',
    })
    expect(o).toBe('bypassPermissions')
  })

  it('foreground with permissionMode default + parentPolicy restricted returns default (no inherit)', () => {
    const o = resolveSubAgentPermissionOverride({
      agentDef: mockDef({
        agentType: 'general-purpose',
        getSystemPrompt: () => '',
        permissionMode: 'default',
        parentPolicy: 'restricted',
      }),
      runInBackground: false,
      parentEffectiveMode: 'bypassPermissions',
    })
    expect(o).toBe('default')
  })
})

describe('OPENCLAUDE_BACKGROUND_SUBAGENT_TIMEOUT_MS', () => {
  it('is 1800 seconds (30 minutes)', () => {
    expect(OPENCLAUDE_BACKGROUND_SUBAGENT_TIMEOUT_MS).toBe(1_800_000)
  })
})
