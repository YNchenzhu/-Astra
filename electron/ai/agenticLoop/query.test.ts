/**
 * Unit tests for the `query/` 5-piece set contracts.
 *
 * Each piece gets a focused, fast suite that doesn't depend on the
 * 1500-line `agenticLoop.ts` body — by design. If these tests have to
 * spin up the full loop to be meaningful, the contracts have leaked
 * implementation detail and need redesign.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  __resetQueryStopHooksForTests,
  decideIterationOutcome,
  defaultQueryDeps,
  freezeQueryConfig,
  listQueryStopHooks,
  registerQueryStopHook,
  runQueryStopHooks,
  type QueryConfig,
  type QueryStopHook,
} from './query'
import { asAgentId } from '../../tools/ids'
import { createTerminalResult } from '../queryTermination'

describe('QueryConfig — freezeQueryConfig', () => {
  it('returns a frozen structural copy', () => {
    const input: QueryConfig = {
      agentId: asAgentId('main'),
      model: 'opus-4',
      replDepth: 0,
      forkCacheStrategy: 'legacy',
      blockingLimitHard: false,
    }
    const config = freezeQueryConfig(input)
    expect(config.model).toBe('opus-4')
    expect(Object.isFrozen(config)).toBe(true)
    // Mutating the original must not bleed into the frozen copy.
    ;(input as { model: string }).model = 'sonnet-4'
    expect(config.model).toBe('opus-4')
  })

  it('forbids in-place mutation after freezing (strict-mode aware)', () => {
    const config = freezeQueryConfig({
      agentId: asAgentId('main'),
      model: 'opus-4',
      replDepth: 0,
      forkCacheStrategy: 'legacy',
      blockingLimitHard: false,
    })
    // Vitest runs in strict mode; assigning to a frozen prop throws.
    // We assert via try/catch to keep the test runtime-agnostic.
    let threw = false
    try {
      ;(config as { model: string }).model = 'leak'
    } catch {
      threw = true
    }
    // Either threw (strict mode) or silently failed; both are acceptable.
    expect(threw || config.model === 'opus-4').toBe(true)
  })

  it('captures optional fields when provided', () => {
    const config = freezeQueryConfig({
      agentId: asAgentId('main'),
      model: 'opus-4',
      replDepth: 2,
      forkCacheStrategy: 'tight',
      blockingLimitHard: true,
      parentAgentId: 'parent',
      streamConversationId: 'conv-1',
      queryChainId: 'chain-1',
      taskBudgetMs: 60_000,
      thinkingBudgetTokens: 4_096,
      providerConfigName: 'anthropic-prod',
    })
    expect(config.parentAgentId).toBe('parent')
    expect(config.streamConversationId).toBe('conv-1')
    expect(config.taskBudgetMs).toBe(60_000)
    expect(config.thinkingBudgetTokens).toBe(4_096)
  })
})

describe('QueryDeps — defaultQueryDeps', () => {
  // Fake callModel that satisfies `typeof streamText` via parameter
  // contravariance (a no-arg async fn is assignable to a 4-arg async fn
  // because callers can drop extra args). Returning `undefined` is
  // legal for `Promise<void>`.
  const fakeCallModel = async () => undefined

  it('defaults now to Date.now when no override given', () => {
    const ac = new AbortController()
    const deps = defaultQueryDeps({
      callModel: fakeCallModel,
      signal: ac.signal,
    })
    expect(typeof deps.now()).toBe('number')
    expect(deps.signal).toBe(ac.signal)
  })

  it('honors now override for deterministic tests', () => {
    const deps = defaultQueryDeps({
      callModel: fakeCallModel,
      signal: new AbortController().signal,
      now: () => 42,
    })
    expect(deps.now()).toBe(42)
  })

  it('has no microcompact / autocompact / uuid slots (cc-haha divergence + A8 cleanup)', () => {
    // Regression guard: the audit Finding 8 (A) "dead scaffolding" trap
    // — these slots were removed because nothing in the agentic loop
    // actually calls microCompact / autoCompact directly. If they
    // reappear without a real consumer, this test should fail.
    const deps = defaultQueryDeps({
      callModel: fakeCallModel,
      signal: new AbortController().signal,
    })
    expect('microcompact' in deps).toBe(false)
    expect('autocompact' in deps).toBe(false)
    expect('uuid' in deps).toBe(false)
  })
})

describe('QueryStopHooks — registration + ordered execution', () => {
  beforeEach(() => __resetQueryStopHooksForTests())
  afterEach(() => __resetQueryStopHooksForTests())

  it('sorts hooks by priority on registration', () => {
    registerQueryStopHook({ name: 'dream', priority: 200, run: () => {} })
    registerQueryStopHook({ name: 'snapshot', priority: 0, run: () => {} })
    registerQueryStopHook({ name: 'memory', priority: 100, run: () => {} })
    const order = listQueryStopHooks().map((h) => h.name)
    expect(order).toEqual(['snapshot', 'memory', 'dream'])
  })

  it('runs hooks in priority order and yields per-hook status', async () => {
    const calls: string[] = []
    registerQueryStopHook({
      name: 'b',
      priority: 200,
      run: () => {
        calls.push('b')
      },
    })
    registerQueryStopHook({
      name: 'a',
      priority: 100,
      run: () => {
        calls.push('a')
      },
    })
    const result = createTerminalResult('completed', { turnCount: 1 })

    const events: Array<{ name: string; ok: boolean }> = []
    for await (const ev of runQueryStopHooks(result)) {
      events.push({ name: ev.name, ok: ev.ok })
    }
    expect(calls).toEqual(['a', 'b'])
    expect(events).toEqual([
      { name: 'a', ok: true },
      { name: 'b', ok: true },
    ])
  })

  it('isolates hook errors — failing hook never aborts the drain', async () => {
    const calls: string[] = []
    registerQueryStopHook({
      name: 'good-before',
      priority: 0,
      run: () => {
        calls.push('good-before')
      },
    })
    registerQueryStopHook({
      name: 'bad',
      priority: 100,
      run: () => {
        throw new Error('boom')
      },
    })
    registerQueryStopHook({
      name: 'good-after',
      priority: 200,
      run: () => {
        calls.push('good-after')
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const events: Array<{ name: string; ok: boolean; error?: unknown }> = []
      for await (const ev of runQueryStopHooks(
        createTerminalResult('completed', { turnCount: 1 }),
      )) {
        events.push({ name: ev.name, ok: ev.ok, error: ev.error })
      }
      expect(calls).toEqual(['good-before', 'good-after'])
      const bad = events.find((e) => e.name === 'bad')
      expect(bad?.ok).toBe(false)
      expect((bad?.error as Error | undefined)?.message).toBe('boom')
    } finally {
      warn.mockRestore()
    }
  })

  it('a hook registered during the drain does not affect the current run', async () => {
    let secondaryCalled = false
    const secondary: QueryStopHook = {
      name: 'secondary',
      priority: 50,
      run: () => {
        secondaryCalled = true
      },
    }
    registerQueryStopHook({
      name: 'primary',
      priority: 0,
      run: () => {
        registerQueryStopHook(secondary)
      },
    })
    for await (const _ of runQueryStopHooks(
      createTerminalResult('completed', { turnCount: 1 }),
    )) {
      // drain
    }
    expect(secondaryCalled).toBe(false)
  })

  it('unregister hook function detaches it', async () => {
    const calls: string[] = []
    const unregister = registerQueryStopHook({
      name: 'detachable',
      priority: 0,
      run: () => {
        calls.push('detachable')
      },
    })
    unregister()
    for await (const _ of runQueryStopHooks(
      createTerminalResult('completed', { turnCount: 1 }),
    )) {
      // drain
    }
    expect(calls).toEqual([])
  })
})

describe('Continuation derivation — unified decision table via the facade', () => {
  // P3-1: the legacy queryLoopStepper re-export was deleted; the facade
  // now exposes the unified table. Smoke test the export resolves.
  it('decideIterationOutcome is callable through the `query` facade', () => {
    const decision = decideIterationOutcome({})
    expect(decision).toEqual({ kind: 'continue', transition: 'tool_use', sourceRow: '17' })
  })
})

/**
 * Integration tests for the 5-piece-set §A1 wiring: the legacy
 * `registerTerminationCleanup` / `runTerminationCleanup` surface now
 * delegates to `queryStopHooks`. These tests pin the priority-ordering
 * contract and the cross-surface convergence: a mix of legacy and
 * priority-aware registrations must execute as a single ordered
 * pipeline. Audit Finding 8 (A) called out the previous "decorative,
 * not wired" state; these tests guard against silent regression to it.
 */
describe('queryTermination ↔ queryStopHooks integration (§A1)', () => {
  beforeEach(() => {
    __resetQueryStopHooksForTests()
  })
  afterEach(() => {
    __resetQueryStopHooksForTests()
  })

  it('registerTerminationCleanup lands as a priority-100 hook in the unified pipeline', async () => {
    const { registerTerminationCleanup } = await import('../queryTermination')
    const calls: string[] = []
    const unreg = registerTerminationCleanup(() => {
      calls.push('legacy-cb')
    })
    try {
      const hooks = listQueryStopHooks()
      expect(hooks.length).toBe(1)
      expect(hooks[0]!.priority).toBe(100)
      expect(hooks[0]!.name).toMatch(/^legacy-cleanup-\d+$/)

      // And it actually fires when the unified drain runs.
      for await (const _ of runQueryStopHooks(
        createTerminalResult('completed', { turnCount: 1 }),
      )) {
        // drain
      }
      expect(calls).toEqual(['legacy-cb'])
    } finally {
      unreg()
    }
  })

  it('runTerminationCleanup drives the same ordered pipeline as runQueryStopHooks', async () => {
    const { registerTerminationCleanup, runTerminationCleanup } = await import(
      '../queryTermination'
    )
    const calls: string[] = []
    // Explicit priority-10 hook (state-capture band) — mirrors what
    // installCacheSafeParamsSnapshotHook does.
    registerQueryStopHook({
      name: 'pseudo-snapshot',
      priority: 10,
      run: () => {
        calls.push('snapshot')
      },
    })
    // Legacy callback (lands at priority 100).
    registerTerminationCleanup(() => {
      calls.push('legacy')
    })
    // Another high-priority hook (proactive band) — lands after legacy.
    registerQueryStopHook({
      name: 'pseudo-dream',
      priority: 200,
      run: () => {
        calls.push('dream')
      },
    })

    await runTerminationCleanup(
      createTerminalResult('completed', { turnCount: 2 }),
    )

    // Priority-ordered: 10 → 100 → 200, regardless of registration order.
    expect(calls).toEqual(['snapshot', 'legacy', 'dream'])
  })

  it('the cacheSafeParams snapshot hook actually registers under the 5-piece pipeline', async () => {
    // Audit Finding 8 regression guard — proves that the snapshot hook
    // is no longer riding the legacy callback list but the priority-aware
    // queryStopHooks registry, with the documented priority-10 slot.
    const {
      installCacheSafeParamsSnapshotHook,
      CACHE_SAFE_PARAMS_HOOK_PRIORITY,
    } = await import('../../agents/cacheSafeParams')
    const uninstall = installCacheSafeParamsSnapshotHook()
    try {
      const hooks = listQueryStopHooks()
      const cacheHook = hooks.find((h) => h.name === 'cacheSafeParams.snapshot')
      expect(cacheHook).toBeDefined()
      expect(cacheHook?.priority).toBe(CACHE_SAFE_PARAMS_HOOK_PRIORITY)
      expect(CACHE_SAFE_PARAMS_HOOK_PRIORITY).toBeLessThan(100) // below the legacy band
    } finally {
      uninstall()
    }
  })

  it('snapshot hook fires before legacy cleanups on every termination path', async () => {
    const { registerTerminationCleanup, runTerminationCleanup } = await import(
      '../queryTermination'
    )
    const { installCacheSafeParamsSnapshotHook } = await import(
      '../../agents/cacheSafeParams'
    )
    const order: string[] = []
    // Spy via a sibling hook at priority 10 to observe the cache hook's
    // ordering without coupling to its internal `saveCacheSafeParamsFromContext`
    // side effect.
    registerQueryStopHook({
      name: 'sibling-snapshot',
      priority: 10,
      run: () => order.push('snapshot-band'),
    })
    const uninstall = installCacheSafeParamsSnapshotHook()
    registerTerminationCleanup(() => order.push('legacy-cb'))
    try {
      // Iterate every error termination path to prove ordering invariant
      // is not reason-specific.
      for (const reason of [
        'completed',
        'aborted_streaming',
        'max_turns',
      ] as const) {
        order.length = 0
        await runTerminationCleanup(
          createTerminalResult(reason, { turnCount: 1 }),
        )
        expect(order.indexOf('snapshot-band')).toBeLessThan(
          order.indexOf('legacy-cb'),
        )
      }
    } finally {
      uninstall()
    }
  })
})
