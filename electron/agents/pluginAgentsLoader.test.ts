import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadBundledPluginAgentsFromWorkspace } from './pluginAgentsLoader'
import type { PluginAgentDefinition } from './types'

describe('loadBundledPluginAgentsFromWorkspace', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-plugin-agents-'))
  })
  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('loads agents.json from plugin .claude/agents', () => {
    const pluginDir = path.join(dir, 'plugins', 'demo')
    const agentsDir = path.join(pluginDir, '.claude', 'agents')
    fs.mkdirSync(agentsDir, { recursive: true })
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'demo-pack' }),
      'utf8',
    )
    fs.writeFileSync(
      path.join(agentsDir, 'agents.json'),
      JSON.stringify({
        'plugin-helper': {
          description: 'helper',
          prompt: 'You are a helper.',
          mcpServers: [{ name: 'srv-a' }],
        },
      }),
      'utf8',
    )

    const list = loadBundledPluginAgentsFromWorkspace(dir)
    const a = list.find((x) => x.agentType === 'plugin-helper') as PluginAgentDefinition | undefined
    expect(a?.source).toBe('plugin')
    expect(a?.pluginName).toBe('demo-pack')
    expect(a?.mcpServers).toEqual([{ name: 'srv-a' }])
  })
})
