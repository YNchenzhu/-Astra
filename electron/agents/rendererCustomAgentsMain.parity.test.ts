/**
 * Gap 3 coverage — renderer custom-agent snapshot parses every field that
 * filesystem agents can declare. This guards against future UI shape drift
 * silently dropping advanced fields like `hooks`, `isReadOnly`, `parentPolicy`.
 */

import { describe, it, expect } from 'vitest'
import { parseRendererCustomAgentsPayload } from './rendererCustomAgentsMain'

const BASE = {
  id: 'renderer-0',
  name: 'reviewer',
  description: 'Review code quality',
  prompt: 'You are a code reviewer.',
}

describe('parseRendererCustomAgentsPayload — Gap 3 field parity', () => {
  it('round-trips all core Claude Code fields', () => {
    const [out] = parseRendererCustomAgentsPayload([
      {
        ...BASE,
        whenToUse: 'Use when reviewing a PR',
        capability: '扫描安全与性能问题',
        tools: ['read_file', 'grep'],
        disallowedTools: ['bash'],
        model: 'sonnet',
        maxTurns: 15,
        timeout: 300_000,
        thinkingBudgetTokens: 32_000,
        mcpServers: ['my-mcp'],
        skills: ['code-review'],
        effort: 'high',
        permissionMode: 'plan',
        initialPrompt: 'Start with a diff summary.',
        memory: 'project',
        isolation: 'worktree',
        omitClaudeMd: true,
        background: false,
        color: '#ff6b6b',
      },
    ])
    expect(out).toMatchObject({
      whenToUse: 'Use when reviewing a PR',
      capability: '扫描安全与性能问题',
      model: 'sonnet',
      maxTurns: 15,
      timeout: 300_000,
      thinkingBudgetTokens: 32_000,
      mcpServers: ['my-mcp'],
      skills: ['code-review'],
      effort: 'high',
      permissionMode: 'plan',
      initialPrompt: 'Start with a diff summary.',
      memory: 'project',
      isolation: 'worktree',
      omitClaudeMd: true,
      background: false,
      color: '#ff6b6b',
    })
    expect(out.tools).toEqual(['read_file', 'grep'])
    expect(out.disallowedTools).toEqual(['bash'])
  })

  it('accepts the parity extensions added by Gap 3', () => {
    const [out] = parseRendererCustomAgentsPayload([
      {
        ...BASE,
        hooks: '[{"event":"PreToolUse","matcher":"Bash","command":"echo guard"}]',
        isReadOnly: true,
        maxTokenBudget: 200_000,
        parentPolicy: 'restricted',
        subagentToolProfile: 'async_agent',
        criticalReminder: 'NEVER modify files in this agent.',
      },
    ])
    expect(out.hooks).toBe(
      '[{"event":"PreToolUse","matcher":"Bash","command":"echo guard"}]',
    )
    expect(out.isReadOnly).toBe(true)
    expect(out.maxTokenBudget).toBe(200_000)
    expect(out.parentPolicy).toBe('restricted')
    expect(out.subagentToolProfile).toBe('async_agent')
    expect(out.criticalReminder).toBe('NEVER modify files in this agent.')
  })

  it('rejects invalid enum values for parentPolicy / subagentToolProfile', () => {
    const [out] = parseRendererCustomAgentsPayload([
      {
        ...BASE,
        parentPolicy: 'unknown-mode',
        subagentToolProfile: 'not-a-real-profile',
      },
    ])
    expect(out.parentPolicy).toBeUndefined()
    expect(out.subagentToolProfile).toBeUndefined()
  })

  it('accepts hooks as an array form too (UI may store either shape)', () => {
    const [out] = parseRendererCustomAgentsPayload([
      {
        ...BASE,
        hooks: [
          { event: 'PreToolUse', matcher: 'Bash', command: 'echo one' },
          { event: 'PostToolUse', matcher: 'Edit', command: 'echo two' },
        ],
      },
    ])
    expect(Array.isArray(out.hooks)).toBe(true)
    expect((out.hooks as unknown[]).length).toBe(2)
  })

  it('skips items missing name or prompt', () => {
    const out = parseRendererCustomAgentsPayload([
      { ...BASE, name: '' }, // no name
      { ...BASE, prompt: '' }, // no prompt
      BASE, // valid
    ])
    expect(out.map((s) => s.name)).toEqual(['reviewer'])
  })

  it('trims capability + whenToUse / drops empty strings', () => {
    const [out] = parseRendererCustomAgentsPayload([
      { ...BASE, capability: '   ', whenToUse: '   ' },
    ])
    expect(out.capability).toBeUndefined()
    expect(out.whenToUse).toBeUndefined()
  })
})
