/**
 * CheckpointPort: snapshot / rewind / fork semantics for the orchestration kernel.
 *
 * Strategic alignment with the IDE parallel-attempts + rewind UX:
 *   - `snapshot(tag)` captures transcript + inbox + iteration counters + interrupt state at any
 *     phase boundary. Each snapshot has a stable `CheckpointId`.
 *   - `rewind(id)` restores a prior snapshot (P1.2: **non-truncating** — older branches are
 *     preserved, a fresh checkpoint is appended pointing to `id` as its parent). Equivalent to
 *     LangGraph's `update_state(historical_id, ...)` fork semantics so the renderer can offer
 *     "compare two attempts" UX without losing the discarded branch.
 *   - `fork(id)` returns a fresh kernel seeded from the snapshot — used for parallel attempts
 *     (e.g. "run this prompt with three different strategies and compare").
 *
 * The port deliberately does NOT persist tool side-effects (files written, shell commands run).
 * Those are the caller's responsibility — typically the renderer's diff-review layer rolls back
 * accepted-but-then-rewound edits via the existing diff tx infrastructure.
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { KernelLoopState } from './kernelTypes'
import { cloneTranscript, normalizeKernelLoopState } from './kernelTypes'

export type CheckpointId = string

export type KernelCheckpoint = {
  id: CheckpointId
  /** Caller-provided label (e.g. 'before_tool_batch', 'pre_compact'). */
  tag: string
  /** Wall clock in ms. */
  at: number
  /** Deep snapshot of the kernel's observable state. */
  state: KernelLoopState
  /**
   * parent checkpoint id in the branch tree.
   *
   * - Undefined for the initial snapshot in a port (no ancestor).
   * - For an entry produced by `snapshot()`, points at the previous branch head — so a simple
   *   linear history forms a single chain.
   * - For an entry produced by `rewind()`, points at the checkpoint that was rewound to. This
   *   captures the "fork" relationship: the rewound subtree (everything that was the head when
   *   rewind was called) is no longer the active branch, but its entries are kept reachable via
   *   {@link CheckpointPort.listTree} so the UI can render a branch picker.
   */
  parentId?: CheckpointId
}

export interface CheckpointPort {
  /** Capture the current kernel state under `tag` and return an opaque id. */
  snapshot(tag: string, state: KernelLoopState): CheckpointId
  /**
   * Restore state by id. **Non-truncating**: the rewound subtree is preserved in
   * history; a new checkpoint tagged `rewind:<originalTag>` is appended with `parentId` pointing
   * at `id`, and subsequent `snapshot()` calls extend from this new branch head.
   *
   * Returns the restored state, or null if `id` is unknown.
   */
  rewind(id: CheckpointId): KernelLoopState | null
  /**
   * Read-only lookup. Returns the snapshot without mutating history. Useful for "fork from
   * checkpoint N" flows where the caller wants to seed a sibling kernel.
   */
  peek(id: CheckpointId): KernelCheckpoint | null
  /**
   * Branch primitive for **parallel attempts** (best-of-N). Returns a deep clone of `id`'s
   * state suitable for seeding a sibling kernel, and records a lightweight `fork:<tag>` child
   * checkpoint (`parentId === id`) so `listTree` / the branch picker can show the divergence.
   *
   * Unlike {@link CheckpointPort.rewind}, `fork` does **not** move the active branch head — the
   * main branch keeps advancing independently. Call it N times off the same base `id` to fan
   * out N independent attempts that all start from the same state (each then commits into its
   * own git worktree). Returns null when `id` is unknown.
   */
  fork(id: CheckpointId): KernelLoopState | null
  /** All checkpoints in insertion order (oldest first). */
  list(): KernelCheckpoint[]
  /**
   * All checkpoints organised as a topologically-ordered tree walk: each branch root
   * (a node whose parent is not in this list) appears first, then its descendants depth-first.
   *
   * For a fully linear history this is identical to {@link list}. For a history with rewinds,
   * branches show up grouped so a renderer can walk them without re-scanning parent pointers.
   */
  listTree(): KernelCheckpoint[]
  /**
   * Active branch head id (set by the most recent `snapshot()` or `rewind()`).
   * Undefined when the port has no entries.
   */
  getBranchHead(): CheckpointId | undefined
  /** Drop everything — useful for tests and session teardown. */
  clear(): void
  /**
   * M-5 — force any pending debounced persistence to disk now. No-op for the
   * pure in-memory port (and for file ports with `debounceMs: 0`). Callers
   * fire this on session teardown so a clean exit doesn't lose the last
   * coalesced snapshot window.
   */
  flushNow?(): void
}

/**
 * Audit fix M-2 — optional durability hook for {@link createInMemoryCheckpointPort}.
 *
 * The default port is purely in-memory (rewind/fork are lost on process
 * restart). Supplying a persistence implementation lets the SAME tree logic
 * hydrate from and flush to a durable backend (see
 * {@link createFileCheckpointPort}) without forking the branch-tree code.
 *
 * `persist` is called synchronously after every mutating op (snapshot /
 * rewind / clear). Implementations MUST be best-effort (swallow + log their
 * own errors) so a disk failure never breaks the kernel hot path.
 */
export interface CheckpointPersistence {
  /** Load the persisted tree on construction. Returns null when nothing is stored. */
  loadAll(): { entries: KernelCheckpoint[]; branchHead?: CheckpointId } | null
  /**
   * Flush the current tree + active branch head. Best-effort; never throws.
   *
   * M-5 contract: `entries` is the port's LIVE array — a stable reference
   * mutated in place (append/evict) over the port's lifetime; the entries
   * inside are immutable once created. Implementations MUST treat it as
   * read-only and MUST NOT retain mutated copies. A deferred (debounced)
   * implementation will serialise whatever the array holds at write time,
   * which is the intended coalescing of rapid back-to-back snapshots.
   */
  persist(entries: KernelCheckpoint[], branchHead: CheckpointId | undefined): void
  /** Optional — force-write any pending debounced state (e.g. on teardown). */
  flushNow?(): void
}

/**
 * Bounded LRU-backed default checkpoint port. Keeps the most recent `maxEntries` snapshots; older
 * ones are evicted FIFO. The caller can override via `createInMemoryCheckpointPort({ maxEntries })`.
 *
 * eviction still operates on insertion order: when capacity is exceeded the oldest entry
 * is dropped regardless of branch membership. Renderers that pin a specific branch should bump
 * `maxEntries` (or persist the checkpoints out-of-band) before relying on long-lived rewinds.
 *
 * Audit fix M-2 — pass `persistence` to make the port durable across process
 * restarts (the tree is hydrated on construction and flushed after every
 * mutating op). Omit it for the legacy session-scoped behaviour.
 */
export function createInMemoryCheckpointPort(options?: {
  maxEntries?: number
  persistence?: CheckpointPersistence
}): CheckpointPort {
  const max = Math.max(1, options?.maxEntries ?? 50)
  const persistence = options?.persistence
  const entries: KernelCheckpoint[] = []
  let branchHead: CheckpointId | undefined

  const deepCloneState = (state: KernelLoopState): KernelLoopState =>
    normalizeKernelLoopState({
      phase: state.phase,
      iteration: state.iteration,
      innerIteration: state.innerIteration,
      transcript: cloneTranscript(state.transcript),
      transcriptRevision: state.transcriptRevision,
      transcriptFingerprint: state.transcriptFingerprint,
      inbox: state.inbox.map((item) => ({ ...item })),
      maxOutputRecoveryCycles: state.maxOutputRecoveryCycles,
      consecutiveCompactFailures: state.consecutiveCompactFailures,
    })

  const cloneEntry = (e: KernelCheckpoint): KernelCheckpoint => ({
    id: e.id,
    tag: e.tag,
    at: e.at,
    ...(e.parentId ? { parentId: e.parentId } : {}),
    state: deepCloneState(e.state),
  })

  // M-2 — flush the tree after every mutating op. Best-effort: the
  // persistence impl owns its own error handling, but we still guard the
  // call so a thrown impl can never break the kernel hot path.
  //
  // M-5 — pass the LIVE `entries` array (stable reference, mutated in place by
  // append/evict only; individual entries are immutable once pushed) instead
  // of a per-flush deep clone. The persistence layer serialises it (which
  // copies) at write time. Combined with the file port's debounced writer,
  // this turns "deep-clone + full-tree disk write per inner-iteration
  // snapshot" into one coalesced serialise per debounce window — eliminating
  // both the redundant clone and the write amplification M-2 would otherwise
  // introduce on long turns.
  const flush = (): void => {
    if (!persistence) return
    try {
      persistence.persist(entries, branchHead)
    } catch (e) {
      console.warn('[CheckpointPort] persistence.persist threw:', e)
    }
  }

  // M-2 — hydrate any previously-persisted tree on construction so rewind /
  // fork survive a process restart. Entries are deep-cloned in so the
  // in-memory copy never aliases the persistence layer's objects.
  if (persistence) {
    try {
      const loaded = persistence.loadAll()
      if (loaded && loaded.entries.length > 0) {
        for (const e of loaded.entries) entries.push(cloneEntry(e))
        // Trim to capacity (a smaller `maxEntries` than the persisted file).
        while (entries.length > max) entries.shift()
        const headStillPresent =
          loaded.branchHead && entries.some((e) => e.id === loaded.branchHead)
        branchHead = headStillPresent ? loaded.branchHead : entries[entries.length - 1]?.id
      }
    } catch (e) {
      console.warn('[CheckpointPort] persistence.loadAll threw:', e)
    }
  }

  return {
    snapshot(tag, state) {
      const id: CheckpointId = randomUUID()
      const entry: KernelCheckpoint = {
        id,
        tag,
        at: Date.now(),
        state: deepCloneState(state),
        ...(branchHead ? { parentId: branchHead } : {}),
      }
      entries.push(entry)
      branchHead = id
      while (entries.length > max) {
        const dropped = entries.shift()
        // If the LRU happened to drop the current branch head (it can't, since `branchHead`
        // was just set above), or any ancestor referenced by `branchHead` via `parentId`,
        // downstream listTree consumers will simply see disconnected roots. That's the
        // expected behaviour: callers wanting durable history use the file-backed port.
        if (dropped && dropped.id === branchHead) {
          branchHead = undefined
        }
      }
      flush()
      return id
    },
    rewind(id) {
      const entry = entries.find((e) => e.id === id)
      if (!entry) return null
      // Append a fork marker so subsequent snapshots branch off `id` instead of overwriting
      // the prior head. The marker carries the rewound state verbatim so it doubles as a
      // resumable anchor (callers can `peek(returnedRewindId)` to get the same payload).
      const forkId: CheckpointId = randomUUID()
      const fork: KernelCheckpoint = {
        id: forkId,
        tag: `rewind:${entry.tag}`,
        at: Date.now(),
        parentId: id,
        state: deepCloneState(entry.state),
      }
      entries.push(fork)
      branchHead = forkId
      while (entries.length > max) {
        const dropped = entries.shift()
        if (dropped && dropped.id === branchHead) {
          branchHead = undefined
        }
      }
      flush()
      return deepCloneState(entry.state)
    },
    peek(id) {
      const entry = entries.find((e) => e.id === id)
      if (!entry) return null
      return cloneEntry(entry)
    },
    fork(id) {
      const entry = entries.find((e) => e.id === id)
      if (!entry) return null
      // Record a sibling fork marker for lineage / branch-picker visibility.
      // Deliberately does NOT touch `branchHead`: the main branch continues
      // from wherever it was, while this fork is an independent attempt anchor.
      const forkId: CheckpointId = randomUUID()
      const forkEntry: KernelCheckpoint = {
        id: forkId,
        tag: `fork:${entry.tag}`,
        at: Date.now(),
        parentId: id,
        state: deepCloneState(entry.state),
      }
      entries.push(forkEntry)
      while (entries.length > max) {
        const dropped = entries.shift()
        if (dropped && dropped.id === branchHead) {
          branchHead = undefined
        }
      }
      flush()
      return deepCloneState(entry.state)
    },
    list() {
      return entries.map(cloneEntry)
    },
    listTree() {
      // Topological order = insertion order, because `parentId` always points to an entry
      // inserted before this one (or to nothing). Build a `parent → children` map, walk
      // roots in insertion order, depth-first for descendants. This makes the output stable
      // for renderers that render branches as columns.
      const byParent = new Map<CheckpointId | undefined, KernelCheckpoint[]>()
      for (const e of entries) {
        const key = e.parentId
        if (!byParent.has(key)) byParent.set(key, [])
        byParent.get(key)!.push(e)
      }
      const out: KernelCheckpoint[] = []
      const seen = new Set<CheckpointId>()
      const walk = (e: KernelCheckpoint): void => {
        if (seen.has(e.id)) return
        seen.add(e.id)
        out.push(cloneEntry(e))
        const children = byParent.get(e.id) ?? []
        for (const c of children) walk(c)
      }
      // Roots: parentId undefined OR parentId not in entries (parent evicted by LRU).
      const ids = new Set(entries.map((e) => e.id))
      for (const e of entries) {
        if (!e.parentId || !ids.has(e.parentId)) {
          walk(e)
        }
      }
      // Defensive: if any entry was unreachable (shouldn't happen with current insertion
      // discipline), append in insertion order so listTree never silently drops entries.
      for (const e of entries) {
        if (!seen.has(e.id)) out.push(cloneEntry(e))
      }
      return out
    },
    getBranchHead() {
      return branchHead
    },
    clear() {
      entries.length = 0
      branchHead = undefined
      flush()
    },
    flushNow() {
      try {
        persistence?.flushNow?.()
      } catch (e) {
        console.warn('[CheckpointPort] persistence.flushNow threw:', e)
      }
    },
  }
}

/**
 * Audit fix M-2 — file-backed persistence for {@link createInMemoryCheckpointPort}.
 *
 * Stores the whole branch tree for one conversation at
 * `<baseDir>/<safe-conv-id>.json` (atomic tmp+rename). The tree is small
 * (bounded by the port's `maxEntries`); the dominant cost is the per-entry
 * transcript snapshot, which is the same data the in-memory port already
 * deep-clones. Writes happen only at snapshot/rewind/clear boundaries (NOT in
 * the per-token hot path), so synchronous disk I/O here is acceptable.
 */
function createFileCheckpointPersistence(
  baseDir: string,
  conversationId: string,
  options?: { debounceMs?: number },
): CheckpointPersistence {
  const VERSION = 1 as const
  // M-5 — coalesce rapid snapshots (one per inner-iteration boundary) into a
  // single trailing disk write. 0 → synchronous write per call (tests). The
  // crash window is bounded by `debounceMs`; checkpoints are best-effort
  // rewind UX (NOT correctness-critical like the throttled kernel-state
  // persist), so losing the last ~250ms of snapshots on a hard crash only
  // lands a rewind one iteration earlier.
  const debounceMs = Math.max(0, options?.debounceMs ?? 250)
  const safeId = (id: string): string =>
    id.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200) || 'default'
  const filePath = path.join(baseDir, `${safeId(conversationId)}.json`)

  type PersistedCheckpointTree = {
    version: typeof VERSION
    conversationId: string
    savedAt: number
    branchHead?: CheckpointId
    entries: KernelCheckpoint[]
  }

  // Latest state to serialise (the LIVE port array + current head). The
  // trailing timer reads these at fire time, so back-to-back persists within
  // one window collapse to a single write of the most recent tree.
  let latestEntries: KernelCheckpoint[] = []
  let latestHead: CheckpointId | undefined
  let pending = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const writeNow = (): void => {
    pending = false
    try {
      fs.mkdirSync(baseDir, { recursive: true })
      const blob: PersistedCheckpointTree = {
        version: VERSION,
        conversationId,
        savedAt: Date.now(),
        ...(latestHead ? { branchHead: latestHead } : {}),
        entries: latestEntries,
      }
      const tmp = `${filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(blob), 'utf-8')
      fs.renameSync(tmp, filePath)
    } catch (e) {
      console.warn('[FileCheckpointPort] persist failed:', e)
    }
  }

  return {
    loadAll() {
      try {
        if (!fs.existsSync(filePath)) return null
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PersistedCheckpointTree
        if (parsed.version !== VERSION) return null
        if (parsed.conversationId !== conversationId) return null
        if (!Array.isArray(parsed.entries)) return null
        return {
          entries: parsed.entries,
          ...(parsed.branchHead ? { branchHead: parsed.branchHead } : {}),
        }
      } catch (e) {
        console.warn('[FileCheckpointPort] loadAll failed:', e)
        return null
      }
    },
    persist(entries, branchHead) {
      latestEntries = entries
      latestHead = branchHead
      if (debounceMs === 0) {
        writeNow()
        return
      }
      pending = true
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        if (pending) writeNow()
      }, debounceMs)
      // unref so a pending checkpoint write never keeps the process alive.
      if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        try {
          ;(timer as unknown as { unref: () => void }).unref()
        } catch {
          /* ignore */
        }
      }
    },
    flushNow() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (pending) writeNow()
    },
  }
}

/**
 * Audit fix M-2 — durable checkpoint port. Same branch-tree semantics as
 * {@link createInMemoryCheckpointPort} but hydrated from / flushed to a
 * per-conversation JSON file, so the IDE rewind / branch-picker UX and
 * fork-from-checkpoint survive a process restart.
 */
export function createFileCheckpointPort(params: {
  baseDir: string
  conversationId: string
  maxEntries?: number
  /**
   * M-5 — coalesce window for disk writes (default 250ms). Pass `0` for a
   * synchronous write per mutation (tests / callers that re-read immediately).
   */
  debounceMs?: number
}): CheckpointPort {
  return createInMemoryCheckpointPort({
    ...(params.maxEntries ? { maxEntries: params.maxEntries } : {}),
    persistence: createFileCheckpointPersistence(params.baseDir, params.conversationId, {
      ...(params.debounceMs !== undefined ? { debounceMs: params.debounceMs } : {}),
    }),
  })
}

/** Delete the persisted checkpoint tree file for a conversation (cleanup). */
export function deleteFileCheckpointTree(baseDir: string, conversationId: string): void {
  const safeId = conversationId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200) || 'default'
  const filePath = path.join(baseDir, `${safeId}.json`)
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch (e) {
    console.warn('[FileCheckpointPort] delete failed:', e)
  }
}
