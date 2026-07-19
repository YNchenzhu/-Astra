import { describe, it, expect } from 'vitest'
import { getBuiltInAgents, GENERAL_PURPOSE_AGENT } from './builtInAgents'
import {
  mergeLayeredAgentDefinitions,
  resolveAgentDefinitionForResume,
  loadPolicyAgentsFromEnv,
  loadPluginAgentsFromEnv,
} from './agentDefinitionsMerge'
import type { CustomAgentDefinition, PluginAgentDefinition } from './types'

describe('mergeLayeredAgentDefinitions', () => {
  it('lets project disk override user disk for the same agentType', () => {
    const user: CustomAgentDefinition[] = [
      {
        source: 'custom',
        agentType: 'dup',
        whenToUse: 'user',
        getSystemPrompt: () => 'user-prompt',
      },
    ]
    const project: CustomAgentDefinition[] = [
      {
        source: 'custom',
        agentType: 'dup',
        whenToUse: 'project',
        getSystemPrompt: () => 'project-prompt',
      },
    ]
    const merged = mergeLayeredAgentDefinitions({
      builtIn: getBuiltInAgents(),
      pluginEnv: [],
      pluginDisk: [],
      userDisk: user,
      projectDisk: project,
      renderer: [],
      flagEnv: [],
      policyEnv: [],
    })
    expect(merged.find((a) => a.agentType === 'dup')?.getSystemPrompt()).toBe('project-prompt')
  })

  it('does not let renderer replace a built-in type', () => {
    const renderer: CustomAgentDefinition[] = [
      {
        source: 'custom',
        agentType: 'Explore',
        whenToUse: 'fake',
        getSystemPrompt: () => 'should-not-win',
      },
    ]
    const merged = mergeLayeredAgentDefinitions({
      builtIn: getBuiltInAgents(),
      pluginEnv: [],
      pluginDisk: [],
      userDisk: [],
      projectDisk: [],
      renderer,
      flagEnv: [],
      policyEnv: [],
    })
    expect(merged.find((a) => a.agentType === 'Explore')?.source).toBe('built-in')
  })

  it('lets policy env override built-in Explore', () => {
    const prev = process.env.ASTRA_POLICY_AGENTS_JSON
    try {
      process.env.ASTRA_POLICY_AGENTS_JSON = JSON.stringify({
        Explore: {
          description: 'policy explore',
          prompt: 'policy-prompt-body',
          tools: ['read_file'],
        },
      })

      const merged = mergeLayeredAgentDefinitions({
        builtIn: getBuiltInAgents(),
        pluginEnv: [],
        pluginDisk: [],
        userDisk: [],
        projectDisk: [],
        renderer: [],
        flagEnv: [],
        policyEnv: loadPolicyAgentsFromEnv(),
      })
      const explore = merged.find((a) => a.agentType === 'Explore')
      expect(explore?.source).toBe('custom')
      expect(explore?.getSystemPrompt()).toBe('policy-prompt-body')
    } finally {
      if (prev === undefined) delete process.env.ASTRA_POLICY_AGENTS_JSON
      else process.env.ASTRA_POLICY_AGENTS_JSON = prev
    }
  })

  it('merges plugin env agents with source plugin', () => {
    const prev = process.env.ASTRA_PLUGIN_AGENTS_JSON
    try {
      process.env.ASTRA_PLUGIN_AGENTS_JSON = JSON.stringify({
        'plugin-worker': {
          description: 'from plugin',
          prompt: 'plugin system',
          pluginName: 'demo-plugin',
        },
      })

      const pluginEnv = loadPluginAgentsFromEnv()
      const p = pluginEnv[0] as PluginAgentDefinition
      expect(p?.source).toBe('plugin')
      expect(p?.pluginName).toBe('demo-plugin')

      const merged = mergeLayeredAgentDefinitions({
        builtIn: getBuiltInAgents(),
        pluginEnv,
        pluginDisk: [],
        userDisk: [],
        projectDisk: [],
        renderer: [],
        flagEnv: [],
        policyEnv: [],
      })
      expect(merged.some((a) => a.agentType === 'plugin-worker')).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.ASTRA_PLUGIN_AGENTS_JSON
      else process.env.ASTRA_PLUGIN_AGENTS_JSON = prev
    }
  })

  it('lets pluginDisk override pluginEnv for the same agentType', () => {
    const envPlugin = {
      source: 'plugin' as const,
      pluginName: 'env',
      agentType: 'dup-plugin',
      whenToUse: 'env',
      getSystemPrompt: () => 'env-prompt',
    }
    const diskPlugin = {
      source: 'plugin' as const,
      pluginName: 'disk',
      agentType: 'dup-plugin',
      whenToUse: 'disk',
      getSystemPrompt: () => 'disk-prompt',
    }
    const merged = mergeLayeredAgentDefinitions({
      builtIn: getBuiltInAgents(),
      pluginEnv: [envPlugin],
      pluginDisk: [diskPlugin],
      userDisk: [],
      projectDisk: [],
      renderer: [],
      flagEnv: [],
      policyEnv: [],
    })
    const row = merged.find((a) => a.agentType === 'dup-plugin')
    expect(row?.getSystemPrompt()).toBe('disk-prompt')
    expect((row as PluginAgentDefinition).pluginName).toBe('disk')
  })
})

describe('resolveAgentDefinitionForResume', () => {
  it('falls back to built-in general-purpose when type is missing', () => {
    const agents = [GENERAL_PURPOSE_AGENT]
    const r = resolveAgentDefinitionForResume('deleted-custom', agents)
    expect(r?.agentType).toBe('general-purpose')
  })

  it('prefers built-in general-purpose over a custom same-type shadow (§2.5 resume)', () => {
    const customGp: CustomAgentDefinition = {
      source: 'custom',
      agentType: 'general-purpose',
      whenToUse: 'shadow',
      getSystemPrompt: () => 'shadow-prompt',
    }
    const agents = [GENERAL_PURPOSE_AGENT, customGp]
    const r = resolveAgentDefinitionForResume('deleted-type', agents)
    expect(r?.source).toBe('built-in')
    expect(r?.getSystemPrompt()).not.toBe('shadow-prompt')
  })
})
