/**
 * in-memory CheckpointPort + kernel integration.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createInMemoryCheckpointPort,
  type CheckpointPort,
} from './checkpoint'
import { createInitialKernelLoopState } from './kernelTypes'
import { OrchestrationKernel } from './kernel'
import { createTransportAdapter, noopHookPolicy } from './transport'
import { DefaultToolRuntimePort } from './toolRuntime/defaultToolRuntimePort'
import { createNoopMcpSessionAdapter } from './mcpSessionAdapter'

vi.mock('./phases/iteration', () => ({
  runAgenticLoop: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../agents/agentContext', () => ({
  getAgentContext: vi.fn().mockReturnValue(null),
}))

describe('createInMemoryCheckpointPort', () => {
  it('snapshot returns id and stores cloned state', () => {
    const port = createInMemoryCheckpointPort()
    const state = createInitialKernelLoopState([{ role: 'user', content: 'hi' }])
    const id = port.snapshot('tag-1', state)
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    const listed = port.list()
    expect(listed).toHaveLength(1)
    expect(listed[0].state).not.toBe(state)
    expect(listed[0].state.transcript).toEqual(state.transcript)
  })

  it('rewind preserves prior branch and appends fork marker pointing at the rewound id (P1.2)', () => {
    const port = createInMemoryCheckpointPort()
    const base = createInitialKernelLoopState([])
    const idA = port.snapshot('a', base)
    const idB = port.snapshot('b', { ...base, iteration: 1 })
    const idC = port.snapshot('c', { ...base, iteration: 2 })
    expect(port.list()).toHaveLength(3)

    const restored = port.rewind(idA)
    expect(restored?.iteration).toBe(0)
    // Non-truncating: original 3 entries kept + a new `rewind:a` fork.
    const after = port.list()
    expect(after).toHaveLength(4)
    expect(after.slice(0, 3).map((e) => e.id)).toEqual([idA, idB, idC])
    const fork = after[3]
    expect(fork.tag).toBe('rewind:a')
    expect(fork.parentId).toBe(idA)
    // Branch head is now the fork — subsequent snapshots will chain from it.
    expect(port.getBranchHead()).toBe(fork.id)
    const idD = port.snapshot('d', { ...base, iteration: 5 })
    expect(port.peek(idD)?.parentId).toBe(fork.id)
  })

  it('fork records a sibling marker, returns cloned state, and does NOT move the branch head', () => {
    const port = createInMemoryCheckpointPort()
    const base = createInitialKernelLoopState([])
    const idA = port.snapshot('a', base)
    const idB = port.snapshot('b', { ...base, iteration: 1 })
    expect(port.getBranchHead()).toBe(idB)

    // Fan out two forks off the SAME base A.
    const f1 = port.fork(idA)
    const f2 = port.fork(idA)
    expect(f1?.iteration).toBe(0)
    expect(f2?.iteration).toBe(0)
    // Cloned, not aliased.
    expect(f1).not.toBe(base)

    // Branch head is unchanged — main branch keeps advancing from B.
    expect(port.getBranchHead()).toBe(idB)
    const idC = port.snapshot('c', { ...base, iteration: 2 })
    expect(port.peek(idC)?.parentId).toBe(idB)

    // Two fork markers, both children of A.
    const forks = port.list().filter((e) => e.tag === 'fork:a')
    expect(forks).toHaveLength(2)
    expect(forks.every((e) => e.parentId === idA)).toBe(true)
  })

  it('fork returns null for an unknown id', () => {
    const port = createInMemoryCheckpointPort()
    port.snapshot('a', createInitialKernelLoopState([]))
    expect(port.fork('nope')).toBeNull()
  })

  it('rewind returns null for unknown id and does not mutate history', () => {
    const port = createInMemoryCheckpointPort()
    const idA = port.snapshot('a', createInitialKernelLoopState([]))
    expect(port.rewind('nope')).toBeNull()
    expect(port.list()).toHaveLength(1)
    expect(port.getBranchHead()).toBe(idA)
  })

  it('linear snapshots chain via parentId; first entry has no parent (P1.2)', () => {
    const port = createInMemoryCheckpointPort()
    const base = createInitialKernelLoopState([])
    const idA = port.snapshot('a', base)
    const idB = port.snapshot('b', { ...base, iteration: 1 })
    const idC = port.snapshot('c', { ...base, iteration: 2 })
    const all = port.list()
    expect(all[0].parentId).toBeUndefined()
    expect(all[1].parentId).toBe(idA)
    expect(all[2].parentId).toBe(idB)
    expect(port.getBranchHead()).toBe(idC)
  })

  it('LRU evicts parent → orphan descendants surface as roots in listTree (G5)', () => {
    // maxEntries=2 so the first snapshot gets evicted by the third snapshot. The third's
    // `parentId` then points at an evicted entry — `listTree` should treat such nodes as
    // disconnected roots (they're still reachable, just no longer under their original
    // chain).
    const port = createInMemoryCheckpointPort({ maxEntries: 2 })
    const base = createInitialKernelLoopState([])
    const idA = port.snapshot('a', base)
    const idB = port.snapshot('b', { ...base, iteration: 1 })
    const idC = port.snapshot('c', { ...base, iteration: 2 })

    // After C is inserted: A was evicted (FIFO), entries hold B and C.
    const all = port.list()
    expect(all).toHaveLength(2)
    expect(all.map((e) => e.id)).toEqual([idB, idC])
    // B's parentId still points at the (now-evicted) A → B is "orphaned" from listTree's
    // perspective (parent not in `entries`). It should appear in listTree as a root.
    const tree = port.listTree()
    expect(tree.map((e) => e.id)).toEqual([idB, idC])
    expect(tree[0].parentId).toBe(idA) // dangling pointer preserved on the entry itself
    expect(tree[1].parentId).toBe(idB) // intact within remaining entries
    void void void void idA // satisfy unused-binding lint
  })

  it('listTree groups branches: original chain first, then forked branch (P1.2)', () => {
    const port = createInMemoryCheckpointPort()
    const base = createInitialKernelLoopState([])
    const idA = port.snapshot('a', base)
    const idB = port.snapshot('b', { ...base, iteration: 1 })
    port.snapshot('c', { ...base, iteration: 2 })
    // Fork at A.
    port.rewind(idA)
    // Continue on the new branch.
    port.snapshot('d', { ...base, iteration: 10 })

    const tree = port.listTree()
    // Order: a → b → c (original chain depth-first), then the fork's rewind marker → d.
    // The fork marker has parentId === idA, so the walk emits the entire A chain first,
    // then walks back to the fork branch as a sibling.
    expect(tree.map((e) => e.tag)).toEqual(['a', 'b', 'c', 'rewind:a', 'd'])
    expect(tree[3].parentId).toBe(idA)
    expect(tree[4].parentId).toBe(tree[3].id)
    // listTree leaves `list()` unchanged.
    expect(port.list()).toHaveLength(5)
    void idB
  })

  it('maxEntries evicts oldest FIFO', () => {
    const port = createInMemoryCheckpointPort({ maxEntries: 2 })
    const s = createInitialKernelLoopState([])
    port.snapshot('a', s)
    const idB = port.snapshot('b', s)
    const idC = port.snapshot('c', s)
    const listed = port.list()
    expect(listed.map((e) => e.id)).toEqual([idB, idC])
  })

  it('peek does not mutate history', () => {
    const port = createInMemoryCheckpointPort()
    const idA = port.snapshot('a', createInitialKernelLoopState([]))
    port.snapshot('b', createInitialKernelLoopState([]))
    const peeked = port.peek(idA)
    expect(peeked).not.toBeNull()
    expect(port.list()).toHaveLength(2)
  })

  it('clear empties entries', () => {
    const port = createInMemoryCheckpointPort()
    port.snapshot('a', createInitialKernelLoopState([]))
    port.clear()
    expect(port.list()).toHaveLength(0)
  })
})

describe('OrchestrationKernel + CheckpointPort ', () => {
  afterEach(async () => {
    const { runAgenticLoop } = await import('./phases/iteration')
    vi.mocked(runAgenticLoop).mockReset()
    vi.mocked(runAgenticLoop).mockResolvedValue(undefined)
  })

  it('snapshot() + rewind() round-trip kernel state', () => {
    const checkpointPort: CheckpointPort = createInMemoryCheckpointPort()
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: createNoopMcpSessionAdapter(),
      transport: createTransportAdapter(vi.fn()),
      hooks: noopHookPolicy,
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([{ role: 'user', content: 'hi' }]),
      'conv-cp',
      { checkpointPort },
    )
    const id = kernel.snapshot('before_tool')!
    expect(id).toBeDefined()
    kernel.enqueueInboxItem({ kind: 'synthetic_user_text', text: 'late' })
    expect(kernel.getState().inbox).toHaveLength(1)
    const ok = kernel.rewind(id)
    expect(ok).toBe(true)
    expect(kernel.getState().inbox).toHaveLength(0)
  })

  it('auto snapshots post_prepare_context and post_terminal when port wired', async () => {
    const checkpointPort: CheckpointPort = createInMemoryCheckpointPort()
    const emit = vi.fn()
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: createNoopMcpSessionAdapter(),
      transport: createTransportAdapter(emit),
      hooks: noopHookPolicy,
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-auto-cp',
      { checkpointPort },
    )
    await kernel.runLegacyDelegateMainChat({
      rendererMessages: [{ role: 'user', content: 'auto' }],
      agenticParams: {
        config: { id: 'anthropic', apiKey: 'x' } as import('../ai/client').ProviderConfig,
        model: 'claude',
        messages: [],
        signal: new AbortController().signal,
      },
      agenticCallbacks: {
        onTextDelta: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onMessageEnd: vi.fn(),
        onError: vi.fn(),
      },
    })
    const tags = checkpointPort.list().map((e) => e.tag)
    expect(tags).toContain('post_prepare_context')
    expect(tags).toContain('post_terminal')
  })

  it('snapshot returns undefined when no checkpoint port configured', () => {
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: createNoopMcpSessionAdapter(),
      transport: createTransportAdapter(vi.fn()),
      hooks: noopHookPolicy,
    }
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([]),
      'conv-no-cp',
    )
    expect(kernel.snapshot('x')).toBeUndefined()
    expect(kernel.rewind('any')).toBe(false)
  })
})

// ── Audit §3.2 wire-up — registry helpers for peek / listTree / branchHead ──

describe('activeKernelRegistry checkpoint helpers (audit §3.2)', () => {
  afterEach(async () => {
    const { clearOrchestrationKernelRegistryForTests } = await import('./activeKernelRegistry')
    clearOrchestrationKernelRegistryForTests()
  })

  async function setupKernelWithCheckpoint(): Promise<{
    kernel: OrchestrationKernel
    convId: string
    initialId: string
  }> {
    const {
      registerOrchestrationKernelForConversation,
    } = await import('./activeKernelRegistry')
    const checkpointPort: CheckpointPort = createInMemoryCheckpointPort()
    const ports = {
      tools: new DefaultToolRuntimePort({ get: () => null, set: () => {} }),
      permission: { noteToolInvocation: vi.fn() },
      session: createNoopMcpSessionAdapter(),
      transport: createTransportAdapter(vi.fn()),
      hooks: noopHookPolicy,
    }
    const convId = `conv-helpers-${Math.random().toString(36).slice(2, 8)}`
    const kernel = new OrchestrationKernel(
      ports,
      undefined,
      createInitialKernelLoopState([{ role: 'user', content: 'hi' }]),
      convId,
      { checkpointPort },
    )
    registerOrchestrationKernelForConversation(convId, kernel)
    const initialId = kernel.snapshot('first')!
    return { kernel, convId, initialId }
  }

  it('listOrchestrationKernelCheckpointTree returns tree-ordered checkpoints', async () => {
    const { listOrchestrationKernelCheckpointTree } = await import('./activeKernelRegistry')
    const { convId, initialId, kernel } = await setupKernelWithCheckpoint()
    const secondId = kernel.snapshot('second')!

    const tree = listOrchestrationKernelCheckpointTree(convId)
    expect(tree.length).toBeGreaterThanOrEqual(2)
    expect(tree.map((c) => c.id)).toContain(initialId)
    expect(tree.map((c) => c.id)).toContain(secondId)
  })

  it('peekOrchestrationKernelCheckpoint returns the checkpoint without mutating history', async () => {
    const {
      peekOrchestrationKernelCheckpoint,
      listOrchestrationKernelCheckpoints,
    } = await import('./activeKernelRegistry')
    const { convId, initialId } = await setupKernelWithCheckpoint()
    const before = listOrchestrationKernelCheckpoints(convId).length

    const peeked = peekOrchestrationKernelCheckpoint(convId, initialId)
    expect(peeked).not.toBeNull()
    expect(peeked!.id).toBe(initialId)
    expect(peeked!.tag).toBe('first')
    // Peek must not mutate.
    expect(listOrchestrationKernelCheckpoints(convId)).toHaveLength(before)
  })

  it('peekOrchestrationKernelCheckpoint returns null for unknown id', async () => {
    const { peekOrchestrationKernelCheckpoint } = await import('./activeKernelRegistry')
    const { convId } = await setupKernelWithCheckpoint()
    expect(peekOrchestrationKernelCheckpoint(convId, 'nonexistent-id')).toBeNull()
  })

  it('getOrchestrationKernelBranchHead returns the most-recent snapshot id', async () => {
    const { getOrchestrationKernelBranchHead } = await import('./activeKernelRegistry')
    const { convId, kernel, initialId } = await setupKernelWithCheckpoint()
    expect(getOrchestrationKernelBranchHead(convId)).toBe(initialId)

    const newerId = kernel.snapshot('newer')!
    expect(getOrchestrationKernelBranchHead(convId)).toBe(newerId)
  })

  it('all helpers degrade to undefined/null/[] when conversation has no kernel', async () => {
    const {
      peekOrchestrationKernelCheckpoint,
      getOrchestrationKernelBranchHead,
      listOrchestrationKernelCheckpointTree,
    } = await import('./activeKernelRegistry')
    expect(peekOrchestrationKernelCheckpoint('no-such-conv', 'any-id')).toBeNull()
    expect(getOrchestrationKernelBranchHead('no-such-conv')).toBeUndefined()
    expect(listOrchestrationKernelCheckpointTree('no-such-conv')).toEqual([])
  })
})

// ── Audit fix M-2 — durable (file-backed) checkpoint port ────────────────
describe('createFileCheckpointPort (M-2 durability)', () => {
  const tmpRoots: string[] = []
  const mkTmp = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'))
    tmpRoots.push(dir)
    return dir
  }

  afterEach(() => {
    for (const d of tmpRoots.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('rewind/fork survive a simulated process restart (re-construct from disk)', async () => {
    const { createFileCheckpointPort } = await import('./checkpoint')
    const baseDir = mkTmp()
    const conversationId = 'conv-durable-1'

    // First "process": take two snapshots (debounceMs:0 → synchronous write).
    const port1 = createFileCheckpointPort({ baseDir, conversationId, debounceMs: 0 })
    const base = createInitialKernelLoopState([{ role: 'user', content: 'hi' }])
    port1.snapshot('a', base)
    const idB = port1.snapshot('b', { ...base, iteration: 2 })
    expect(port1.getBranchHead()).toBe(idB)

    // Second "process": a fresh port for the SAME conversation hydrates from disk.
    const port2 = createFileCheckpointPort({ baseDir, conversationId, debounceMs: 0 })
    expect(port2.list()).toHaveLength(2)
    expect(port2.getBranchHead()).toBe(idB)
    // The persisted state is intact and can be rewound to.
    const idA = port2.list()[0].id
    const restored = port2.rewind(idA)
    expect(restored?.iteration).toBe(0)
    // Rewind fork was appended + persisted (3 entries now).
    expect(port2.list()).toHaveLength(3)

    // Third "process": sees the rewind fork too.
    const port3 = createFileCheckpointPort({ baseDir, conversationId, debounceMs: 0 })
    expect(port3.list()).toHaveLength(3)
  })

  it('M-5: debounced writes coalesce and flushNow forces them to disk', async () => {
    const { createFileCheckpointPort } = await import('./checkpoint')
    const baseDir = mkTmp()
    const conversationId = 'conv-debounce'
    const port = createFileCheckpointPort({ baseDir, conversationId, debounceMs: 10_000 })
    const base = createInitialKernelLoopState([])
    port.snapshot('a', base)
    port.snapshot('b', { ...base, iteration: 1 })
    // Nothing written yet (still inside the debounce window).
    expect(
      createFileCheckpointPort({ baseDir, conversationId, debounceMs: 0 }).list(),
    ).toHaveLength(0)
    // flushNow forces the coalesced write.
    port.flushNow?.()
    expect(
      createFileCheckpointPort({ baseDir, conversationId, debounceMs: 0 }).list(),
    ).toHaveLength(2)
  })

  it('isolates conversations by file and deleteFileCheckpointTree drops only the target', async () => {
    const { createFileCheckpointPort, deleteFileCheckpointTree } = await import('./checkpoint')
    const baseDir = mkTmp()
    const a = createFileCheckpointPort({ baseDir, conversationId: 'conv-A', debounceMs: 0 })
    const b = createFileCheckpointPort({ baseDir, conversationId: 'conv-B', debounceMs: 0 })
    a.snapshot('a', createInitialKernelLoopState([]))
    b.snapshot('b', createInitialKernelLoopState([]))

    deleteFileCheckpointTree(baseDir, 'conv-A')

    // conv-A reconstructs empty; conv-B is untouched.
    expect(
      createFileCheckpointPort({ baseDir, conversationId: 'conv-A', debounceMs: 0 }).list(),
    ).toHaveLength(0)
    expect(
      createFileCheckpointPort({ baseDir, conversationId: 'conv-B', debounceMs: 0 }).list(),
    ).toHaveLength(1)
  })
})
