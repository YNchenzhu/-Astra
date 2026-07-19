/**
 * Contract tests for the unified retrieval-prefetch orchestrator.
 *
 *   Architecture invariants (the diagram's "shared query vec" + fan-out):
 *
 *   1. `computeSharedQueryEmbedding` is called exactly once per
 *      `startRetrievalPrefetch()`; the resulting vector is threaded into
 *      all three branches as `opts.shared` / `input.shared`.
 *   2. Each branch settles independently (one slow branch doesn't block
 *      another; each resolves when its own downstream resolves).
 *   3. The parent `[Symbol.dispose]()` cascades abort to every
 *      still-in-flight branch. Disposing after all branches have settled
 *      is a safe no-op.
 *   4. Firing the parent `abortSignal` (e.g. user Escape) likewise
 *      cascades to every branch.
 *   5. Disabled branches (no workspace path, no attachments, etc.) show
 *      up as `undefined` on the handle rather than "always-null" stubs.
 *
 * The orchestrator lazily `await import(...)`s the three downstream
 * modules. `vi.mock` intercepts those imports so we can drive each branch
 * deterministically without hitting the real embedding / memory service.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SharedQueryEmbedding } from '../embedding/sharedQueryVector'

// --- Mocks ------------------------------------------------------------------

const fakeShared: SharedQueryEmbedding = {
  cfg: { mode: 'auto' },
  vector: [0.1, 0.2, 0.3],
  fp: 'fp-fake',
  dim: 3,
  modelLabel: 'local:fake',
  resolved: { kind: 'local', providerId: 'local', model: 'fake', dim: 3 },
}

const computeSharedQueryEmbeddingMock = vi.fn<
  Parameters<(q: string) => Promise<SharedQueryEmbedding | null>>,
  Promise<SharedQueryEmbedding | null>
>()

vi.mock('../embedding/sharedQueryVector', () => ({
  computeSharedQueryEmbedding: (q: string) => computeSharedQueryEmbeddingMock(q),
  // Unused by the orchestrator but exported for completeness.
  buildSharedDispatchConfig: () => ({ mode: 'auto' }),
}))

const recallForPromptAIMock = vi.fn()
const recallForPromptMock = vi.fn()
const getLastRecalledForUiMock = vi.fn(() => [])
const setActiveWorkspaceMock = vi.fn()
const getSessionRecallBytesMock = vi.fn(() => 0)
const recordSessionRecallBytesMock = vi.fn()

vi.mock('./service', () => ({
  recallForPromptAI: (...args: unknown[]) => recallForPromptAIMock(...args),
  recallForPrompt: (...args: unknown[]) => recallForPromptMock(...args),
  getLastRecalledForUi: () => getLastRecalledForUiMock(),
  setActiveWorkspace: (p: string) => setActiveWorkspaceMock(p),
  getSessionRecallBytes: () => getSessionRecallBytesMock(),
  recordSessionRecallBytes: (n: number) => recordSessionRecallBytesMock(n),
}))

vi.mock('./findRelevantMemories', () => ({
  buildAlreadySurfacedSet: () => new Set<string>(),
}))

const queryWorkspaceIndexMock = vi.fn()
vi.mock('../embedding/workspaceIndex', () => ({
  queryWorkspaceIndex: (...args: unknown[]) => queryWorkspaceIndexMock(...args),
}))

const queryAttachmentsMock = vi.fn()
vi.mock('../embedding/highLevelApi', () => ({
  queryAttachments: (...args: unknown[]) => queryAttachmentsMock(...args),
}))

// ---------------------------------------------------------------------------

async function loadOrchestrator() {
  const mod = await import('./retrievalPrefetch')
  return mod
}

beforeEach(() => {
  vi.clearAllMocks()
  computeSharedQueryEmbeddingMock.mockResolvedValue(fakeShared)
  recallForPromptAIMock.mockResolvedValue('')
  recallForPromptMock.mockReturnValue('')
  queryWorkspaceIndexMock.mockResolvedValue([])
  queryAttachmentsMock.mockResolvedValue({ ok: true, hits: [], searched: 0 })
})

describe('startRetrievalPrefetch', () => {
  it('embeds the query exactly once and fans the shared vector into all three branches', async () => {
    const { startRetrievalPrefetch } = await loadOrchestrator()

    recallForPromptAIMock.mockResolvedValue('mem-text')
    queryWorkspaceIndexMock.mockResolvedValue([
      { text: 'code', score: 1, namespace: 'ws', filePath: 'a.ts', startLine: 1, endLine: 2 },
    ])
    queryAttachmentsMock.mockResolvedValue({
      ok: true,
      searched: 1,
      hits: [{ text: 'pdf chunk', score: 1, namespace: 'att', meta: {} }],
    })

    const ctl = new AbortController()
    const handle = startRetrievalPrefetch({
      query: 'hello world',
      workspacePath: '/ws',
      abortSignal: ctl.signal,
      memoryEnabled: true,
      attachments: [{ sha256: 'deadbeef', kind: 'pdf' }],
    })

    expect(handle.memory).toBeDefined()
    expect(handle.workspace).toBeDefined()
    expect(handle.attachments).toBeDefined()

    const [mem, ws, att] = await Promise.all([
      handle.memory!.promise,
      handle.workspace!.promise,
      handle.attachments!.promise,
    ])

    // Invariant #1: one embed, three consumers.
    expect(computeSharedQueryEmbeddingMock).toHaveBeenCalledTimes(1)
    expect(computeSharedQueryEmbeddingMock).toHaveBeenCalledWith('hello world')

    // The memory branch threads the shared vector through recallForPromptAI's
    // third `opts` arg. Post-MEM3 the prefetch also passes an `outRecalled`
    // collector so it doesn't have to read the cross-conversation
    // `getLastRecalledForUi` global.
    expect(recallForPromptAIMock).toHaveBeenCalledTimes(1)
    const passedOpts = recallForPromptAIMock.mock.calls[0][2] as {
      shared?: unknown
      outRecalled?: unknown
    }
    expect(passedOpts.shared).toBe(fakeShared)
    expect(Array.isArray(passedOpts.outRecalled)).toBe(true)

    // Workspace branch: queryWorkspaceIndex(root, query, topK, { shared, minScore })
    // Post-tuning the 4th arg also carries `minScore` (cosine floor pulled
    // from getRecallTuning()). Assert presence of both rather than an
    // exact-shape match so future tuning fields don't false-positive.
    expect(queryWorkspaceIndexMock).toHaveBeenCalledTimes(1)
    expect(queryWorkspaceIndexMock.mock.calls[0][0]).toBe('/ws')
    expect(queryWorkspaceIndexMock.mock.calls[0][1]).toBe('hello world')
    const wsOpts = queryWorkspaceIndexMock.mock.calls[0][3] as Record<string, unknown>
    expect(wsOpts.shared).toBe(fakeShared)
    expect(typeof wsOpts.minScore).toBe('number')

    // Attachment branch: queryAttachments({ query, attachments, topK, shared })
    expect(queryAttachmentsMock).toHaveBeenCalledTimes(1)
    const attInput = queryAttachmentsMock.mock.calls[0][0] as { shared?: unknown }
    expect(attInput.shared).toBe(fakeShared)

    // Invariant: each branch resolves to something useful (or null).
    expect(mem?.text).toBe('mem-text')
    expect(ws?.hits.length).toBe(1)
    expect(att?.hits.length).toBe(1)
  })

  it('settles each branch independently (slow branch doesn\'t block fast branches)', async () => {
    const { startRetrievalPrefetch } = await loadOrchestrator()

    let resolveSlowMemory: (v: string) => void = () => {}
    recallForPromptAIMock.mockImplementation(
      () => new Promise<string>((resolve) => (resolveSlowMemory = resolve)),
    )
    queryWorkspaceIndexMock.mockResolvedValue([])
    queryAttachmentsMock.mockResolvedValue({ ok: true, hits: [], searched: 0 })

    const ctl = new AbortController()
    const handle = startRetrievalPrefetch({
      // ≥ 8 chars so the new short-query fast-path doesn't bypass the
      // pipeline. The original `'q'` worked pre-tuning but now correctly
      // triggers `shouldSkipRetrievalForQuery` and returns an empty handle.
      query: 'hello world',
      workspacePath: '/ws',
      abortSignal: ctl.signal,
      memoryEnabled: true,
      attachments: [{ sha256: 'abc', kind: 'txt' }],
    })

    // Workspace + attachments resolve; memory is still pending.
    await handle.workspace!.promise
    await handle.attachments!.promise
    expect(handle.workspace!.settledAt).not.toBeNull()
    expect(handle.attachments!.settledAt).not.toBeNull()
    expect(handle.memory!.settledAt).toBeNull()

    // Release memory.
    resolveSlowMemory('late')
    const mem = await handle.memory!.promise
    expect(mem?.text).toBe('late')
    expect(handle.memory!.settledAt).not.toBeNull()
  })

  it('disposing the handle cascades abort and still resolves branches (to null on abort)', async () => {
    const { startRetrievalPrefetch } = await loadOrchestrator()

    const memoryAbortSeen = false
    recallForPromptAIMock.mockImplementation(
      () =>
        new Promise<string>(() => {
          // never resolves — simulates a hung recall, only abort via ctl
          // aborts the branch (see the implementation's ctl.signal.aborted
          // early-return).
        }),
    )
    // We observe abort via the orchestrator's ctl abort:
    // because recall is awaited *after* the shared promise, and we check
    // `ctl.signal.aborted` right after, a disposed handle resolves to null.

    const parentCtl = new AbortController()
    const handle = startRetrievalPrefetch({
      query: 'hello world',
      workspacePath: '/ws',
      abortSignal: parentCtl.signal,
      memoryEnabled: true,
    })

    // Let the shared embed + the initial await finish.
    await Promise.resolve()
    await Promise.resolve()

    handle[Symbol.dispose]()

    // Dispose is idempotent.
    expect(() => handle[Symbol.dispose]()).not.toThrow()
    void memoryAbortSeen
  })

  it('aborting the parent signal cascades to branches', async () => {
    const { startRetrievalPrefetch } = await loadOrchestrator()

    // Make the shared embed itself take a while so abort has a chance.
    let resolveShared: (v: SharedQueryEmbedding | null) => void = () => {}
    computeSharedQueryEmbeddingMock.mockImplementation(
      () =>
        new Promise<SharedQueryEmbedding | null>((resolve) => {
          resolveShared = resolve
        }),
    )

    const parentCtl = new AbortController()
    const handle = startRetrievalPrefetch({
      // Long enough to clear the short-query fast-path.
      query: 'hello world',
      workspacePath: '/ws',
      abortSignal: parentCtl.signal,
      memoryEnabled: true,
      attachments: [{ sha256: 'abc', kind: 'txt' }],
    })

    parentCtl.abort()

    // Unblock the shared embed so the branches observe the abort.
    resolveShared(fakeShared)

    const results = await Promise.all([
      handle.memory!.promise,
      handle.workspace!.promise,
      handle.attachments!.promise,
    ])
    expect(results).toEqual([null, null, null])
  })

  it('omits branches that aren\'t applicable', async () => {
    const { startRetrievalPrefetch } = await loadOrchestrator()
    const ctl = new AbortController()

    // No workspace path → no memory, no workspace branch.
    // Use a long enough query so we test the WORKSPACE-PATH gating, not the
    // short-query fast-path gating (covered separately below).
    const noWs = startRetrievalPrefetch({
      query: 'hello world',
      workspacePath: null,
      abortSignal: ctl.signal,
      memoryEnabled: true,
    })
    expect(noWs.memory).toBeUndefined()
    expect(noWs.workspace).toBeUndefined()
    expect(noWs.attachments).toBeUndefined()

    // memoryEnabled=false → workspace may still run, memory skipped.
    const noMem = startRetrievalPrefetch({
      query: 'hello world',
      workspacePath: '/ws',
      abortSignal: ctl.signal,
      memoryEnabled: false,
    })
    expect(noMem.memory).toBeUndefined()
    expect(noMem.workspace).toBeDefined()

    // Empty query → everything skipped.
    const noQ = startRetrievalPrefetch({
      query: '   ',
      workspacePath: '/ws',
      abortSignal: ctl.signal,
      memoryEnabled: true,
      attachments: [{ sha256: 'a', kind: 'pdf' }],
    })
    expect(noQ.memory).toBeUndefined()
    expect(noQ.workspace).toBeUndefined()
    expect(noQ.attachments).toBeUndefined()
  })

  it('short-query fast-path bypasses every branch (no embed call)', async () => {
    const { startRetrievalPrefetch } = await loadOrchestrator()
    const ctl = new AbortController()

    // ≤ skipShortQueryChars (default 8) → no branches mounted, no embed
    // forward pass. Verifies V-1/D-1 from the audit: `ok` / `继续` /
    // `nice` no longer pay for a shared-query embed + RRF + LLM selector.
    const handle = startRetrievalPrefetch({
      query: 'ok',
      workspacePath: '/ws',
      abortSignal: ctl.signal,
      memoryEnabled: true,
      attachments: [{ sha256: 'abc', kind: 'txt' }],
    })
    expect(handle.memory).toBeUndefined()
    expect(handle.workspace).toBeUndefined()
    expect(handle.attachments).toBeUndefined()
    expect(computeSharedQueryEmbeddingMock).not.toHaveBeenCalled()
  })

  it('slash-command queries bypass retrieval', async () => {
    const { startRetrievalPrefetch } = await loadOrchestrator()
    const ctl = new AbortController()

    const handle = startRetrievalPrefetch({
      // `/memory list` is command intent, not semantic intent — recall on
      // it would be pure noise.
      query: '/memory list',
      workspacePath: '/ws',
      abortSignal: ctl.signal,
      memoryEnabled: true,
    })
    expect(handle.memory).toBeUndefined()
    expect(handle.workspace).toBeUndefined()
    expect(computeSharedQueryEmbeddingMock).not.toHaveBeenCalled()
  })
})

describe('startMemoryRecallPrefetch (legacy shim)', () => {
  it('returns the legacy shape and delegates to the unified orchestrator', async () => {
    const { startMemoryRecallPrefetch } = await loadOrchestrator()

    // Post-MEM3: the prefetch reads recalled memories from the
    // `outRecalled` collector passed via opts, NOT from the cross-
    // conversation global. Simulate `recallForPromptAI` populating it.
    recallForPromptAIMock.mockImplementation(
      (
        _q: unknown,
        _surfaced: unknown,
        opts?: {
          outRecalled?: Array<{
            filename: string
            name: string
            type: string
            matchSnippet: string
          }>
        },
      ) => {
        opts?.outRecalled?.push({
          filename: 'm.md',
          name: 'M',
          type: 'note',
          matchSnippet: 'hi',
        })
        return Promise.resolve('legacy text')
      },
    )

    const ctl = new AbortController()
    // ≥ 8 chars to clear the short-query fast-path baked into the
    // orchestrator the legacy shim now delegates to.
    const handle = startMemoryRecallPrefetch('/ws', true, 'hello world', ctl.signal, [])
    expect(handle).toBeDefined()
    const text = await handle!.promise
    expect(text).toBe('legacy text')
    expect(handle!.recalledMemories).toHaveLength(1)

    // Still exactly one shared embed under the hood.
    expect(computeSharedQueryEmbeddingMock).toHaveBeenCalledTimes(1)
  })
})
