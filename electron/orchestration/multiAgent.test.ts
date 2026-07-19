/**
 * MultiAgentOrchestrator: parent/child edges, concurrency, cascade interrupt/pause.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MultiAgentOrchestrator,
  createInMemoryMailboxPort,
  type WorktreeAllocator,
} from './multiAgent'
import { OrchestrationKernel } from './kernel'
import { createInitialKernelLoopState } from './kernelTypes'
import { createTransportAdapter, noopHookPolicy } from './transport'
import { DefaultToolRuntimePort } from './toolRuntime/defaultToolRuntimePort'
import { createNoopMcpSessionAdapter } from './mcpSessionAdapter'

function makeKernel(conv = 'c') {
  const ports = {
    tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
    permission: { noteToolInvocation: vi.fn() },
    session: createNoopMcpSessionAdapter(),
    transport: createTransportAdapter(vi.fn()),
    hooks: noopHookPolicy,
  }
  return new OrchestrationKernel(
    ports,
    undefined,
    createInitialKernelLoopState([]),
    conv,
  )
}

describe('MultiAgentOrchestrator ', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers parent + children and tracks edges', () => {
    const orch = new MultiAgentOrchestrator()
    const parent = makeKernel('parent')
    const childA = makeKernel('childA')
    const childB = makeKernel('childB')

    orch.register('parent-id', parent, {
      agentType: 'Coordinator',
      affinity: 'main_process',
    })
    orch.register('childA-id', childA, {
      parentKernelId: 'parent-id',
      agentType: 'Explore',
      affinity: 'main_process',
    })
    orch.register('childB-id', childB, {
      parentKernelId: 'parent-id',
      agentType: 'Plan',
      affinity: 'background_worker',
    })

    expect(orch.listChildren('parent-id').map((s) => s.meta.kernelId)).toEqual([
      'childA-id',
      'childB-id',
    ])
    expect(orch.get('childA-id')?.meta.agentType).toBe('Explore')
  })

  it('enforceConcurrencyLimit throws when ceiling exceeded', () => {
    const orch = new MultiAgentOrchestrator({ maxConcurrentChildren: 2 })
    orch.register('parent', makeKernel('p'), {
      agentType: 'Coordinator',
      affinity: 'main_process',
    })
    orch.register('c1', makeKernel('c1'), {
      parentKernelId: 'parent',
      agentType: 'Explore',
      affinity: 'main_process',
    })
    orch.register('c2', makeKernel('c2'), {
      parentKernelId: 'parent',
      agentType: 'Explore',
      affinity: 'main_process',
    })
    expect(() => orch.enforceConcurrencyLimit('parent')).toThrow(/Concurrency ceiling/)
  })

  it('interruptTree cascades to all descendants', () => {
    const orch = new MultiAgentOrchestrator()
    const parent = makeKernel('p')
    const c1 = makeKernel('c1')
    const g1 = makeKernel('g1')
    orch.register('p', parent, { agentType: 'Coordinator', affinity: 'main_process' })
    orch.register('c1', c1, { parentKernelId: 'p', agentType: 'Explore', affinity: 'main_process' })
    orch.register('g1', g1, { parentKernelId: 'c1', agentType: 'gen', affinity: 'main_process' })

    const count = orch.interruptTree('p', 'shutdown')
    expect(count).toBe(3)
    expect(parent.getInterruptReason()).toBe('shutdown')
    expect(c1.getInterruptReason()).toBe('shutdown')
    expect(g1.getInterruptReason()).toBe('shutdown')
  })

  it('pauseTree and resumeTree cascade bidirectionally', () => {
    const orch = new MultiAgentOrchestrator()
    const parent = makeKernel('p')
    const child = makeKernel('c')
    orch.register('p', parent, { agentType: 'Coordinator', affinity: 'main_process' })
    orch.register('c', child, {
      parentKernelId: 'p',
      agentType: 'Explore',
      affinity: 'main_process',
    })

    expect(orch.pauseTree('p')).toBe(2)
    expect(parent.isPaused()).toBe(true)
    expect(child.isPaused()).toBe(true)

    expect(orch.resumeTree('p')).toBe(2)
    expect(parent.isPaused()).toBe(false)
    expect(child.isPaused()).toBe(false)
  })

  it('unregister removes edges and releases worktree', () => {
    const release = vi.fn()
    const allocator: WorktreeAllocator = {
      allocate: vi.fn().mockResolvedValue('/wt/c1'),
      release,
    }
    const orch = new MultiAgentOrchestrator({ worktreeAllocator: allocator })
    orch.register('p', makeKernel('p'), {
      agentType: 'Coordinator',
      affinity: 'main_process',
    })
    orch.register('c1', makeKernel('c1'), {
      parentKernelId: 'p',
      agentType: 'Explore',
      affinity: 'main_process',
      worktreePath: '/wt/c1',
    })
    orch.unregister('c1')
    expect(orch.listChildren('p')).toHaveLength(0)
    expect(release).toHaveBeenCalledWith('/wt/c1')
  })

  it('unregister re-parents live children to the grandparent (no orphans)', () => {
    const orch = new MultiAgentOrchestrator()
    const p = makeKernel('p')
    const c1 = makeKernel('c1')
    const g1 = makeKernel('g1')
    orch.register('p', p, { agentType: 'Coordinator', affinity: 'main_process' })
    orch.register('c1', c1, {
      parentKernelId: 'p',
      agentType: 'Explore',
      affinity: 'main_process',
    })
    orch.register('g1', g1, {
      parentKernelId: 'c1',
      agentType: 'gen',
      affinity: 'background_worker',
    })

    // Tear down the intermediate parent while its child is still live.
    orch.unregister('c1')

    // g1 survives and is now a DIRECT child of p (re-parented, not orphaned).
    expect(orch.get('g1')).toBeDefined()
    expect(orch.listChildren('p').map((s) => s.meta.kernelId)).toEqual(['g1'])
    expect(orch.get('g1')?.meta.parentKernelId).toBe('p')

    // The formerly-orphaned grandchild is now reachable by cascade interrupt.
    const count = orch.interruptTree('p', 'shutdown')
    expect(count).toBe(2) // p + g1 (c1 already unregistered)
    expect(g1.getInterruptReason()).toBe('shutdown')
  })

  it('unregister clears parent ref when no grandparent (children become roots)', () => {
    const orch = new MultiAgentOrchestrator()
    const root = makeKernel('root')
    const child = makeKernel('child')
    orch.register('root', root, {
      agentType: 'Coordinator',
      affinity: 'main_process',
    })
    orch.register('child', child, {
      parentKernelId: 'root',
      agentType: 'Explore',
      affinity: 'main_process',
    })

    orch.unregister('root')

    // child survives as a root with no stale parent edge.
    expect(orch.get('child')).toBeDefined()
    expect(orch.get('child')?.meta.parentKernelId).toBeUndefined()
    expect(orch.interruptTree('child', 'user')).toBe(1)
  })

  it('allocateWorktreeFor delegates to allocator and returns path', async () => {
    const allocator: WorktreeAllocator = {
      allocate: async () => '/wt/new',
      release: async () => {},
    }
    const orch = new MultiAgentOrchestrator({ worktreeAllocator: allocator })
    const p = await orch.allocateWorktreeFor({
      childKernelId: 'id',
      agentType: 'Explore',
    })
    expect(p).toBe('/wt/new')
  })

  it('allocateWorktreeFor returns undefined when no allocator configured', async () => {
    const orch = new MultiAgentOrchestrator()
    const p = await orch.allocateWorktreeFor({
      childKernelId: 'id',
      agentType: 'Explore',
    })
    expect(p).toBeUndefined()
  })
})

// ── Audit §3.1 wire-up — InterAgentMailboxPort observer fan-out ──

describe('MultiAgentOrchestrator + InterAgentMailboxPort (audit §3.1)', () => {
  it('defaults to a noop mailbox port (deliverMailboxLine returns false)', () => {
    const orch = new MultiAgentOrchestrator()
    const delivered = orch.deliverMailboxLine({
      senderKernelId: 's',
      recipientKernelId: 'r',
      line: 'hi',
    })
    // Default port returns false (no real delivery happened).
    expect(delivered).toBe(false)
  })

  it('honours a constructor-supplied mailboxPort', () => {
    const calls: Array<{ senderKernelId: string; recipientKernelId: string; line: string }> = []
    const orch = new MultiAgentOrchestrator({
      mailboxPort: {
        deliver: (p) => {
          calls.push(p)
          return true
        },
      },
    })
    const ok = orch.deliverMailboxLine({
      senderKernelId: 'sender-1',
      recipientKernelId: 'agent-X',
      line: 'hello from sender',
    })
    expect(ok).toBe(true)
    expect(calls).toEqual([
      { senderKernelId: 'sender-1', recipientKernelId: 'agent-X', line: 'hello from sender' },
    ])
  })

  it('setMailboxPort hot-swaps and returns the previous port (decorator pattern)', () => {
    const firstCalls: string[] = []
    const secondCalls: string[] = []
    const first = { deliver: (p: { line: string }) => { firstCalls.push(p.line); return true } }
    const second = { deliver: (p: { line: string }) => { secondCalls.push(p.line); return true } }
    const orch = new MultiAgentOrchestrator({ mailboxPort: first })

    const returnedFromSwap = orch.setMailboxPort(second)
    // Returned port must be the FIRST one so caller can chain (decorator pattern).
    expect(returnedFromSwap).toBe(first)
    orch.deliverMailboxLine({ senderKernelId: 's', recipientKernelId: 'r', line: 'after-swap' })
    expect(firstCalls).toEqual([])
    expect(secondCalls).toEqual(['after-swap'])
  })

  it('port throwing during deliver does NOT bubble — observability must not break callers', () => {
    const orch = new MultiAgentOrchestrator({
      mailboxPort: {
        deliver: () => {
          throw new Error('port adapter is down')
        },
      },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Must NOT throw — observer-pattern semantics: telemetry never breaks delivery.
    expect(() => {
      orch.deliverMailboxLine({ senderKernelId: 's', recipientKernelId: 'r', line: 'boom' })
    }).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('mailboxPort.deliver threw'),
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })

  it('end-to-end: enqueueAgentMailboxMessage in activeAgentRegistry fans out to the singleton port', async () => {
    // Wire a tracking port into the SINGLETON orchestrator and verify that
    // `enqueueAgentMailboxMessage` (the canonical mailbox writer used by
    // `SendMessage` / coordinator / teammate paths) hits the port observer.
    //
    // Audit A-5 wire-up — `activeAgentRegistry.ts` was switched from a
    // lazy `require()` to a static `import` for this very integration:
    // vitest's CJS-on-ESM bridge produced two different module instances
    // for the singleton, breaking observer fan-out in test. Static import
    // unifies the cache.
    const { setMailboxPortForSingleton, resetMultiAgentOrchestratorForTests } =
      await import('../agents/multiAgentOrchestratorSingleton')
    const { enqueueAgentMailboxMessage } = await import('../agents/activeAgentRegistry')

    resetMultiAgentOrchestratorForTests()
    const observed: Array<{ senderKernelId: string; recipientKernelId: string; line: string }> = []
    setMailboxPortForSingleton({
      deliver: (p) => {
        observed.push(p)
        return true
      },
    })

    const fakeAgent = {
      agentId: 'agent-Z',
      pendingMessages: [] as string[],
      mailboxDroppedCount: 0,
      lastMailboxDropAt: 0,
    } as unknown as Parameters<typeof enqueueAgentMailboxMessage>[0]

    const result = enqueueAgentMailboxMessage(fakeAgent, 'broadcast', {
      senderKernelId: 'coordinator-7',
    })

    expect(result.ok).toBe(true)
    expect(fakeAgent.pendingMessages).toEqual(['broadcast'])
    expect(observed).toEqual([
      { senderKernelId: 'coordinator-7', recipientKernelId: 'agent-Z', line: 'broadcast' },
    ])

    resetMultiAgentOrchestratorForTests()
  })
})

// ── Audit fix M-3 — real in-memory directed mailbox ──────────────────────
describe('createInMemoryMailboxPort (M-3)', () => {
  it('delivers into a per-recipient FIFO queue and drain consumes it', () => {
    const port = createInMemoryMailboxPort()
    expect(port.deliver({ senderKernelId: 'a', recipientKernelId: 'r1', line: 'first' })).toBe(true)
    port.deliver({ senderKernelId: 'b', recipientKernelId: 'r1', line: 'second' })
    port.deliver({ senderKernelId: 'c', recipientKernelId: 'r2', line: 'other' })

    expect(port.size()).toBe(3)
    expect(port.recipientCount()).toBe(2)

    const drained = port.drain('r1')
    expect(drained.map((e) => e.line)).toEqual(['first', 'second'])
    expect(drained.map((e) => e.senderKernelId)).toEqual(['a', 'b'])
    // Drain consumed r1; r2 untouched.
    expect(port.drain('r1')).toEqual([])
    expect(port.peek('r2').map((e) => e.line)).toEqual(['other'])
  })

  it('rejects empty recipient and returns false', () => {
    const port = createInMemoryMailboxPort()
    expect(port.deliver({ senderKernelId: 'a', recipientKernelId: '  ', line: 'x' })).toBe(false)
    expect(port.size()).toBe(0)
  })

  it('bounds per-recipient queue (FIFO drop oldest on overflow)', () => {
    const port = createInMemoryMailboxPort({ maxPerRecipient: 2 })
    port.deliver({ senderKernelId: 's', recipientKernelId: 'r', line: '1' })
    port.deliver({ senderKernelId: 's', recipientKernelId: 'r', line: '2' })
    port.deliver({ senderKernelId: 's', recipientKernelId: 'r', line: '3' })
    expect(port.peek('r').map((e) => e.line)).toEqual(['2', '3'])
  })

  it('bounds recipient buckets via LRU (no unbounded growth without a consumer)', () => {
    const port = createInMemoryMailboxPort({ maxRecipients: 2 })
    port.deliver({ senderKernelId: 's', recipientKernelId: 'r1', line: 'a' })
    port.deliver({ senderKernelId: 's', recipientKernelId: 'r2', line: 'b' })
    // Touch r1 so r2 becomes the LRU bucket.
    port.deliver({ senderKernelId: 's', recipientKernelId: 'r1', line: 'a2' })
    // Adding r3 evicts the LRU (r2).
    port.deliver({ senderKernelId: 's', recipientKernelId: 'r3', line: 'c' })
    expect(port.recipientCount()).toBe(2)
    expect(port.peek('r2')).toEqual([])
    expect(port.peek('r1').map((e) => e.line)).toEqual(['a', 'a2'])
    expect(port.peek('r3').map((e) => e.line)).toEqual(['c'])
  })

  it('clearRecipient / clear drop queues', () => {
    const port = createInMemoryMailboxPort()
    port.deliver({ senderKernelId: 's', recipientKernelId: 'r1', line: 'x' })
    port.deliver({ senderKernelId: 's', recipientKernelId: 'r2', line: 'y' })
    port.clearRecipient('r1')
    expect(port.peek('r1')).toEqual([])
    expect(port.size()).toBe(1)
    port.clear()
    expect(port.size()).toBe(0)
    expect(port.recipientCount()).toBe(0)
  })
})

/**
 * Audit #10 (2026-07) — honest pause coverage. `pauseByConversation` /
 * `resumeByConversation` cascade by conversation id and report which children
 * actually support cooperative pause: a real kernel's `pause()` returns void
 * (→ supported); the legacy abort-shim (`abortControllerToKernelShim`)
 * returns `false` (→ unsupported). The IPC layer forwards these counts as
 * `childrenPaused` / `childrenUnsupported` so the renderer can toast
 * `pause_partial` instead of implying everything stopped.
 */
describe('pauseByConversation / resumeByConversation (audit #10)', () => {
  /** Same contract as `abortControllerToKernelShim`: pause/resume → false. */
  function makeShim(): { interrupt(): void; pause(): boolean; resume(): boolean } {
    return { interrupt: () => {}, pause: () => false, resume: () => false }
  }

  it('counts real kernels as supported and abort-shims as unsupported', () => {
    const orch = new MultiAgentOrchestrator()
    const kernel = makeKernel('conv-a')
    orch.register('real', kernel, {
      agentType: 'Explore',
      affinity: 'main_process',
      conversationId: 'conv-a',
    })
    orch.register('shim', makeShim(), {
      agentType: 'legacy-sub',
      affinity: 'main_process',
      conversationId: 'conv-a',
    })

    const r = orch.pauseByConversation('conv-a')
    expect(r).toEqual({ supported: 1, unsupported: 1 })
    expect(kernel.isPaused()).toBe(true)

    const r2 = orch.resumeByConversation('conv-a')
    expect(r2).toEqual({ supported: 1, unsupported: 1 })
    expect(kernel.isPaused()).toBe(false)
  })

  it('only cascades to kernels registered under the requested conversation', () => {
    const orch = new MultiAgentOrchestrator()
    const inConv = makeKernel('conv-a')
    const otherConv = makeKernel('conv-b')
    const noConv = makeKernel('conv-c')
    orch.register('in', inConv, {
      agentType: 'Explore',
      affinity: 'main_process',
      conversationId: 'conv-a',
    })
    orch.register('other', otherConv, {
      agentType: 'Explore',
      affinity: 'main_process',
      conversationId: 'conv-b',
    })
    // No conversationId in meta — must never match.
    orch.register('none', noConv, {
      agentType: 'Explore',
      affinity: 'main_process',
    })

    const r = orch.pauseByConversation('conv-a')
    expect(r).toEqual({ supported: 1, unsupported: 0 })
    expect(inConv.isPaused()).toBe(true)
    expect(otherConv.isPaused()).toBe(false)
    expect(noConv.isPaused()).toBe(false)
  })

  it('a pause() that throws counts as unsupported (not a crash)', () => {
    const orch = new MultiAgentOrchestrator()
    orch.register(
      'boom',
      {
        interrupt: () => {},
        pause: () => {
          throw new Error('no pause for you')
        },
        resume: () => {},
      },
      { agentType: 'gen', affinity: 'main_process', conversationId: 'conv-a' },
    )
    expect(orch.pauseByConversation('conv-a')).toEqual({ supported: 0, unsupported: 1 })
  })

  it('blank / unknown conversation id → zero counts, no cascade', () => {
    const orch = new MultiAgentOrchestrator()
    const kernel = makeKernel('conv-a')
    orch.register('k', kernel, {
      agentType: 'Explore',
      affinity: 'main_process',
      conversationId: 'conv-a',
    })
    expect(orch.pauseByConversation('')).toEqual({ supported: 0, unsupported: 0 })
    expect(orch.pauseByConversation('  ')).toEqual({ supported: 0, unsupported: 0 })
    expect(orch.pauseByConversation('conv-unknown')).toEqual({ supported: 0, unsupported: 0 })
    expect(kernel.isPaused()).toBe(false)
  })
})
