import { describe, it, expect } from 'vitest'
import {
  CONTEXT_COLLAPSE_FRAC_OF_EFFECTIVE_WINDOW,
  deriveContextThresholdsFromOpenClaudeWindow,
  getContextCollapseDrainThresholdTokens,
  getEffectiveContextWindowTokens,
  getModelContextWindowTokens,
  getModelMaxOutputTokensBounds,
} from './openClaudeParityConstants'
import { snipOldestMessagesForBudget } from './historySnip'
import { ensureToolUseResultPairing } from './ensureToolUseResultPairing'
import { clearCompletedToolResultsExceptRecent } from './idleToolResultClear'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../constants/sideChannelKinds'

describe('openClaudeParityConstants', () => {
  it('deriveContextThresholdsFromOpenClaudeWindow orders tiers ascending', () => {
    const t = deriveContextThresholdsFromOpenClaudeWindow(180_000)
    expect(t.warningTokens).toBeLessThan(t.errorTokens)
    expect(t.errorTokens).toBeLessThan(t.historySnipTokens)
    expect(t.historySnipTokens).toBeLessThan(t.microCompactTokens)
    expect(t.microCompactTokens).toBeLessThan(t.autoCompactTokens)
    expect(t.autoCompactTokens).toBeLessThan(t.blockingTokens)
    expect(t.errorTokens).toBe(180_000 - 20_000)
    expect(t.autoCompactTokens).toBe(180_000 - 13_000)
    expect(t.blockingTokens).toBe(180_000 - 3_000)
    // History-snip tier defaults to midpoint of error / micro-compact.
    expect(t.historySnipTokens).toBe(Math.round((t.errorTokens + t.microCompactTokens) / 2))
  })

  it('getModelMaxOutputTokensBounds matches §2.2 table (spot checks)', () => {
    expect(getModelMaxOutputTokensBounds('claude-opus-4-6')).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    })
    expect(getModelMaxOutputTokensBounds('claude-sonnet-4-6')).toEqual({
      default: 32_000,
      upperLimit: 128_000,
    })
    expect(getModelMaxOutputTokensBounds('claude-3-opus')).toEqual({ default: 4_000, upperLimit: 4_000 })
    expect(getModelMaxOutputTokensBounds('unknown-model').default).toBeGreaterThan(0)
  })

  it('getModelContextWindowTokens respects POLE_CONTEXT_WINDOW_TOKENS', () => {
    const prev = process.env.POLE_CONTEXT_WINDOW_TOKENS
    process.env.POLE_CONTEXT_WINDOW_TOKENS = '12345'
    try {
      expect(getModelContextWindowTokens('any')).toBe(12345)
    } finally {
      if (prev === undefined) delete process.env.POLE_CONTEXT_WINDOW_TOKENS
      else process.env.POLE_CONTEXT_WINDOW_TOKENS = prev
    }
  })

  it('getContextCollapseDrainThresholdTokens ≈ CONTEXT_COLLAPSE_FRAC_OF_EFFECTIVE_WINDOW × effective window', () => {
    const eff = getEffectiveContextWindowTokens('generic-model')
    const t = getContextCollapseDrainThresholdTokens('generic-model')
    expect(t).toBe(Math.floor(eff * CONTEXT_COLLAPSE_FRAC_OF_EFFECTIVE_WINDOW))
    expect(getContextCollapseDrainThresholdTokens('generic-model', 99)).toBe(99)
  })
})

describe('historySnip', () => {
  it('drops oldest messages until under target', () => {
    const long = 'x'.repeat(400)
    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: long },
      { role: 'user', content: long },
      { role: 'user', content: 'tail' },
    ]
    const { messages: out, snippedCount } = snipOldestMessagesForBudget(messages, {
      systemPrompt: '',
      toolDefsTokens: 0,
      targetTotalTokens: 120,
      minMessagesToKeep: 2,
    })
    expect(snippedCount).toBeGreaterThan(0)
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out.some((m) => (m.content as string) === 'tail')).toBe(true)
  })

  it('repairs the head so first message is user (P0-5)', () => {
    // Snip-loop floor is 2, but the natural snip would leave
    // [assistant, user(tail)] which Anthropic Messages API rejects.
    // Repair must strip the leading assistant even if that dips below
    // the floor — a 400 is worse than a thinner tail.
    const long = 'x'.repeat(400)
    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: long },
      { role: 'assistant', content: long },
      { role: 'user', content: 'tail' },
    ]
    const { messages: out } = snipOldestMessagesForBudget(messages, {
      systemPrompt: '',
      toolDefsTokens: 0,
      targetTotalTokens: 120,
      minMessagesToKeep: 2,
    })
    expect(out[0]?.role).toBe('user')
  })

  it('strips orphan tool_result blocks from the new leading user (P0-5)', () => {
    const long = 'x'.repeat(400)
    const messages: Array<Record<string, unknown>> = [
      // assistant tool_use that will be snipped away
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_kept', name: 'Read', input: {} },
        ],
      },
      // user tool_result that survives — its tool_use parent is gone,
      // making the tool_result an orphan that would 400 on submit
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_kept', content: long },
          { type: 'text', text: 'survived text' },
        ],
      },
      { role: 'assistant', content: 'noise' },
      { role: 'user', content: 'tail' },
    ]
    const { messages: out } = snipOldestMessagesForBudget(messages, {
      systemPrompt: '',
      toolDefsTokens: 0,
      targetTotalTokens: 80,
      minMessagesToKeep: 2,
    })
    // First surviving message must be user; orphan tool_result must be gone.
    expect(out[0]?.role).toBe('user')
    if (Array.isArray(out[0]?.content)) {
      const blocks = out[0].content as Array<Record<string, unknown>>
      expect(blocks.some((b) => b.type === 'tool_result')).toBe(false)
    }
  })
})

describe('ensureToolUseResultPairing', () => {
  it('prepends synthetic tool_result when missing', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }],
      },
      { role: 'user', content: [{ type: 'text', text: 'oops no result' }] },
    ]
    const fixed = ensureToolUseResultPairing(messages)
    expect(fixed[1].role).toBe('user')
    const blocks = fixed[1].content as Record<string, unknown>[]
    expect(blocks[0].type).toBe('tool_result')
    expect(blocks[0].tool_use_id).toBe('tu_1')
  })

  // DeepSeek Anthropic-compat 400s when two consecutive user messages
  // separate an assistant `tool_use` from its `tool_result`. The previous
  // implementation hit that path whenever the next user message used the
  // compact `content: string` form (e.g. a "[User interrupted...]" turn or
  // a fresh user prompt while a previous tool_use went unanswered): synth
  // got spliced as a brand-new user, leaving an assistant→user(synth)→user
  // chain that the compat client doesn't re-merge before sending.
  it('merges synth into a string-content next user without producing consecutive user turns', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_00_a', name: 'Read', input: {} },
          { type: 'tool_use', id: 'call_01_b', name: 'Read', input: {} },
        ],
      },
      { role: 'user', content: '[User interrupted during tool execution.]' },
    ]
    const fixed = ensureToolUseResultPairing(messages)
    expect(fixed).toHaveLength(2)
    expect(fixed[0].role).toBe('assistant')
    expect(fixed[1].role).toBe('user')
    const blocks = fixed[1].content as Record<string, unknown>[]
    expect(blocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_00_a' })
    expect(blocks[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_01_b' })
    // v1/C3 + v2/C1 — when synth tool_result blocks merge with a user
    // message that carries real text content, a `<system-reminder>`
    // separator block goes between them so the model can tell synth
    // pairing repair from the surrounding turn.
    expect(blocks[2]).toMatchObject({ type: 'text' })
    expect(String(blocks[2].text)).toContain('[Pairing repair]')
    expect(blocks[3]).toMatchObject({
      type: 'text',
      text: '[User interrupted during tool execution.]',
    })
  })

  it('appends synth user when assistant tool_use is the last message', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_tail', name: 'Read', input: {} }],
      },
    ]
    const fixed = ensureToolUseResultPairing(messages)
    expect(fixed).toHaveLength(2)
    expect(fixed[1].role).toBe('user')
    const blocks = fixed[1].content as Record<string, unknown>[]
    expect(blocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_tail', is_error: true })
  })
})

describe('idleToolResultClear', () => {
  // Helper: build an assistant tool_use + user tool_result pair so the
  // whitelist gate in `buildToolUseIdSets` resolves the tool name.
  const mkPair = (id: string, name: string, body: string) => [
    {
      role: 'assistant' as const,
      content: [{ type: 'tool_use', id, name, input: {} }],
    },
    {
      role: 'user' as const,
      content: [{ type: 'tool_result', tool_use_id: id, content: body }],
    },
  ]

  it('clears old tool_result string bodies beyond recent groups for whitelisted tools', () => {
    // Bash is on the compactable whitelist and NOT on the protected list,
    // so it's the cleanest test target for the clearing behaviour.
    const messages = [
      ...mkPair('tu_1', 'Bash', 'old1'),
      ...mkPair('tu_2', 'Bash', 'old2'),
      ...mkPair('tu_3', 'Bash', 'keep'),
    ]
    const out = clearCompletedToolResultsExceptRecent(messages, 1, '[cleared]')
    const tr = out.filter((m) => m.role === 'user')
    const bodies = tr.map(
      (m) => ((m.content as Record<string, unknown>[])[0].content as string) ?? '',
    )
    expect(bodies[2]).toBe('keep')
    expect(bodies[0]).toBe('[cleared]')
    expect(bodies[1]).toBe('[cleared]')
  })

  it('skips clearing for protected tools (Read/Glob) — feeds writeIntegrityGuard', () => {
    const messages = [
      ...mkPair('tu_1', 'Read', 'old read receipt'),
      ...mkPair('tu_2', 'Bash', 'old bash output'),
      ...mkPair('tu_3', 'Bash', 'keep'),
    ]
    const out = clearCompletedToolResultsExceptRecent(messages, 1, '[cleared]')
    const tr = out.filter((m) => m.role === 'user')
    const bodies = tr.map(
      (m) => ((m.content as Record<string, unknown>[])[0].content as string) ?? '',
    )
    // Read receipt preserved even though it falls outside the recent window.
    expect(bodies[0]).toBe('old read receipt')
    // Bash result outside window is cleared as usual.
    expect(bodies[1]).toBe('[cleared]')
    // Most recent kept.
    expect(bodies[2]).toBe('keep')
  })

  it('skips clearing for non-whitelisted (unknown / custom) tools', () => {
    // TodoWrite is not on the compactable whitelist — its output should
    // survive even when it falls past the keep-recent window.
    const messages = [
      ...mkPair('tu_1', 'TodoWrite', 'old todo state'),
      ...mkPair('tu_2', 'Bash', 'old bash'),
      ...mkPair('tu_3', 'Bash', 'keep'),
    ]
    const out = clearCompletedToolResultsExceptRecent(messages, 1, '[cleared]')
    const tr = out.filter((m) => m.role === 'user')
    const bodies = tr.map(
      (m) => ((m.content as Record<string, unknown>[])[0].content as string) ?? '',
    )
    expect(bodies[0]).toBe('old todo state')
    expect(bodies[1]).toBe('[cleared]')
    expect(bodies[2]).toBe('keep')
  })

  it('clears the embedded tool-batch ledger together with its tool_results (ledger TTL)', () => {
    // 2026-06 long-run hallucination fix — the host-authored "-> success"
    // ledger must not outlive the tool_result evidence it describes.
    // Same wire shape as `formatDeterministicToolLedgerForInjection`
    // (marker first line + canonical envelope via wrapSideChannelBody).
    const mkLedger = (id: string) =>
      wrapSideChannelBody(
        SIDE_CHANNEL_KIND.toolBatchLedger,
        `[Previous tool batch ledger — host-generated]\n- Bash id=${id} -> success; input={}; result=ok`,
      )
    const mkLedgeredPair = (id: string, body: string) => [
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use', id, name: 'Bash', input: {} }],
      },
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result', tool_use_id: id, content: body },
          { type: 'text', text: mkLedger(id) },
        ],
      },
    ]
    const messages = [
      ...mkLedgeredPair('tu_old', 'old bash output'),
      ...mkLedgeredPair('tu_new', 'keep'),
    ]
    const out = clearCompletedToolResultsExceptRecent(messages, 1, '[cleared]')

    // Old group: tool_result body cleared AND ledger text block dropped.
    const oldBlocks = out[1].content as Record<string, unknown>[]
    expect(oldBlocks.find((b) => b.type === 'tool_result')!.content).toBe('[cleared]')
    expect(oldBlocks.some((b) => b.type === 'text')).toBe(false)

    // Recent group: both tool_result body and ledger stay intact.
    const newBlocks = out[3].content as Record<string, unknown>[]
    expect(newBlocks.find((b) => b.type === 'tool_result')!.content).toBe('keep')
    expect(
      newBlocks.some(
        (b) =>
          b.type === 'text' &&
          typeof b.text === 'string' &&
          (b.text as string).includes('[Previous tool batch ledger'),
      ),
    ).toBe(true)
  })

  it('does not drop non-ledger text blocks in cleared groups', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use', id: 'tu_a', name: 'Bash', input: {} }],
      },
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result', tool_use_id: 'tu_a', content: 'old output' },
          { type: 'text', text: 'genuine follow-up note from the host' },
        ],
      },
      ...mkPair('tu_b', 'Bash', 'keep'),
    ]
    const out = clearCompletedToolResultsExceptRecent(messages, 1, '[cleared]')
    const oldBlocks = out[1].content as Record<string, unknown>[]
    expect(
      oldBlocks.some(
        (b) => b.type === 'text' && b.text === 'genuine follow-up note from the host',
      ),
    ).toBe(true)
  })

  it('skips clearing for orphan tool_result with no matching tool_use', () => {
    // `ensureToolUseResultPairing` can inject synthetic tool_result
    // blocks (e.g. after a streaming abort) whose `tool_use_id` doesn't
    // resolve to any assistant tool_use in the transcript. The
    // whitelist gate must treat unknown ids as "not compactable" —
    // safer than the old blacklist behaviour, which would have
    // silently cleared them.
    const orphan = (id: string, body: string) => ({
      role: 'user' as const,
      content: [{ type: 'tool_result', tool_use_id: id, content: body }],
    })
    const messages: Array<Record<string, unknown>> = [
      orphan('synth_1', 'orphan body 1'),
      orphan('synth_2', 'orphan body 2'),
      ...mkPair('tu_real', 'Bash', 'keep'),
    ]
    const out = clearCompletedToolResultsExceptRecent(messages, 1, '[cleared]')
    const tr = out.filter((m) => m.role === 'user')
    const bodies = tr.map(
      (m) => ((m.content as Record<string, unknown>[])[0].content as string) ?? '',
    )
    expect(bodies[0]).toBe('orphan body 1')
    expect(bodies[1]).toBe('orphan body 2')
    expect(bodies[2]).toBe('keep')
  })
})
