import { describe, it, expect } from 'vitest'
import { runWithAgentContext } from './agentContext'
import { resolveSubAgentPermissionOverride } from './resolveSubAgentPermissionOverride'
import {
  buildForkedMessages,
  FORK_BOILERPLATE_FLAG,
  FORK_BOILERPLATE_TAG,
  FORK_SUBAGENT_MAX_ITERATIONS,
  FORK_SUBAGENT_TIMEOUT_MS,
  MAX_FORKED_MESSAGES,
} from './forkSubagent'
import { FORK_AGENT } from './builtInAgents'
import type { ProviderConfig } from '../ai/client'
import type { AgentContext } from './agentContext'

const baseConfig = { id: 'anthropic' as const, name: 'a', apiKey: '' } satisfies ProviderConfig

function withCtx<T>(messages: AgentContext['messages'], fn: () => T): T {
  const ctx: AgentContext = {
    config: baseConfig,
    model: 'm',
    systemPrompt: 'sys',
    messages,
    signal: new AbortController().signal,
    agentId: 'parent',
  }
  return runWithAgentContext(ctx, fn)
}

describe('forkSubagent', () => {
  it('exports fork child max iterations (报告 §3.3)', () => {
    expect(FORK_SUBAGENT_MAX_ITERATIONS).toBe(200)
  })

  it('FORK_SUBAGENT_TIMEOUT_MS is 30 minutes (overrides background default)', () => {
    expect(FORK_SUBAGENT_TIMEOUT_MS).toBe(30 * 60 * 1000)
  })

  it('FORK_AGENT carries explicit timeout so background runs use the fork-specific budget', () => {
    // Without `timeout` set on the agent definition, `agentTool.ts` would
    // inject the global `OPENCLAUDE_BACKGROUND_SUBAGENT_TIMEOUT_MS` for any
    // `run_in_background: true` fork. The explicit field lets fork agents
    // declare their own budget independent of the global default — kept
    // as a separate constant so changes to one don't silently move the other.
    expect(FORK_AGENT.timeout).toBe(FORK_SUBAGENT_TIMEOUT_MS)
  })

  it('fork-style general-purpose + bubble inherits parent permission (§3.2 / §3.3)', () => {
    const o = resolveSubAgentPermissionOverride({
      agentDef: {
        source: 'built-in',
        agentType: 'fork',
        whenToUse: 't',
        getSystemPrompt: () => '',
        permissionMode: 'bubble',
      },
      runInBackground: false,
      parentEffectiveMode: 'plan',
    })
    expect(o).toBe('plan')
  })

  it('rejects when parent messages are empty', () => {
    const r = withCtx([], () => buildForkedMessages('do thing'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/non-empty parent/)
  })

  it('injects boilerplate and child directives before the fork prompt', () => {
    const r = withCtx([{ role: 'user', content: 'hello' }], () =>
      buildForkedMessages('Audit the repo'),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const last = r.messages[r.messages.length - 1] as { role: string; content: string }
    expect(last.role).toBe('user')
    expect(last.content).toContain(FORK_BOILERPLATE_TAG)
    expect(last.content).toMatch(/Do not fork again/)
    expect(last.content).toContain('Audit the repo')
  })

  it('rejects recursive fork when boilerplate already present', () => {
    const r = withCtx(
      [
        { role: 'user', content: 'hi' },
        {
          role: 'user',
          content: `${FORK_BOILERPLATE_TAG}\ninner\n</fork-boilerplate>`,
          [FORK_BOILERPLATE_FLAG]: true,
        },
      ],
      () => buildForkedMessages('nested'),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Recursive fork/)
  })

  it('Bug F-1 regression: does NOT reject when content contains <fork-boilerplate> literal but no flag', () => {
    // Simulates the real failure: a parent agent reads `forkSubagent.ts` (or any
    // file/tool result) whose content literally contains the string
    // `<fork-boilerplate>`. The OLD substring check tripped here and rejected
    // the legitimate fork. The flag-based check must NOT trip.
    const r = withCtx(
      [
        { role: 'user', content: 'Create FORK integration tests' },
        {
          role: 'assistant',
          content: 'Looking at the source...',
        },
        {
          // tool_result-style content carrying the literal tag string
          role: 'user',
          content:
            'File contents:\nexport const FORK_BOILERPLATE_TAG = "<fork-boilerplate>"\n// ...',
        },
      ],
      () => buildForkedMessages('Create the integration test file'),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const last = r.messages[r.messages.length - 1] as Record<string, unknown>
    expect(last[FORK_BOILERPLATE_FLAG]).toBe(true)
  })

  it('truncates very long parent history', () => {
    const many: Array<Record<string, unknown>> = []
    for (let i = 0; i < MAX_FORKED_MESSAGES + 20; i++) {
      many.push({ role: 'user', content: `m${i}` })
    }
    const r = withCtx(many, () => buildForkedMessages('tail task'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.messages.length).toBeLessThan(many.length + 1)
    expect(r.messages.some((m) => JSON.stringify(m).includes('truncated'))).toBe(true)
  })

  it('after truncation keeps early parent messages (head preserved)', () => {
    const many: Array<Record<string, unknown>> = []
    for (let i = 0; i < MAX_FORKED_MESSAGES + 5; i++) {
      many.push({ role: 'user', content: `head-${i}` })
    }
    const r = withCtx(many, () => buildForkedMessages('directive'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const joined = r.messages.map((m) => JSON.stringify(m)).join('\n')
    expect(joined).toContain('head-0')
    expect(joined).toContain('directive')
  })

  describe('Bug A-1: parent-only system-reminder noise filtering', () => {
    it('strips _convertedFromSystem user messages from inherited transcript', () => {
      const r = withCtx(
        [
          { role: 'user', content: 'real user request' },
          { role: 'assistant', content: 'working on it' },
          {
            role: 'user',
            content:
              '<system-reminder>\nPROTOCOL VIOLATION: You stated a result claim before executing tools.\n</system-reminder>',
            _convertedFromSystem: true,
          },
          {
            role: 'user',
            content:
              '<system-reminder>\n[Background sub-agents — new output since your last reply]\n…\n</system-reminder>',
            _convertedFromSystem: true,
          },
          { role: 'assistant', content: 'continuing' },
        ],
        () => buildForkedMessages('audit the repo'),
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const joined = r.messages.map((m) => JSON.stringify(m)).join('\n')
      expect(joined).not.toContain('PROTOCOL VIOLATION')
      expect(joined).not.toContain('Background sub-agents')
      // Real user content + fork directive should still survive.
      expect(joined).toContain('real user request')
      expect(joined).toContain('audit the repo')
    })

    it('preserves user messages carrying tool_result even if mistakenly flagged', () => {
      // Defensive: stripping a tool_result-bearing message would orphan the
      // matching tool_use and trigger an Anthropic 400. The filter must
      // ignore the flag in that case.
      const r = withCtx(
        [
          { role: 'user', content: 'do the thing' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'a.ts' } },
            ],
          },
          {
            role: 'user',
            _convertedFromSystem: true,
            content: [
              { type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' },
            ],
          },
        ],
        () => buildForkedMessages('continue work'),
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const joined = r.messages.map((m) => JSON.stringify(m)).join('\n')
      expect(joined).toContain('tu_1')
      expect(joined).toContain('tool_result')
    })

    it('does NOT strip plain user messages without the flag', () => {
      const r = withCtx(
        [
          { role: 'user', content: 'first turn' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'second turn' },
        ],
        () => buildForkedMessages('go'),
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const joined = r.messages.map((m) => JSON.stringify(m)).join('\n')
      expect(joined).toContain('first turn')
      expect(joined).toContain('second turn')
    })

    it('rejects fork when ALL parent messages are system noise', () => {
      const r = withCtx(
        [
          {
            role: 'user',
            content: '<system-reminder>boot</system-reminder>',
            _convertedFromSystem: true,
          },
          {
            role: 'user',
            content: '<system-reminder>nudge</system-reminder>',
            _convertedFromSystem: true,
          },
        ],
        () => buildForkedMessages('do it'),
      )
      expect(r.ok).toBe(false)
      if (!r.ok)
        expect(r.error).toMatch(/non-empty parent conversation after stripping/)
    })
  })
})
