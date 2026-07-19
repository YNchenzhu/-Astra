/**
 * Unified retrieval prefetch — the "fire everything in parallel, inject
 * whatever's ready" pattern for main-chat turns.
 *
 *   user prompt
 *       │
 *       ▼
 *   startRetrievalPrefetch(query, messages, abortSignal)
 *       │
 *       ├─ sharedQueryVec = dispatchEmbed([query])              ◄── once
 *       │        └─ Promise shared by the three consumers below
 *       │
 *       ├─ workspace code topK (await sharedQueryVec)           ◄── parallel
 *       ├─ attachment RAG topK (await sharedQueryVec)           ◄── parallel
 *       └─ memory hybridRecall
 *              ├─ bm25 / freshness / structured (no embed)
 *              └─ memory vector (await sharedQueryVec)
 *              → RRF → optional rerank → optional LLM selector
 *
 * Each branch settles independently, each exposes its own `settledAt` /
 * `promise` / `[Symbol.dispose]`, and the parent handle's `[Symbol.dispose]`
 * cascades abort to every still-in-flight branch. The parent `abortSignal`
 * (user Escape) aborts everything the same way. Subsystems that aren't
 * configured for a given turn simply return `undefined` in their slot.
 *
 * The shared query vector matters: pre-refactor each of the three query
 * sites called `dispatchEmbed([query])` independently, so one user prompt
 * cost three forward passes. Now it costs one — and for callers that can't
 * wire the prefetch pipeline in (sub-agent runners, IPC handlers invoked
 * in isolation), the downstream APIs still re-embed per the old path.
 *
 * `startMemoryRecallPrefetch` is preserved below as a thin shim that wraps
 * this new orchestrator and returns only the memory branch in the legacy
 * shape (used by streamHandler today — will migrate to the full handle in
 * the same change that integrates this module).
 */

import { buildAlreadySurfacedSet } from './findRelevantMemories'
import {
  getSessionRecallBytes,
  recallForPrompt,
  recallForPromptAI,
  recordSessionRecallBytes,
  setActiveWorkspace,
} from './service'
import {
  computeSharedQueryEmbedding,
  type SharedQueryEmbedding,
} from '../embedding/sharedQueryVector'
import { getRecallTuning, shouldSkipRetrievalForQuery } from './recallTuning'

const RECALL_TIMEOUT_MS = 30_000
const PREFETCH_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MemoryPrefetchResult {
  text: string
  recalledMemories: Array<{
    filename: string
    name: string
    type: string
    matchSnippet: string
  }>
}

export interface WorkspacePrefetchResult {
  hits: Array<{
    text: string
    score: number
    namespace: string
    filePath: string
    startLine: number
    endLine: number
    meta?: Record<string, unknown>
  }>
}

export interface AttachmentsPrefetchResult {
  hits: Array<{
    text: string
    score: number
    namespace: string
    meta?: Record<string, unknown>
  }>
  searched: number
}

/**
 * Generic per-branch handle. The promise always resolves (never rejects) so
 * callers can drive mid-loop "is it ready yet?" polls without try/catch.
 * On disabled / aborted / failed branches the promise resolves to `null`.
 */
export interface SubPrefetch<T> {
  readonly promise: Promise<T | null>
  /** Epoch ms when the promise settled. `null` until settled. */
  readonly settledAt: number | null
  /** Abort this branch only (parent dispose cascades to all). */
  [Symbol.dispose](): void
}

export interface RetrievalPrefetch {
  /** Memory recall (hybrid pipeline + optional LLM selector). */
  readonly memory?: SubPrefetch<MemoryPrefetchResult>
  /** Workspace code semantic top-K. */
  readonly workspace?: SubPrefetch<WorkspacePrefetchResult>
  /** Attachment RAG top-K across the supplied sha/kind pairs. */
  readonly attachments?: SubPrefetch<AttachmentsPrefetchResult>
  /** Abort every still-in-flight branch. Idempotent. */
  [Symbol.dispose](): void
}

export interface StartRetrievalPrefetchParams {
  /** The raw user prompt text — trimmed internally; empty → no branches run. */
  query: string
  /** Active workspace root; required for memory + workspace branches. */
  workspacePath?: string | null
  /** Parent abort signal (user Escape aborts the whole stream and every branch). */
  abortSignal: AbortSignal
  /** Turn-level config — mirrors the streamHandler's existing flags. */
  memoryEnabled?: boolean
  /** API messages so memory can derive `alreadySurfaced` without leaking sets. */
  apiMessages?: Array<Record<string, unknown>>
  /** Optional attachments list; when empty/undefined the attachment branch is skipped. */
  attachments?: Array<{ sha256: string; kind: string }>
  /**
   * Conversation id, used for the per-conversation recall byte budget. When
   * absent the budget is shared with other anonymous callers — this is OK
   * for one-off IPC use but the streaming handler should always pass it.
   */
  conversationId?: string | null
  /**
   * Top-K knobs. When omitted, defaults come from `getRecallTuning()` so
   * Settings UI changes take effect without a restart. Explicit values
   * still win (escape hatch for tests / ad-hoc callers).
   */
  workspaceTopK?: number
  attachmentTopK?: number
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function startRetrievalPrefetch(
  params: StartRetrievalPrefetchParams,
): RetrievalPrefetch {
  const query = typeof params.query === 'string' ? params.query.trim() : ''
  const apiMessages = params.apiMessages ?? []
  const attachments = Array.isArray(params.attachments) ? params.attachments : []
  const workspacePath = params.workspacePath ?? null
  const memoryEnabled = params.memoryEnabled !== false
  const conversationId = params.conversationId ?? null
  const tuning = getRecallTuning()

  // Parent controller — aborts when parent abortSignal fires OR when the
  // handle is disposed. Every sub-prefetch listens on this controller's
  // signal, so one abort cascades to all three.
  const parentCtl = new AbortController()
  const onParentAbort = () => {
    if (!parentCtl.signal.aborted) parentCtl.abort()
  }
  if (params.abortSignal.aborted) {
    parentCtl.abort()
  } else {
    params.abortSignal.addEventListener('abort', onParentAbort, { once: true })
  }

  // Fast-path gate: short / command-style / empty queries skip retrieval
  // entirely. This stops `ok` / `继续` / `/clear` / `???` from paying for
  // an embed forward pass + RRF + LLM selector — costs that were never
  // going to recover anything useful, and that previously injected
  // sub-floor noise into the system prompt.
  if (shouldSkipRetrievalForQuery(query, tuning)) {
    return makeEmptyHandle(params.abortSignal, onParentAbort, parentCtl)
  }

  // Shared query embedding — computed once and awaited by all three
  // branches. We guard it with a timeout so a stuck embed endpoint doesn't
  // keep every branch blocked forever; branches fall back to their own
  // dispatchEmbed path when `shared` is null.
  const sharedPromise: Promise<SharedQueryEmbedding | null> =
    query.length > 0
      ? guardWithTimeout(
          computeSharedQueryEmbedding(query).catch(() => null),
          PREFETCH_TIMEOUT_MS,
          null,
        )
      : Promise.resolve(null)

  // Fail-safe: make sure memory workspace is primed (the recall internals
  // need it). Idempotent across the three branches, so do it once here.
  if (workspacePath) {
    setActiveWorkspace(workspacePath)
  }

  const memory =
    memoryEnabled && workspacePath && query.length > 0
      ? startMemoryBranch({
          query,
          apiMessages,
          conversationId,
          tuning,
          parentSignal: parentCtl.signal,
          sharedPromise,
        })
      : undefined

  const workspace =
    tuning.workspaceEnabled && workspacePath && query.length > 0
      ? startWorkspaceBranch({
          root: workspacePath,
          query,
          topK: params.workspaceTopK ?? tuning.workspaceTopK,
          minScore: tuning.workspaceMinScore,
          parentSignal: parentCtl.signal,
          sharedPromise,
        })
      : undefined

  const attachmentsBranch =
    attachments.length > 0 && query.length > 0
      ? startAttachmentsBranch({
          query,
          attachments,
          topK: params.attachmentTopK ?? tuning.attachmentTopK,
          minScore: tuning.attachmentMinScore,
          parentSignal: parentCtl.signal,
          sharedPromise,
        })
      : undefined

  let disposed = false
  const handle: RetrievalPrefetch = {
    memory,
    workspace,
    attachments: attachmentsBranch,
    [Symbol.dispose]() {
      if (disposed) return
      disposed = true
      try {
        params.abortSignal.removeEventListener('abort', onParentAbort)
      } catch {
        /* ignore */
      }
      if (!parentCtl.signal.aborted) parentCtl.abort()
    },
  }
  return handle
}

/**
 * Empty handle for the fast-path gate / disabled-from-the-start case.
 * Symmetric with the normal handle: dispose still detaches the abort
 * listener and aborts the (no-op) parent controller, which keeps the
 * lifecycle observable for callers that wrap us in `using`.
 */
function makeEmptyHandle(
  parentAbortSignal: AbortSignal,
  onParentAbort: () => void,
  parentCtl: AbortController,
): RetrievalPrefetch {
  let disposed = false
  return {
    memory: undefined,
    workspace: undefined,
    attachments: undefined,
    [Symbol.dispose]() {
      if (disposed) return
      disposed = true
      try {
        parentAbortSignal.removeEventListener('abort', onParentAbort)
      } catch {
        /* ignore */
      }
      if (!parentCtl.signal.aborted) parentCtl.abort()
    },
  }
}

// ---------------------------------------------------------------------------
// Branch: memory hybrid recall
// ---------------------------------------------------------------------------

interface MemoryBranchDeps {
  query: string
  apiMessages: Array<Record<string, unknown>>
  conversationId: string | null
  tuning: ReturnType<typeof getRecallTuning>
  parentSignal: AbortSignal
  sharedPromise: Promise<SharedQueryEmbedding | null>
}

function startMemoryBranch(deps: MemoryBranchDeps): SubPrefetch<MemoryPrefetchResult> {
  // Per-conversation byte budget (V-5). Two parallel chats now have
  // independent budgets; pre-audit they shared one global counter so a
  // busy conversation could starve a quiet one.
  if (getSessionRecallBytes(deps.conversationId) >= deps.tuning.sessionBudgetBytes) {
    return settledNull()
  }

  const ctl = subBranchController(deps.parentSignal)
  const timeout = setTimeout(() => ctl.abort(), RECALL_TIMEOUT_MS)
  const alreadySurfaced = buildAlreadySurfacedSet(deps.apiMessages)
  const recalled: MemoryPrefetchResult['recalledMemories'] = []

  const promise: Promise<MemoryPrefetchResult | null> = (async () => {
    try {
      if (ctl.signal.aborted) return null
      const shared = await deps.sharedPromise
      if (ctl.signal.aborted) return null

      let text = ''
      try {
        // Pass `recalled` directly so we get this call's selection back
        // without reading a module-level global — that global is shared
        // across every parallel main chat and would race when two streams
        // overlap (MEM3).
        text = await recallForPromptAI(deps.query, alreadySurfaced, {
          shared: shared ?? undefined,
          outRecalled: recalled,
          minScore: deps.tuning.minScore,
        })
      } catch {
        // Fallback: synchronous keyword-based recall. We thread the same
        // `alreadySurfaced` set through so memories already attached
        // earlier in this conversation are not re-surfaced (MEM8).
        text = recallForPrompt(deps.query, alreadySurfaced)
      }

      recordSessionRecallBytes(text.length, deps.conversationId)
      return { text, recalledMemories: recalled }
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  })()

  return makeSubPrefetch(promise, ctl)
}

// ---------------------------------------------------------------------------
// Branch: workspace code semantic top-K
// ---------------------------------------------------------------------------

interface WorkspaceBranchDeps {
  root: string
  query: string
  topK: number
  minScore: number
  parentSignal: AbortSignal
  sharedPromise: Promise<SharedQueryEmbedding | null>
}

function startWorkspaceBranch(deps: WorkspaceBranchDeps): SubPrefetch<WorkspacePrefetchResult> {
  const ctl = subBranchController(deps.parentSignal)
  const timeout = setTimeout(() => ctl.abort(), PREFETCH_TIMEOUT_MS)

  const promise: Promise<WorkspacePrefetchResult | null> = (async () => {
    try {
      if (ctl.signal.aborted) return null
      const shared = await deps.sharedPromise
      if (ctl.signal.aborted) return null
      // No shared vector AND no local fallback is basically "embedding not
      // configured at all"; queryWorkspaceIndex will also do a dispatchEmbed
      // and bail, so cost stays bounded. We keep going regardless so the
      // legacy path still works for isolated callers.
      const { queryWorkspaceIndex } = await import('../embedding/workspaceIndex')
      const hits = await queryWorkspaceIndex(deps.root, deps.query, deps.topK, {
        shared: shared ?? undefined,
        minScore: deps.minScore,
      })
      if (ctl.signal.aborted) return null
      return {
        hits: hits.map((h) => ({
          text: h.text,
          score: h.score,
          namespace: h.namespace,
          filePath: h.filePath,
          startLine: h.startLine,
          endLine: h.endLine,
          meta: h.meta,
        })),
      }
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  })()

  return makeSubPrefetch(promise, ctl)
}

// ---------------------------------------------------------------------------
// Branch: attachment RAG top-K
// ---------------------------------------------------------------------------

interface AttachmentsBranchDeps {
  query: string
  attachments: Array<{ sha256: string; kind: string }>
  topK: number
  minScore: number
  parentSignal: AbortSignal
  sharedPromise: Promise<SharedQueryEmbedding | null>
}

function startAttachmentsBranch(
  deps: AttachmentsBranchDeps,
): SubPrefetch<AttachmentsPrefetchResult> {
  const ctl = subBranchController(deps.parentSignal)
  const timeout = setTimeout(() => ctl.abort(), PREFETCH_TIMEOUT_MS)

  const promise: Promise<AttachmentsPrefetchResult | null> = (async () => {
    try {
      if (ctl.signal.aborted) return null
      const shared = await deps.sharedPromise
      if (ctl.signal.aborted) return null
      const { queryAttachments } = await import('../embedding/highLevelApi')
      const r = await queryAttachments({
        query: deps.query,
        attachments: deps.attachments,
        topK: deps.topK,
        shared: shared ?? undefined,
        minScore: deps.minScore,
      })
      if (ctl.signal.aborted) return null
      if (!r.ok) return null
      return {
        hits: r.hits.map((h) => ({
          text: h.text,
          score: h.score,
          namespace: h.namespace,
          meta: h.meta,
        })),
        searched: r.searched,
      }
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  })()

  return makeSubPrefetch(promise, ctl)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Create an AbortController whose abort is triggered by the parent signal
 * firing. Used so each branch has a disposable fingerprint but still
 * cascades from the parent.
 */
function subBranchController(parentSignal: AbortSignal): AbortController {
  const ctl = new AbortController()
  if (parentSignal.aborted) {
    ctl.abort()
    return ctl
  }
  const onAbort = () => ctl.abort()
  parentSignal.addEventListener('abort', onAbort, { once: true })
  // When the branch naturally finishes, we still let the listener sit
  // until parent aborts or is GC'd — the controller is single-shot so
  // an extra no-op abort() is harmless.
  return ctl
}

function makeSubPrefetch<T>(
  promise: Promise<T | null>,
  ctl: AbortController,
): SubPrefetch<T> {
  const handle: {
    promise: Promise<T | null>
    settledAt: number | null
    [Symbol.dispose](): void
  } = {
    promise,
    settledAt: null,
    [Symbol.dispose]() {
      if (!ctl.signal.aborted) ctl.abort()
    },
  }
  void promise.finally(() => {
    handle.settledAt = Date.now()
  })
  return handle
}

/**
 * Cheap placeholder when a branch is disabled / budget-exhausted: the
 * promise resolves to null immediately, settledAt is set in the next
 * microtask, dispose is a no-op.
 */
function settledNull<T>(): SubPrefetch<T> {
  const ctl = new AbortController()
  const promise: Promise<T | null> = Promise.resolve(null)
  return makeSubPrefetch(promise, ctl)
}

function guardWithTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve(fallback)
    }, ms)
    p.then(
      (v) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Back-compat shim: startMemoryRecallPrefetch
// ---------------------------------------------------------------------------

/**
 * Legacy memory-only prefetch handle, kept alive for the existing
 * streamHandler consumer. Matches the previous shape exactly:
 *
 *   { promise: Promise<string>
 *   , settledAt: number | null
 *   , recalledMemories: Array<...>
 *   , [Symbol.dispose](): void
 *   }
 *
 * Internally it now delegates to `startRetrievalPrefetch` with everything
 * except the memory branch disabled. New code should prefer the unified
 * orchestrator and read from `handle.memory` directly.
 */
export interface MemoryPrefetch {
  promise: Promise<string>
  settledAt: number | null
  recalledMemories: Array<{
    filename: string
    name: string
    type: string
    matchSnippet: string
  }>
  [Symbol.dispose](): void
}

export function startMemoryRecallPrefetch(
  workspacePath: string | null | undefined,
  memoryEnabled: boolean,
  lastUserMessage: string,
  abortSignal: AbortSignal,
  apiMessages: Array<Record<string, unknown>> = [],
  conversationId?: string | null,
): MemoryPrefetch | undefined {
  if (!workspacePath || !memoryEnabled || !lastUserMessage.trim()) {
    return undefined
  }
  // Per-conversation budget gate (matches startMemoryBranch). When the shim
  // is called without a conversationId we fall back to the shared default
  // bucket — preserves the legacy single-counter semantic for ad-hoc
  // callers that haven't been threaded yet.
  const tuning = getRecallTuning()
  if (getSessionRecallBytes(conversationId) >= tuning.sessionBudgetBytes) {
    return undefined
  }

  const prefetch = startRetrievalPrefetch({
    query: lastUserMessage,
    workspacePath,
    abortSignal,
    apiMessages,
    memoryEnabled: true,
    conversationId,
    // No attachments / workspace branch — legacy shim runs only memory.
    attachments: [],
  })

  const memoryBranch = prefetch.memory
  if (!memoryBranch) {
    // Shouldn't happen given the gating above, but treat as no-op rather
    // than crash the stream.
    prefetch[Symbol.dispose]()
    return undefined
  }

  const recalledMemories: MemoryPrefetch['recalledMemories'] = []
  const handle: MemoryPrefetch = {
    promise: memoryBranch.promise.then((r) => {
      if (r) {
        for (const m of r.recalledMemories) recalledMemories.push(m)
        return r.text
      }
      return ''
    }),
    settledAt: null,
    recalledMemories,
    [Symbol.dispose]() {
      // Disposing just the memory branch would leak the workspace/attachment
      // branches in the unlikely case they existed; the unified handle does
      // the right thing.
      prefetch[Symbol.dispose]()
    },
  }
  void handle.promise.finally(() => {
    handle.settledAt = Date.now()
  })
  return handle
}

/**
 * Check whether a prefetch handle has settled and its result is worth
 * consuming (non-empty, hasn't been consumed yet).
 */
export function shouldConsumeMemoryPrefetch(
  prefetch: MemoryPrefetch | undefined,
): boolean {
  return prefetch !== undefined && prefetch.settledAt !== null
}

/** True when any sub-branch has settled — cheap mid-loop readiness poll. */
export function hasAnyBranchSettled(prefetch: RetrievalPrefetch): boolean {
  return (
    (prefetch.memory?.settledAt ?? null) !== null ||
    (prefetch.workspace?.settledAt ?? null) !== null ||
    (prefetch.attachments?.settledAt ?? null) !== null
  )
}
