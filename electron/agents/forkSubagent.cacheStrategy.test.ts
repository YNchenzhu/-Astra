/**
 * Tests for the {@link ForkCacheStrategy} dual-track (upstream §query/fork parity).
 *
 * Coverage:
 *   1. `legacy` strategy (default) preserves Bug A-1 behaviour: parent
 *      `<system-reminder>` injections are stripped before truncation.
 *   2. `tight` strategy retains the parent transcript verbatim before
 *      appending the boilerplate envelope — proving byte-equal prefix
 *      semantics for prompt-cache reuse.
 *   3. `tight` strategy also skips deep-clone (refs shared with parent).
 *   4. Env-driven selection via `POLE_FORK_CACHE_TIGHT`.
 *   5. The serialised prefix (everything except the final boilerplate
 *      message) is byte-identical to the parent's `messages` JSON when
 *      `tight` is selected.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runWithAgentContext, type AgentContext } from './agentContext'
import {
  buildForkedMessages,
  readForkCacheStrategy,
  type ForkCacheStrategy,
} from './forkSubagent'
import type { ProviderConfig } from '../ai/client'

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

beforeEach(() => {
  delete process.env.POLE_FORK_CACHE_TIGHT
})

afterEach(() => {
  delete process.env.POLE_FORK_CACHE_TIGHT
})

describe('ForkCacheStrategy — env selection', () => {
  it('defaults to legacy when POLE_FORK_CACHE_TIGHT is unset', () => {
    expect(readForkCacheStrategy()).toBe('legacy')
  })

  it.each([['1'], ['true'], ['TRUE'], ['yes'], ['tight']])(
    'returns tight when POLE_FORK_CACHE_TIGHT=%s',
    (raw: string) => {
      process.env.POLE_FORK_CACHE_TIGHT = raw
      expect(readForkCacheStrategy()).toBe('tight')
    },
  )

  it.each([['0'], ['false'], ['no'], [''], ['garbage']])(
    'falls back to legacy for non-truthy value %s',
    (raw: string) => {
      process.env.POLE_FORK_CACHE_TIGHT = raw
      expect(readForkCacheStrategy()).toBe('legacy')
    },
  )
})

describe('ForkCacheStrategy — legacy vs tight semantics', () => {
  /** Parent messages: a real user turn + a synthetic parent-system reminder + a real assistant reply. */
  const parentMessages: AgentContext['messages'] = [
    { role: 'user', content: 'real first user turn' },
    {
      role: 'user',
      content: '<system-reminder>parent-only nudge</system-reminder>',
      _convertedFromSystem: true,
    },
    { role: 'assistant', content: 'real assistant reply' },
  ]

  it('legacy strips parent system reminders before truncation', () => {
    const r = withCtx(parentMessages, () =>
      buildForkedMessages('do the thing', { strategy: 'legacy' }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.strategy).toBe('legacy')
    // 3 parent messages → 2 retained (system reminder dropped) → +1 boilerplate.
    expect(r.messages.length).toBe(3)
    // The reminder text must not appear anywhere in the inherited slice.
    const joined = JSON.stringify(r.messages.slice(0, -1))
    expect(joined).not.toContain('parent-only nudge')
  })

  it('tight preserves the parent transcript verbatim before the boilerplate', () => {
    const r = withCtx(parentMessages, () =>
      buildForkedMessages('do the thing', { strategy: 'tight' }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.strategy).toBe('tight')
    // 3 parent + 1 boilerplate.
    expect(r.messages.length).toBe(4)
    // The reminder is intentionally retained — that's the cache-tight trade-off.
    expect(JSON.stringify(r.messages[1])).toContain('parent-only nudge')
  })

  it('tight prefix (everything but the last message) is JSON-byte-equal to the parent transcript', () => {
    // This is the core upstream §query/fork promise: with `tight`, the
    // request the fork sends and the parent's most recent request share
    // a byte-identical prefix → Anthropic prompt-cache hit. We approximate
    // the wire format with JSON.stringify; the actual cache breakpoint
    // lives at the parent's last `user` message, so we compare everything
    // up to (but not including) the new boilerplate.
    const r = withCtx(parentMessages, () =>
      buildForkedMessages('do the thing', { strategy: 'tight' }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const prefix = JSON.stringify(r.messages.slice(0, -1))
    const parentJson = JSON.stringify(parentMessages)
    expect(prefix).toBe(parentJson)
  })

  it('legacy prefix differs from parent (proves the strip is what was breaking cache)', () => {
    // Foil to the previous test — verifies that the legacy strategy
    // really does mutate the prefix vs the parent's JSON. If this ever
    // starts producing the same bytes as the parent, either the strip
    // logic regressed or the synthetic reminder fixture stopped being
    // marked `_convertedFromSystem` (so the strip would no-op).
    const r = withCtx(parentMessages, () =>
      buildForkedMessages('do the thing', { strategy: 'legacy' }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const prefix = JSON.stringify(r.messages.slice(0, -1))
    const parentJson = JSON.stringify(parentMessages)
    expect(prefix).not.toBe(parentJson)
  })

  it('tight shares object refs with the parent (no deep clone)', () => {
    const r = withCtx(parentMessages, () =>
      buildForkedMessages('go', { strategy: 'tight' }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Each retained message is the SAME object reference the parent holds.
    for (let i = 0; i < parentMessages.length; i++) {
      expect(r.messages[i]).toBe(parentMessages[i])
    }
  })

  it('legacy deep-clones (no shared refs)', () => {
    // Parent transcript with only real turns so the legacy strip is a no-op
    // and we can compare retained-vs-original index for index.
    const realOnly: AgentContext['messages'] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]
    const r = withCtx(realOnly, () =>
      buildForkedMessages('go', { strategy: 'legacy' }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (let i = 0; i < realOnly.length; i++) {
      expect(r.messages[i]).not.toBe(realOnly[i])
    }
  })

  it('selects tight from env when no explicit strategy is passed', () => {
    process.env.POLE_FORK_CACHE_TIGHT = '1'
    const r = withCtx(parentMessages, () =>
      buildForkedMessages('go'), // no strategy override
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.strategy).toBe('tight')
  })

  it('selects legacy from env (default) when no explicit strategy is passed', () => {
    const r = withCtx(parentMessages, () =>
      buildForkedMessages('go'), // no strategy override
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.strategy).toBe('legacy')
  })

  it('tight shallow-freezes the shared envelopes so accidental parent mutation throws', () => {
    // Audit Finding 6 (C): the tight strategy depends on parent never
    // mutating message envelopes in place after the fork is taken. We
    // turn that unenforced convention into an enforced invariant by
    // shallow-freezing every retained envelope. Any future code path
    // that does `state.messages.at(-1).cache_control = …` will throw a
    // `TypeError` in strict mode (vitest runs strict) instead of
    // silently corrupting the fork's view.
    const r = withCtx(parentMessages, () =>
      buildForkedMessages('go', { strategy: 'tight' }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const m of r.messages.slice(0, -1)) {
      expect(Object.isFrozen(m)).toBe(true)
    }
    // The boilerplate is freshly constructed inside `buildForkedMessages`
    // (not inherited from parent) — it MUST stay writable so callers
    // that append further directives can do so without crashing.
    const boilerplate = r.messages[r.messages.length - 1]
    expect(Object.isFrozen(boilerplate)).toBe(false)
    // Parent-side mutation attempt → throws (strict mode).
    expect(() => {
      ;(parentMessages[0] as Record<string, unknown>).cache_control = { type: 'ephemeral' }
    }).toThrow(TypeError)
  })

  it('legacy does NOT freeze (deep clones are caller-owned and mutable)', () => {
    // Foil to the tight test — the legacy strategy returns independent
    // copies, so freezing would surprise callers who reasonably expect
    // to mutate their own copy. Keeping legacy unfrozen also avoids
    // changing pre-existing behaviour outside the cache-tight track.
    const r = withCtx(parentMessages, () =>
      buildForkedMessages('go', { strategy: 'legacy' }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const m of r.messages) {
      expect(Object.isFrozen(m)).toBe(false)
    }
  })

  it('tight freeze is idempotent — re-forking the same parent does not throw', () => {
    // `Object.freeze` is a no-op on an already-frozen object, so a
    // second `buildForkedMessages` against the same parent context must
    // not blow up. Guards against a re-fork / multi-fork-from-same-parent
    // workflow regressing.
    const messages: AgentContext['messages'] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]
    withCtx(messages, () => {
      const r1 = buildForkedMessages('first', { strategy: 'tight' })
      expect(r1.ok).toBe(true)
      const r2 = buildForkedMessages('second', { strategy: 'tight' })
      expect(r2.ok).toBe(true)
      if (!r1.ok || !r2.ok) return
      // Same refs across both forks (the parent isn't mutated).
      for (let i = 0; i < messages.length; i++) {
        expect(r1.messages[i]).toBe(messages[i])
        expect(r2.messages[i]).toBe(messages[i])
        expect(Object.isFrozen(messages[i])).toBe(true)
      }
    })
  })

  it('always appends the boilerplate envelope as the final message regardless of strategy', () => {
    for (const strategy of ['legacy', 'tight'] as ForkCacheStrategy[]) {
      const r = withCtx(parentMessages, () =>
        buildForkedMessages('directive body', { strategy }),
      )
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      const tail = r.messages[r.messages.length - 1]
      expect(tail.role).toBe('user')
      expect(String(tail.content)).toContain('directive body')
      expect(String(tail.content)).toContain('<fork-boilerplate>')
    }
  })
})
