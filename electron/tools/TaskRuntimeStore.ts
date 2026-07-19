export type TaskRuntimeKind = 'bash' | 'agent' | 'other'
export type TaskRuntimeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped'
export type TaskRuntimeStream = 'stdout' | 'stderr' | 'text' | 'meta'

export interface TaskRuntimeChunk {
  idx: number
  ts: number
  stream: TaskRuntimeStream
  text: string
}

export interface TaskRuntimeRecord {
  taskId: string
  kind: TaskRuntimeKind
  status: TaskRuntimeStatus
  startedAt: number
  finishedAt?: number
  exitCode?: number
  error?: string
  chunks: TaskRuntimeChunk[]
  cursor: number
  droppedBefore: number
}

const MAX_CHUNKS_PER_TASK = 5000
/** upstream-style output watchdog — drop oldest chunks when buffer grows too large */
const MAX_TOTAL_CHARS_PER_TASK = 8 * 1024 * 1024
/**
 * Time a completed / failed / stopped task lingers in the store before GC.
 * Post-mortem consumers (TaskOutput, UI) typically read within a few
 * minutes of completion; retaining terminal records past this window
 * just wastes RAM on long sessions (audit Bug O10).
 */
const TERMINAL_RECORD_TTL_MS = 10 * 60 * 1000
/** How often the sweep runs. Interleaves with normal append/complete calls. */
const TERMINAL_SWEEP_INTERVAL_MS = 60 * 1000

type StopHandler = () => void | Promise<void>

export interface TaskOutputChunkEvent {
  taskId: string
  stream: TaskRuntimeStream
  text: string
  timestamp: number
  status?: TaskRuntimeStatus
}

type ChunkCallback = (event: TaskOutputChunkEvent) => void

class TaskRuntimeStore {
  private records = new Map<string, TaskRuntimeRecord>()
  /** Maps alternate ids (e.g. sub-agent `agentId`) to the canonical runtime key (parent `tool_use_id`). */
  private idAliases = new Map<string, string>()
  private stopHandlers = new Map<string, StopHandler>()
  private chunkCallbacks: ChunkCallback[] = []
  /** Timestamp of last terminal-record sweep — rate-limits the GC loop. */
  private lastTerminalSweepAt = 0

  /**
   * Drop terminal-state records older than {@link TERMINAL_RECORD_TTL_MS}.
   * Called lazily from `start`/`append` hot paths at most once per
   * {@link TERMINAL_SWEEP_INTERVAL_MS}; avoids adding a real timer so tests
   * and short-lived spawns stay deterministic.
   */
  private maybeSweepTerminalRecords(): void {
    const now = Date.now()
    if (now - this.lastTerminalSweepAt < TERMINAL_SWEEP_INTERVAL_MS) return
    this.lastTerminalSweepAt = now
    const cutoff = now - TERMINAL_RECORD_TTL_MS
    for (const [id, rec] of this.records) {
      if (rec.status === 'running' || rec.status === 'pending') continue
      const finished = rec.finishedAt ?? rec.startedAt
      if (finished < cutoff) {
        this.records.delete(id)
        this.unlinkAliasesForCanonical(id)
        this.stopHandlers.delete(id)
      }
    }
  }

  /**
   * Sub-agents expose `agentId` in JSON; {@link runAgenticToolUse} stores output under the parent tool_use id.
   * Link them so TaskOutput/TaskStop work when the model passes `agentId` as task_id.
   */
  linkAlias(aliasId: string, canonicalTaskId: string): void {
    const a = String(aliasId ?? '').trim()
    const c = String(canonicalTaskId ?? '').trim()
    if (!a || !c || a === c) return
    this.idAliases.set(a, c)
  }

  /** Drop a sub-agent → parent tool_use id mapping when the child run ends. */
  unlinkAlias(aliasId: string): void {
    const a = String(aliasId ?? '').trim()
    if (!a) return
    this.idAliases.delete(a)
  }

  private resolveId(taskId: string): string {
    return this.idAliases.get(taskId) ?? taskId
  }

  private unlinkAliasesForCanonical(canonicalTaskId: string): void {
    for (const [alias, canon] of this.idAliases) {
      if (canon === canonicalTaskId) this.idAliases.delete(alias)
    }
  }

  /**
   * Audit fix R7 (2026-05) — drop every alias that points at `canonicalTaskId`
   * EXCEPT the alias `keepAlias` (when provided).
   *
   * Used by {@link start} when an existing terminal-state record is being
   * recycled for a new run. Aliases registered by the previous owner are
   * stale (their lifecycle is over) and would otherwise let a stale reader
   * resolve the OLD aliasId to the NEW record — a silent dirty read.
   *
   * The `keepAlias` exemption is for the common case where the new caller
   * just did `linkAlias(newAlias, canonical)` before calling `start(newAlias)`
   * — we must NOT remove the alias the current caller is actively using.
   */
  private unlinkAliasesForCanonicalExcept(
    canonicalTaskId: string,
    keepAlias: string | undefined,
  ): void {
    for (const [alias, canon] of this.idAliases) {
      if (canon !== canonicalTaskId) continue
      if (keepAlias !== undefined && alias === keepAlias) continue
      this.idAliases.delete(alias)
    }
  }

  start(taskId: string, kind: TaskRuntimeKind): TaskRuntimeRecord {
    // Opportunistic GC — old completed/failed tasks exit the store here.
    this.maybeSweepTerminalRecords()
    const resolved = this.resolveId(taskId)
    const existing = this.records.get(resolved)
    if (existing) {
      // Audit fix R7 (2026-05) — alias hygiene on recycle.
      //
      // If the existing record was already TERMINAL, this `start()` is a
      // recycle (P1-19 retry path). Aliases registered by the previous
      // owner are now invalid: a stale reader that still resolves through
      // an old alias would dirty-read the NEW run's data.
      //
      // We only run the cleanup on terminal records — if `existing` is
      // still `running`/`pending`, a true in-flight reader may still be
      // using the alias to track the current run, and dropping it would
      // break them. The "start() called while record is non-terminal"
      // case is a separate caller-side bug; we don't paper over it here.
      const wasTerminal =
        existing.status === 'completed' ||
        existing.status === 'failed' ||
        existing.status === 'stopped'
      if (wasTerminal) {
        const keepAlias = taskId !== resolved ? taskId : undefined
        this.unlinkAliasesForCanonicalExcept(resolved, keepAlias)
      }

      // P1-19: when the same taskId is started again (e.g., a retry after
      // failure), reset the output buffer instead of replaying the previous
      // run's chunks. Previously TaskOutput on the second run would stitch
      // old + new output together — pure cross-talk. We also re-stamp
      // `startedAt` so retry duration is measured from the new start.
      existing.kind = kind
      existing.status = 'running'
      existing.startedAt = Date.now()
      existing.chunks = []
      existing.cursor = 0
      existing.droppedBefore = 0
      delete existing.finishedAt
      delete existing.exitCode
      delete existing.error
      return existing
    }

    const record: TaskRuntimeRecord = {
      taskId: resolved,
      kind,
      status: 'running',
      startedAt: Date.now(),
      chunks: [],
      cursor: 0,
      droppedBefore: 0,
    }
    this.records.set(resolved, record)
    return record
  }

  append(taskId: string, stream: TaskRuntimeStream, text: string): void {
    if (!text) return

    const resolved = this.resolveId(taskId)
    const record = this.records.get(resolved) || this.start(resolved, 'other')
    const chunk: TaskRuntimeChunk = {
      idx: record.cursor,
      ts: Date.now(),
      stream,
      text,
    }
    record.cursor += 1
    record.chunks.push(chunk)

    if (record.chunks.length > MAX_CHUNKS_PER_TASK) {
      const overflow = record.chunks.length - MAX_CHUNKS_PER_TASK
      record.chunks.splice(0, overflow)
      record.droppedBefore += overflow
    }

    let total = record.chunks.reduce((s, c) => s + c.text.length, 0)
    while (total > MAX_TOTAL_CHARS_PER_TASK && record.chunks.length > 0) {
      const rm = record.chunks.shift()!
      total -= rm.text.length
      record.droppedBefore += 1
    }

    this.notifyChunkAppended(resolved, stream, text)
  }

  private notifyChunkAppended(taskId: string, stream: TaskRuntimeStream, text: string, status?: TaskRuntimeStatus): void {
    for (const cb of this.chunkCallbacks) {
      cb({
        taskId,
        stream,
        text,
        timestamp: Date.now(),
        status,
      })
    }
  }

  onChunkAppended(callback: ChunkCallback): () => void {
    this.chunkCallbacks.push(callback)
    return () => {
      const idx = this.chunkCallbacks.indexOf(callback)
      if (idx > -1) this.chunkCallbacks.splice(idx, 1)
    }
  }

  markCompleted(taskId: string, meta?: { exitCode?: number }): void {
    const resolved = this.resolveId(taskId)
    const record = this.records.get(resolved)
    if (!record) return
    record.status = 'completed'
    record.finishedAt = Date.now()
    if (typeof meta?.exitCode === 'number') {
      record.exitCode = meta.exitCode
    }
    this.stopHandlers.delete(resolved)
    this.notifyChunkAppended(resolved, 'meta', '', 'completed')
  }

  markFailed(taskId: string, error?: string): void {
    const resolved = this.resolveId(taskId)
    const record = this.records.get(resolved)
    if (!record) return
    record.status = 'failed'
    record.finishedAt = Date.now()
    if (error) {
      record.error = error
      this.append(resolved, 'meta', `Error: ${error}`)
    }
    this.stopHandlers.delete(resolved)
    this.notifyChunkAppended(resolved, 'meta', '', 'failed')
  }

  markStopped(taskId: string): void {
    const resolved = this.resolveId(taskId)
    const record = this.records.get(resolved)
    if (!record) return
    record.status = 'stopped'
    record.finishedAt = Date.now()
    this.append(resolved, 'meta', 'Task was stopped')
    this.stopHandlers.delete(resolved)
    this.notifyChunkAppended(resolved, 'meta', '', 'stopped')
  }

  setStopHandler(taskId: string, handler: StopHandler): void {
    this.stopHandlers.set(this.resolveId(taskId), handler)
  }

  clearStopHandler(taskId: string): void {
    this.stopHandlers.delete(this.resolveId(taskId))
  }

  async stop(taskId: string): Promise<boolean> {
    const resolved = this.resolveId(taskId)
    const handler = this.stopHandlers.get(resolved)
    if (!handler) return false

    await handler()
    this.markStopped(resolved)
    return true
  }

  get(taskId: string): TaskRuntimeRecord | undefined {
    return this.records.get(this.resolveId(taskId))
  }

  /**
   * Return the current write cursor for `taskId`, or `null` when the record
   * does not exist yet. Callers use this to snapshot a "before" point so a
   * subsequent {@link rollbackToCursor} can discard chunks appended in
   * between (e.g. partial deltas emitted before a streaming-fallback retry).
   */
  getCursor(taskId: string): number | null {
    const resolved = this.resolveId(taskId)
    const record = this.records.get(resolved)
    return record ? record.cursor : null
  }

  /**
   * Discard chunks whose `idx >= targetCursor` and rewind the record's
   * write cursor to `targetCursor`. Used by sub-agent streaming fallback
   * (HTTP 529 / mid-stream provider errors) so the non-streaming retry's
   * full response replaces — rather than duplicates — the abandoned
   * partial deltas in the runtime buffer that `TaskOutput` reads from.
   *
   * No-op when the record does not exist or `targetCursor` is already at
   * or past the current write head. Chunks already evicted by ring-buffer
   * pressure (`droppedBefore > 0`) cannot be re-introduced; the cursor is
   * still reset so future appends produce a contiguous index sequence.
   */
  rollbackToCursor(taskId: string, targetCursor: number): void {
    const resolved = this.resolveId(taskId)
    const record = this.records.get(resolved)
    if (!record) return
    if (!Number.isFinite(targetCursor) || targetCursor < 0) return
    if (targetCursor >= record.cursor) return
    record.chunks = record.chunks.filter((c) => c.idx < targetCursor)
    record.cursor = targetCursor
  }

  /** Drop runtime bookkeeping so a later retry / re-execution can start clean (e.g. UI retry). */
  removeRecord(taskId: string): boolean {
    const resolved = this.resolveId(taskId)
    this.unlinkAliasesForCanonical(resolved)
    if (taskId !== resolved) this.idAliases.delete(taskId)
    this.stopHandlers.delete(resolved)
    return this.records.delete(resolved)
  }

  /**
   * Wait until the record either reaches a terminal status (completed /
   * failed / stopped), receives new output past `sinceOffset`, or the
   * timeout elapses — whichever comes first. Resolves with `true` when an
   * "interesting" change was observed; resolves with `false` on plain
   * timeout (state unchanged).
   *
   * Implementation note: subscribes to `notifyChunkAppended` so it wakes
   * up exactly when the writer side moves — no polling, no busy loop.
   *
   * Used by `TaskOutput` (`wait_for_status`) so the parent agent can
   * actively block for sub-agent progress instead of repeatedly polling
   * an empty buffer (which is what makes the LLM misread "(no output yet)"
   * as "produced nothing").
   */
  async waitForChange(
    taskId: string,
    opts: {
      sinceOffset: number
      waitForStatus?: 'completed' | 'failed' | 'any_terminal' | 'has_output'
      timeoutMs: number
    },
  ): Promise<boolean> {
    const resolved = this.resolveId(taskId)
    const record = this.records.get(resolved)
    if (!record) return false

    // Any terminal status wakes any non-`has_output` wait — once the task
    // reaches a terminal state, no further transitions are possible, so
    // continuing to block would just stall the caller until `timeoutMs`
    // elapses (up to 30 min via MAX_WAIT_TIMEOUT_MS). The caller reads
    // `record.status` from the rendered TaskOutput body to branch on
    // whether the specific kind it asked for actually matched.
    //
    // Previously this gated on the requested `waitForStatus` literal,
    // which created a footgun: a parent agent calling
    // `wait_for_status: 'completed'` on a sub-agent that actually FAILED
    // would block for the full timeout because 'failed' !== 'completed'.
    // Same in reverse (`wait_for_status: 'failed'` on a successful run).
    const isTerminalNow = (): boolean => {
      const s = record.status
      return s === 'completed' || s === 'failed' || s === 'stopped'
    }
    const totalAvailable = (): number => record.droppedBefore + record.chunks.length
    const hasNewOutputNow = (): boolean => totalAvailable() > opts.sinceOffset

    if (opts.waitForStatus === 'has_output') {
      if (hasNewOutputNow()) return true
    } else {
      if (isTerminalNow()) return true
    }

    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (changed: boolean): void => {
        if (settled) return
        settled = true
        try {
          unsubscribe()
        } catch {
          /* unsubscribe is best-effort */
        }
        clearTimeout(timer)
        resolve(changed)
      }

      const unsubscribe = this.onChunkAppended((event) => {
        if (event.taskId !== resolved) return
        if (opts.waitForStatus === 'has_output') {
          if (hasNewOutputNow()) finish(true)
        } else {
          if (isTerminalNow()) finish(true)
          else if (hasNewOutputNow() && opts.waitForStatus === undefined) {
            // No specific status requested → "wake on any new output OR terminal"
            finish(true)
          }
        }
      })
      const timer = setTimeout(() => finish(false), Math.max(1, opts.timeoutMs))
    })
  }

  getSlice(taskId: string, offset: number, limit: number): {
    record: TaskRuntimeRecord
    items: TaskRuntimeChunk[]
    nextOffset: number
    hasMore: boolean
  } | null {
    const resolved = this.resolveId(taskId)
    const record = this.records.get(resolved)
    if (!record) return null

    const normalizedOffset = Math.max(0, offset)
    const normalizedLimit = Math.max(1, Math.min(1000, limit))

    const start = Math.max(0, normalizedOffset - record.droppedBefore)
    const end = start + normalizedLimit
    const items = record.chunks.slice(start, end)

    const nextOffset = normalizedOffset + items.length
    const totalAvailableOffset = record.droppedBefore + record.chunks.length
    const hasMore = nextOffset < totalAvailableOffset

    return {
      record,
      items,
      nextOffset,
      hasMore,
    }
  }
}

export const taskRuntimeStore = new TaskRuntimeStore()
