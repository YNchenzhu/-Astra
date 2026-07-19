/**
 * Multi-agent orchestrator: parent-child kernel coordination for IDE-style
 * background agents and parallel sub-agent flows.
 *
 * Design constraints:
 *   - Parent kernel owns the top-level conversation (main chat). Spawning an Agent tool creates a
 *     child kernel through {@link MultiAgentOrchestrator.spawn}. The orchestrator tracks
 *     parent→children edges, enforces concurrency ceilings, and cascades `interrupt` / `pause`
 *     from parent to children.
 *   - Children can optionally be pinned to a worktree (see `.claude/worktrees` infrastructure) so
 *     writes are isolated from the parent's workspace. Worktree affinity is a hint; the concrete
 *     mount / unmount is delegated to a caller-provided `WorktreeAllocator` to keep the orch layer
 *     decoupled from filesystem policy.
 *   - Inter-agent mailbox today flows through `getActiveAgent().pendingMessages` (ALS singleton).
 *     The orchestrator captures that in {@link InterAgentMailboxPort} so future work can replace
 *     the singleton without touching callers.
 */

import type { KernelInterruptReason } from './kernel'

/**
 * Minimal lifecycle surface the orchestrator needs from a registered "kernel-like" thing.
 *
 * Pulled out as a separate interface so legacy sub-agents (which run via `runSubAgent` +
 * an `AbortController`, without owning a full {@link OrchestrationKernel}) can still
 * participate in parent/child tracking and `interruptTree` cascades. A thin shim that
 * forwards `interrupt` to `abortController.abort()` and treats `pause` / `resume` as
 * no-ops is sufficient — see the singleton wiring in
 * `electron/agents/multiAgentOrchestratorSingleton.ts`.
 *
 * `OrchestrationKernel` already implements this surface, so existing callers that
 * register a real kernel keep working without changes.
 */
export interface CancellableKernelLike {
  interrupt(reason?: KernelInterruptReason): void
  pause(): void | boolean
  resume(): void | boolean
}

export type KernelAffinity = 'main_process' | 'background_worker'

export type SpawnedKernelMetadata = {
  kernelId: string
  parentKernelId?: string
  conversationId?: string
  agentType: string
  affinity: KernelAffinity
  worktreePath?: string
  createdAt: number
}

export interface WorktreeAllocator {
  /** Allocate or reuse a worktree for a child kernel. Returns absolute path on success. */
  allocate(params: {
    parentConversationId?: string
    childKernelId: string
    agentType: string
  }): Promise<string> | string
  /** Release a worktree when the child kernel terminates. */
  release(path: string): Promise<void> | void
}

/**
 * Mailbox port — today backed by `getActiveAgent().pendingMessages`, in the future by a proper
 * directed queue keyed by sender+recipient kernel ids. Exposing it as a port decouples callers
 * from the ALS singleton.
 */
export interface InterAgentMailboxPort {
  deliver(params: {
    senderKernelId: string
    recipientKernelId: string
    line: string
  }): boolean
}

export type SpawnOptions = {
  conversationId?: string
  agentType: string
  affinity?: KernelAffinity
  /** When true, allocate a worktree via {@link WorktreeAllocator}. */
  useWorktree?: boolean
}

export type SpawnedKernel = {
  kernel: CancellableKernelLike
  meta: SpawnedKernelMetadata
}

/**
 * In-process multi-agent orchestrator. Keeps parent-child edges + concurrency limits + cascade
 * policy so callers don't re-implement these invariants per feature.
 */
export class MultiAgentOrchestrator {
  private readonly kernels = new Map<string, SpawnedKernel>()
  private readonly children = new Map<string, Set<string>>()
  private readonly worktreeAllocator?: WorktreeAllocator
  /**
   * Per-parent fan-out ceiling — the max number of DIRECT children a single
   * parent kernel may hold at once (enforced by {@link enforceConcurrencyLimit}
   * at each spawn site). The production singleton sets this to
   * `MAX_PARALLEL_AGENT_TOOL_CALLS` (= 6) — see `multiAgentOrchestratorSingleton.ts`.
   *
   * This is a DIFFERENT axis from `activeAgentRegistry.MAX_CONCURRENT_AGENTS`
   * (= 10), which is a PROCESS-WIDE total of all running agents regardless of
   * lineage. The two intentionally measure different things and are NOT
   * redundant:
   *   - `maxConcurrentChildren` (6, here)  → bounds one parent's fan-out.
   *   - `MAX_CONCURRENT_AGENTS`   (10, registry) → bounds the global total.
   *
   * They interact rather than mirror: with multiple parents the per-parent
   * caps can sum past the global cap (e.g. 2 parents × 6 = 12 > 10), so the
   * registry's global cap is the HARD backstop that actually fails a spawn
   * once the process is saturated, while this per-parent cap shapes the tree
   * so no single parent monopolises the budget. See the matching note on
   * `MAX_CONCURRENT_AGENTS` in `activeAgentRegistry.ts`.
   */
  private readonly maxConcurrentChildren: number
  /**
   * P1 (audit §3.1 wire-up) — inter-agent mailbox delivery port. When set,
   * every call to {@link deliverMailboxLine} routes through it so plugins /
   * telemetry / future durable-queue backends can observe (or replace) the
   * delivery. The default is the noop port returned by
   * {@link createNoopInterAgentMailboxPort} so existing flows that don't
   * configure a port keep working unchanged.
   */
  private mailboxPort: InterAgentMailboxPort

  constructor(options?: {
    worktreeAllocator?: WorktreeAllocator
    /** Default concurrency ceiling per parent. Override per-spawn with {@link SpawnOptions}. */
    maxConcurrentChildren?: number
    /**
     * P1 (audit §3.1 wire-up) — optional inter-agent mailbox port. Defaults
     * to {@link createNoopInterAgentMailboxPort}. Replace at construction
     * time with a port adapter that bridges to ALS `pendingMessages`,
     * persistent SQLite queue, or telemetry sink.
     */
    mailboxPort?: InterAgentMailboxPort
  }) {
    this.worktreeAllocator = options?.worktreeAllocator
    this.maxConcurrentChildren = Math.max(1, options?.maxConcurrentChildren ?? 4)
    this.mailboxPort = options?.mailboxPort ?? createNoopInterAgentMailboxPort()
  }

  /**
   * P1 (audit §3.1 wire-up) — replace the mailbox port at runtime (e.g. a
   * plugin loaded after the singleton was constructed). Returns the previous
   * port so callers can stack adapters (decorator pattern).
   */
  setMailboxPort(port: InterAgentMailboxPort): InterAgentMailboxPort {
    const prev = this.mailboxPort
    this.mailboxPort = port
    return prev
  }

  /**
   * P1 (audit §3.1 wire-up) — public delivery surface routed through
   * {@link InterAgentMailboxPort}. Returns the port's `deliver` result so
   * the caller can detect when a custom backend rejected the message.
   *
   * The default noop port returns `false`, so callers that ONLY rely on the
   * ALS `pendingMessages` write (the legacy path) should NOT use this
   * method as the primary delivery channel — they should keep writing
   * directly to `activeAgentRegistry.enqueueAgentMailboxMessage` and use
   * this method only for the observability fan-out (which
   * `enqueueAgentMailboxMessage` does internally as of the wire-up).
   */
  deliverMailboxLine(params: {
    senderKernelId: string
    recipientKernelId: string
    line: string
  }): boolean {
    try {
      return this.mailboxPort.deliver(params)
    } catch (e) {
      console.warn('[MultiAgentOrchestrator] mailboxPort.deliver threw:', e)
      return false
    }
  }

  /**
   * Register a kernel (parent or child) so the orchestrator can find it by id + cascade. The
   * caller is responsible for constructing the kernel (`new OrchestrationKernel(...)` or
   * `createKernelForLegacyMainChat`) and passing it in.
   */
  register(
    kernelId: string,
    kernel: CancellableKernelLike,
    meta: Omit<SpawnedKernelMetadata, 'kernelId' | 'createdAt'>,
  ): SpawnedKernel {
    const spawned: SpawnedKernel = {
      kernel,
      meta: {
        ...meta,
        kernelId,
        createdAt: Date.now(),
      },
    }
    this.kernels.set(kernelId, spawned)
    if (meta.parentKernelId) {
      const set = this.children.get(meta.parentKernelId) ?? new Set()
      set.add(kernelId)
      this.children.set(meta.parentKernelId, set)
    }
    return spawned
  }

  unregister(kernelId: string): void {
    const spawned = this.kernels.get(kernelId)
    this.kernels.delete(kernelId)
    const parentKernelId = spawned?.meta.parentKernelId
    if (parentKernelId) {
      this.children.get(parentKernelId)?.delete(kernelId)
    }
    // Re-parent any still-live children onto the grandparent BEFORE dropping
    // this node's edge set. Without this, children lose their only inbound
    // edge and become orphans: `interruptTree(root)` walks parent→child edges
    // and can no longer reach them, so a user "stop everything" leaves them
    // running (resources + token budget) until their own wall-clock timeout
    // fires. Re-parenting keeps the tree connected so cascade interrupt still
    // works — while deliberately NOT aborting background children that are
    // meant to outlive this (already-terminated) parent. The kill path is
    // `interruptTree`'s job and runs while the tree is still intact, before
    // teardown; teardown's job is cleanup, not termination.
    const liveChildren = this.children.get(kernelId)
    if (liveChildren && liveChildren.size > 0) {
      if (parentKernelId) {
        const grandparentSet =
          this.children.get(parentKernelId) ?? new Set<string>()
        for (const childId of liveChildren) {
          grandparentSet.add(childId)
          const childSpawned = this.kernels.get(childId)
          if (childSpawned) childSpawned.meta.parentKernelId = parentKernelId
        }
        this.children.set(parentKernelId, grandparentSet)
      } else {
        // No grandparent — children become roots. Clear the stale parent ref
        // so telemetry / future re-parents don't point at a dead kernel id.
        for (const childId of liveChildren) {
          const childSpawned = this.kernels.get(childId)
          if (childSpawned) delete childSpawned.meta.parentKernelId
        }
      }
    }
    this.children.delete(kernelId)
    if (spawned?.meta.worktreePath && this.worktreeAllocator) {
      const p = spawned.meta.worktreePath
      try {
        const res = this.worktreeAllocator.release(p)
        if (res instanceof Promise) res.catch(() => {})
      } catch {
        /* ignore */
      }
    }
  }

  get(kernelId: string): SpawnedKernel | undefined {
    return this.kernels.get(kernelId)
  }

  /** Children of `parentKernelId` in insertion order. */
  listChildren(parentKernelId: string): SpawnedKernel[] {
    const ids = this.children.get(parentKernelId)
    if (!ids) return []
    const out: SpawnedKernel[] = []
    for (const id of ids) {
      const s = this.kernels.get(id)
      if (s) out.push(s)
    }
    return out
  }

  /**
   * Throws when the parent already holds `maxConcurrentChildren` active
   * children. This is the PER-PARENT gate only — it counts a single parent's
   * direct children, NOT the process-wide agent total. The global ceiling
   * (`activeAgentRegistry.MAX_CONCURRENT_AGENTS`, enforced inside
   * `registerActiveAgent`) is a separate, complementary check; a spawn must
   * pass BOTH to proceed. Callers run them at different points: this one at
   * the spawn site before constructing the child, the global one inside the
   * registry write. See the field doc on {@link maxConcurrentChildren}.
   */
  enforceConcurrencyLimit(parentKernelId: string): void {
    const active = this.children.get(parentKernelId)?.size ?? 0
    if (active >= this.maxConcurrentChildren) {
      throw new Error(
        `[MultiAgentOrchestrator] Concurrency ceiling (${this.maxConcurrentChildren}) reached for parent ${parentKernelId}`,
      )
    }
  }

  /**
   * Allocate a worktree using the configured allocator. Returns undefined when no allocator is
   * configured; callers decide whether to fall back to the parent workspace.
   */
  async allocateWorktreeFor(params: {
    parentConversationId?: string
    childKernelId: string
    agentType: string
  }): Promise<string | undefined> {
    if (!this.worktreeAllocator) return undefined
    try {
      const out = await this.worktreeAllocator.allocate(params)
      return out || undefined
    } catch (e) {
      console.warn('[MultiAgentOrchestrator] worktree allocate failed:', e)
      return undefined
    }
  }

  /**
   * Cascade {@link OrchestrationKernel.interrupt} to a kernel and all descendants. Useful for
   * "cancel the whole agent tree when the top-level chat is interrupted".
   */
  interruptTree(
    rootKernelId: string,
    reason: KernelInterruptReason = 'user',
  ): number {
    let count = 0
    const walk = (id: string) => {
      const s = this.kernels.get(id)
      if (!s) return
      try {
        s.kernel.interrupt(reason)
        count++
      } catch {
        /* ignore */
      }
      const ids = this.children.get(id)
      if (ids) {
        for (const childId of [...ids]) walk(childId)
      }
    }
    walk(rootKernelId)
    return count
  }

  /** Cascade pause down the tree. Returns number of kernels paused. */
  pauseTree(rootKernelId: string): number {
    let count = 0
    const walk = (id: string) => {
      const s = this.kernels.get(id)
      if (!s) return
      try {
        const supported = s.kernel.pause()
        if (supported !== false) count++
      } catch {
        /* ignore */
      }
      const ids = this.children.get(id)
      if (ids) {
        for (const childId of [...ids]) walk(childId)
      }
    }
    walk(rootKernelId)
    return count
  }

  /** Cascade resume down the tree. Returns number of kernels resumed. */
  resumeTree(rootKernelId: string): number {
    let count = 0
    const walk = (id: string) => {
      const s = this.kernels.get(id)
      if (!s) return
      try {
        const supported = s.kernel.resume()
        if (supported !== false) count++
      } catch {
        /* ignore */
      }
      const ids = this.children.get(id)
      if (ids) {
        for (const childId of [...ids]) walk(childId)
      }
    }
    walk(rootKernelId)
    return count
  }

  /**
   * Contract audit (2026-07) — conversation-scoped pause/resume cascade with
   * HONEST coverage reporting. `pauseTree` requires a root kernel id, but the
   * pause IPC surface is keyed on conversationId; and legacy sub-agents are
   * registered through the abort-shim whose `pause()` returns `false`
   * (unsupported). Previously that gap was silently dropped — the UI showed
   * "paused" while shim children kept running. This walks every registered
   * kernel tagged with the conversation and reports how many actually paused
   * vs how many declared pause unsupported, so callers can tell the user.
   */
  pauseByConversation(conversationId: string): { supported: number; unsupported: number } {
    return this.cascadeByConversation(conversationId, (k) => k.pause())
  }

  /** Symmetric to {@link pauseByConversation}. */
  resumeByConversation(conversationId: string): { supported: number; unsupported: number } {
    return this.cascadeByConversation(conversationId, (k) => k.resume())
  }

  private cascadeByConversation(
    conversationId: string,
    op: (kernel: CancellableKernelLike) => void | boolean,
  ): { supported: number; unsupported: number } {
    const conv = conversationId.trim()
    let supported = 0
    let unsupported = 0
    if (!conv) return { supported, unsupported }
    for (const s of this.kernels.values()) {
      if (s.meta.conversationId !== conv) continue
      try {
        // `void` return = real kernel (cooperative pause supported);
        // explicit `false` = shim that cannot pause (legacy sub-agent).
        if (op(s.kernel) === false) unsupported++
        else supported++
      } catch {
        unsupported++
      }
    }
    return { supported, unsupported }
  }

  /** Runtime telemetry — returns every registered kernel + parent-child edges. */
  getRuntimeStatus(): {
    kernels: Array<SpawnedKernelMetadata & { childCount: number }>
    maxConcurrentChildren: number
  } {
    const out: Array<SpawnedKernelMetadata & { childCount: number }> = []
    for (const [id, s] of this.kernels) {
      const childCount = this.children.get(id)?.size ?? 0
      out.push({ ...s.meta, childCount })
    }
    return { kernels: out, maxConcurrentChildren: this.maxConcurrentChildren }
  }

  /** Test helper — clear all registrations without releasing worktrees. */
  clearForTests(): void {
    this.kernels.clear()
    this.children.clear()
  }
}

/**
 * Default no-op mailbox — callers who still use the global `getActiveAgent().pendingMessages`
 * path can inject a thin wrapper that bridges to the singleton.
 */
export function createNoopInterAgentMailboxPort(): InterAgentMailboxPort {
  return {
    deliver() {
      return false
    },
  }
}

/** A single delivered inter-agent line, tagged with its sender + arrival time. */
export type InterAgentMailboxEntry = {
  senderKernelId: string
  line: string
  at: number
}

/**
 * Audit fix M-3 — a REAL in-memory directed mailbox.
 *
 * Supersedes the decorative noop default: messages are stored in a bounded
 * per-recipient FIFO ring (keyed by `recipientKernelId`, tagged with sender +
 * timestamp) so the port becomes queryable (`drain` / `peek` / `size`) instead
 * of returning `false` and dropping everything.
 *
 * # Why this coexists with the ALS `pendingMessages` path
 *
 * `enqueueAgentMailboxMessage` (activeAgentRegistry) remains the LIVE delivery
 * channel that sub-agents actually read from; this port is the observable,
 * durable-foundation queue that every `deliverMailboxLine` fan-out now lands
 * in. A future migration can flip consumers to drain this port instead of ALS
 * without touching producers. Until then the port is a parallel sink.
 *
 * # Bounded twice (no leak with no consumer)
 *
 * Because nothing drains this queue yet, it is bounded on BOTH axes so an
 * un-drained long session can't grow without limit:
 *   - `maxPerRecipient` (default 256) — FIFO ring per recipient; oldest line
 *     drops on overflow (mirrors `AGENT_MAILBOX_MAX`).
 *   - `maxRecipients` (default 256) — LRU over recipient buckets; the
 *     least-recently-delivered recipient's whole queue is evicted on overflow.
 */
export interface InMemoryMailboxPort extends InterAgentMailboxPort {
  /** Consume + return all queued lines for a recipient (oldest-first). Clears the bucket. */
  drain(recipientKernelId: string): InterAgentMailboxEntry[]
  /** Read queued lines for a recipient without consuming. */
  peek(recipientKernelId: string): InterAgentMailboxEntry[]
  /** Drop a recipient's queue entirely (e.g. on agent teardown). */
  clearRecipient(recipientKernelId: string): void
  /** Total queued lines across all recipients (telemetry). */
  size(): number
  /** Number of active recipient buckets (telemetry). */
  recipientCount(): number
  /** Wipe everything. */
  clear(): void
}

export function createInMemoryMailboxPort(options?: {
  maxPerRecipient?: number
  maxRecipients?: number
}): InMemoryMailboxPort {
  const maxPerRecipient = Math.max(1, options?.maxPerRecipient ?? 256)
  const maxRecipients = Math.max(1, options?.maxRecipients ?? 256)
  // Map preserves insertion order; we re-insert on each deliver so the FIRST
  // key is always the least-recently-used recipient (cheap LRU).
  const queues = new Map<string, InterAgentMailboxEntry[]>()

  const touch = (recipient: string): InterAgentMailboxEntry[] => {
    const existing = queues.get(recipient)
    if (existing) {
      // Re-insert to move to the most-recently-used position.
      queues.delete(recipient)
      queues.set(recipient, existing)
      return existing
    }
    const fresh: InterAgentMailboxEntry[] = []
    queues.set(recipient, fresh)
    // Evict the LRU recipient bucket(s) if we exceeded the ceiling.
    while (queues.size > maxRecipients) {
      const lruKey = queues.keys().next().value as string | undefined
      if (lruKey === undefined || lruKey === recipient) break
      queues.delete(lruKey)
    }
    return fresh
  }

  return {
    deliver(params: { senderKernelId: string; recipientKernelId: string; line: string }): boolean {
      const recipient = params.recipientKernelId?.trim()
      if (!recipient) return false
      const q = touch(recipient)
      q.push({ senderKernelId: params.senderKernelId ?? '', line: params.line, at: Date.now() })
      while (q.length > maxPerRecipient) q.shift()
      return true
    },
    drain(recipientKernelId: string): InterAgentMailboxEntry[] {
      const recipient = recipientKernelId?.trim()
      if (!recipient) return []
      const q = queues.get(recipient)
      if (!q || q.length === 0) return []
      queues.delete(recipient)
      return q
    },
    peek(recipientKernelId: string): InterAgentMailboxEntry[] {
      const q = queues.get(recipientKernelId?.trim())
      return q ? q.slice() : []
    },
    clearRecipient(recipientKernelId: string): void {
      queues.delete(recipientKernelId?.trim())
    },
    size(): number {
      let total = 0
      for (const q of queues.values()) total += q.length
      return total
    },
    recipientCount(): number {
      return queues.size
    },
    clear(): void {
      queues.clear()
    },
  }
}

