/**
 * Gap 4 coverage — agent listing in the Agent tool prompt surfaces:
 *   - `whenToUse` + `capability` together so the router sees both the
 *     routing sentence AND the concrete capability bullet;
 *   - `isReadOnly` / `model=` / `background-friendly` flags so the router
 *     can condition its choice on execution-shape hints.
 */

import { describe, it, expect } from 'vitest'
import { getAgentToolPrompt } from './agentPrompt'
import type { AgentDefinitionUnion, CustomAgentDefinition } from './types'

const baseCustom = (overrides: Partial<CustomAgentDefinition>): CustomAgentDefinition => ({
  source: 'custom',
  agentType: 'tmp-agent',
  whenToUse: 'Use for small, fast tasks',
  getSystemPrompt: () => 'You are a specialised agent.',
  ...overrides,
})

describe('getAgentToolPrompt — Gap 4 listing signals', () => {
  it('combines whenToUse and capability with an em-dash separator', () => {
    const agents: AgentDefinitionUnion[] = [
      baseCustom({
        agentType: 'sec-reviewer',
        whenToUse: 'Use for security review of code changes',
        capability: 'Scans for OWASP-top-10 issues and bad crypto defaults',
      }),
    ]
    const prompt = getAgentToolPrompt(agents)
    expect(prompt).toContain('- sec-reviewer:')
    expect(prompt).toContain('Use for security review of code changes')
    expect(prompt).toContain('— Scans for OWASP-top-10 issues and bad crypto defaults')
  })

  it('falls back to whenToUse alone when capability is empty', () => {
    const agents: AgentDefinitionUnion[] = [
      baseCustom({
        agentType: 'plain',
        whenToUse: 'Use for plain tasks',
      }),
    ]
    const prompt = getAgentToolPrompt(agents)
    expect(prompt).toContain('- plain: Use for plain tasks')
    expect(prompt).not.toContain('— —')
  })

  it('falls back to capability alone when whenToUse is empty', () => {
    const agents: AgentDefinitionUnion[] = [
      baseCustom({
        agentType: 'cap-only',
        whenToUse: '',
        capability: 'Only a capability',
      }),
    ]
    const prompt = getAgentToolPrompt(agents)
    expect(prompt).toContain('- cap-only: Only a capability')
  })

  it('renders the [read-only] flag when AgentDefinition.isReadOnly is true', () => {
    const agents: AgentDefinitionUnion[] = [
      baseCustom({
        agentType: 'readonly-ex',
        whenToUse: 'Read-only exploration',
        isReadOnly: true,
      }),
    ]
    const prompt = getAgentToolPrompt(agents)
    expect(prompt).toMatch(/readonly-ex:.*\[read-only\]/)
  })

  it('renders a model= hint when AgentDefinition declares a non-inherit model', () => {
    const agents: AgentDefinitionUnion[] = [
      baseCustom({
        agentType: 'opus-only',
        whenToUse: 'Deep reasoning only',
        model: 'opus',
      }),
    ]
    const prompt = getAgentToolPrompt(agents)
    expect(prompt).toContain('model=opus')
  })

  it('does NOT render model= hint when model is "inherit" or omitted', () => {
    const agents: AgentDefinitionUnion[] = [
      baseCustom({ agentType: 'inherit-mod', model: 'inherit' }),
      baseCustom({ agentType: 'omit-mod' }),
    ]
    const prompt = getAgentToolPrompt(agents)
    expect(prompt).not.toContain('model=inherit')
    expect(prompt).not.toMatch(/omit-mod.*\[model=/)
  })

  it('renders the background-friendly flag when AgentDefinition.background is true', () => {
    const agents: AgentDefinitionUnion[] = [
      baseCustom({
        agentType: 'bg-ok',
        whenToUse: 'Long-running background tasks',
        background: true,
      }),
    ]
    const prompt = getAgentToolPrompt(agents)
    expect(prompt).toContain('background-friendly')
  })

  it('combines multiple flags inside a single brackets group', () => {
    const agents: AgentDefinitionUnion[] = [
      baseCustom({
        agentType: 'complex',
        isReadOnly: true,
        background: true,
        model: 'haiku',
      }),
    ]
    const prompt = getAgentToolPrompt(agents)
    const line = prompt
      .split('\n')
      .find((l) => l.includes('- complex:')) ?? ''
    expect(line).toContain('[read-only, model=haiku, background-friendly]')
  })
})
