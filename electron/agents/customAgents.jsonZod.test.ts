import { describe, it, expect, afterEach } from 'vitest'
import {
  parseAgentFromJson,
  isLegacyAgentJsonLoaderEnabled,
} from './customAgents'
import { silenceExpectedConsoleWarn } from '../testHelpers/silenceExpectedConsole'

// Invalid-record tests deliberately trigger the Zod-rejection warn in
// production. Behavior is asserted via return value; the warn is noise.
silenceExpectedConsoleWarn()

describe('parseAgentFromJson', () => {
  const valid = {
    description: 'ok',
    prompt: 'system',
    permissionMode: 'default' as const,
  }

  it('accepts Zod-valid records', () => {
    const a = parseAgentFromJson('v', valid)
    expect(a?.agentType).toBe('v')
    expect(a?.getSystemPrompt()).toBe('system')
  })

  // P1-2 (audit Bug-7 follow-up B7-D) — custom agents declared via JSON
  // can now specify `defaultPriority` to participate in cross-agent
  // priority scheduling. Without this, only built-in agents could declare
  // BACKGROUND priority and user-authored background agents always
  // landed at NORMAL.
  it('accepts defaultPriority and forwards it to the parsed definition', () => {
    const a = parseAgentFromJson('bgworker', {
      ...valid,
      defaultPriority: 10, // ToolPriority.BACKGROUND
    })
    expect(a?.defaultPriority).toBe(10)
  })

  it('omits defaultPriority when not declared', () => {
    const a = parseAgentFromJson('v', valid)
    expect(a?.defaultPriority).toBeUndefined()
  })

  it('rejects negative defaultPriority', () => {
    const prev = process.env.ASTRA_LEGACY_AGENT_JSON
    try {
      delete process.env.ASTRA_LEGACY_AGENT_JSON
      const bad = { ...valid, defaultPriority: -5 }
      expect(parseAgentFromJson('bad', bad)).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.ASTRA_LEGACY_AGENT_JSON
      else process.env.ASTRA_LEGACY_AGENT_JSON = prev
    }
  })

  it('skips invalid records when legacy env is off', () => {
    const prev = process.env.ASTRA_LEGACY_AGENT_JSON
    try {
      delete process.env.ASTRA_LEGACY_AGENT_JSON
      const bad = { ...valid, permissionMode: 'not-valid' }
      expect(parseAgentFromJson('bad', bad)).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.ASTRA_LEGACY_AGENT_JSON
      else process.env.ASTRA_LEGACY_AGENT_JSON = prev
    }
  })

  it('uses legacy parse when Zod fails and ASTRA_LEGACY_AGENT_JSON is set', () => {
    const prev = process.env.ASTRA_LEGACY_AGENT_JSON
    try {
      process.env.ASTRA_LEGACY_AGENT_JSON = '1'
      const bad = { ...valid, permissionMode: 'not-valid' }
      const a = parseAgentFromJson('legacy', bad, { jsonFilePath: '/tmp/agents.json' })
      expect(a?.agentType).toBe('legacy')
      expect(a?.getSystemPrompt()).toBe('system')
    } finally {
      if (prev === undefined) delete process.env.ASTRA_LEGACY_AGENT_JSON
      else process.env.ASTRA_LEGACY_AGENT_JSON = prev
    }
  })
})

describe('isLegacyAgentJsonLoaderEnabled', () => {
  const prev = process.env.ASTRA_LEGACY_AGENT_JSON
  afterEach(() => {
    if (prev === undefined) delete process.env.ASTRA_LEGACY_AGENT_JSON
    else process.env.ASTRA_LEGACY_AGENT_JSON = prev
  })

  it('is false by default', () => {
    delete process.env.ASTRA_LEGACY_AGENT_JSON
    expect(isLegacyAgentJsonLoaderEnabled()).toBe(false)
  })

  it('is true for 1', () => {
    process.env.ASTRA_LEGACY_AGENT_JSON = '1'
    expect(isLegacyAgentJsonLoaderEnabled()).toBe(true)
  })
})
