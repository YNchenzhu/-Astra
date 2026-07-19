/**
 * Write-Ahead Log for DiffTransactions (P4d).
 *
 * Purpose: survive app restarts and crashes with in-flight DTs recoverable. Without a WAL,
 * a user who approved a Stale rebase or paused mid-review loses that state on reload —
 * which for destructive edits is a real problem (the on-disk bytes might already be the
 * proposed ones but the UI no longer has the original to undo).
 *
 * Storage layout:
 *   <userDataRoot>/diff-txs/<sessionId>/<dtId>.json
 *
 * Why per-DT files rather than one append-only log:
 *   • Trivially safe concurrent writes — no one else is writing the file named after a
 *     specific DT id, so we never have multi-writer contention.
 *   • Terminal cleanup is just an `unlink` — no log compaction needed.
 *   • Partial file corruption only loses one DT, not the whole session's history.
 *   • Each write is done via the P3 `atomicWriteFile` so there's never a half-JSON file.
 *
 * What we persist:
 *   • Full DT snapshot (same shape renderer mirror receives via broadcast).
 *   • Nothing else. We explicitly do NOT persist permission promises, the agentic
 *     message stream, etc. — those are ephemeral; the rehydration flow only restores DT
 *     lifecycle state so the UI can show / Abort / Rebase.
 *
 * Retention:
 *   • Non-terminal DTs (Pending/Approved/Writing/Failed/Stale) live until explicitly
 *     transitioned. No auto-cleanup because an overnight pause is a valid workflow.
 *   • Terminal DTs (Applied/Rejected) are kept for {@link TERMINAL_RETENTION_MS} after
 *     their last update so users can still audit "what did the AI do in the last N hours"
 *     even after restart. After that window a passive sweep deletes them.
 *
 * Thread safety:
 *   Electron main is single-threaded — no locks needed. All I/O is sync for simplicity;
 *   the per-transition write is one small file so sync cost is negligible relative to
 *   the diff pipeline itself.
 */

import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteFile } from './atomicWriter'
import { getDiffTxStore, type DiffTransactionStore } from './DiffTransactionStore'
import { isDtClosed } from './diffTransactionFsm'
import type { DiffTransaction, DiffTxId } from './DiffTransactionTypes'

/** How long terminal DTs linger on disk after their last update. 4 hours. */
export const TERMINAL_RETENTION_MS = 4 * 60 * 60 * 1000

/**
 * How often the sweeper scans the dir for expired terminals. 10 minutes is plenty —
 * the sweep is cheap (readdir + statSync per file) and nothing bad happens if expired
 * terminals linger a few minutes longer.
 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000

export interface WalOptions {
  /**
   * Absolute directory under which the WAL is rooted. Production uses
   * `app.getPath('userData')/diff-txs` — tests pass a throwaway tempdir.
   */
  rootDir: string
  /**
   * Logical session namespace. Keeps different app windows / launches from clobbering
   * each other's per-DT files. Default is a stable id so reloads recover last session.
   */
  sessionId?: string
  /** Override terminal retention (test hook). */
  terminalRetentionMs?: number
  /** Override sweep cadence (test hook; set to 0 to disable auto-sweep). */
  sweepIntervalMs?: number
}

function safeSessionId(raw?: string): string {
  if (!raw) return 'default'
  // Replace anything that's not alphanum/_- with '-'. Matches Windows & POSIX safety.
  return raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) || 'default'
}

export class DtWalStore {
  private readonly dir: string
  private readonly retentionMs: number
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private storeUnsubscribe: (() => void) | null = null
  // Parameter-properties aren't erasable — expand to an explicit field.
  private readonly opts: WalOptions

  constructor(opts: WalOptions) {
    this.opts = opts
    this.dir = path.join(opts.rootDir, safeSessionId(opts.sessionId))
    this.retentionMs = opts.terminalRetentionMs ?? TERMINAL_RETENTION_MS
  }

  /** Absolute path used for a given DT's WAL file. */
  fileFor(dtId: DiffTxId): string {
    // Ids are already opaque UUIDs; no need to sanitize further but we do it anyway
    // because a compromised id wouldn't help escape the dir.
    const safe = dtId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 96)
    return path.join(this.dir, `${safe}.json`)
  }

  private ensureDir(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
    } catch (e) {
      console.warn('[DtWal] mkdir failed (non-fatal):', e)
    }
  }

  /**
   * Persist one DT snapshot. Uses `atomicWriteFile` so readers never see a truncated
   * JSON. Errors are swallowed into warnings — WAL is a recovery aid, not an invariant
   * of the live pipeline, so a WAL failure must never break the agentic loop.
   */
  persist(dt: DiffTransaction): void {
    this.ensureDir()
    const file = this.fileFor(dt.id)
    const body = JSON.stringify(dt)
    const res = atomicWriteFile(file, {
      // Always a blind overwrite — WAL is our own file, we don't need the pre-check.
      expectedContentHash: null,
      newContent: body,
    })
    if (!res.ok) {
      console.warn(`[DtWal] persist(${dt.id}) failed: ${res.message}`)
    }
  }

  /** Delete one DT's WAL file. Idempotent — missing file is fine. */
  remove(dtId: DiffTxId): void {
    const file = this.fileFor(dtId)
    try {
      fs.unlinkSync(file)
    } catch (e: unknown) {
      const code = (e as { code?: string }).code
      if (code !== 'ENOENT') console.warn(`[DtWal] remove(${dtId}) failed:`, e)
    }
  }

  /**
   * Load all DTs from disk. Silently drops files that don't parse or don't match the
   * expected shape — they were probably written by an older schema and we prefer forward
   * progress to hard-erroring at startup. A warning is logged per skipped file so a
   * developer investigating lost state has a breadcrumb.
   */
  loadAll(): DiffTransaction[] {
    if (!fs.existsSync(this.dir)) return []
    const names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'))
    const out: DiffTransaction[] = []
    for (const name of names) {
      const full = path.join(this.dir, name)
      try {
        const body = fs.readFileSync(full, 'utf-8')
        const parsed = JSON.parse(body) as unknown
        if (isRestorableDt(parsed)) {
          out.push(parsed)
        } else {
          console.warn(`[DtWal] skipping malformed WAL file: ${name}`)
        }
      } catch (e) {
        console.warn(`[DtWal] failed to read WAL file ${name}:`, e)
      }
    }
    return out
  }

  /**
   * One-time migration + cleanup of legacy/orphan session directories.
   *
   * Historically the WAL was namespaced by `pid-<pid>`, so every launch wrote into a
   * fresh dir and crash recovery never found the prior session's files — and those
   * abandoned dirs leaked forever (the {@link sweep} only ever touches the *current*
   * session dir). Now that we use a stable session id, scan sibling dirs under the
   * root: migrate any still-restorable non-terminal DT into the current dir (so an
   * interrupted review survives this upgrade), then delete the orphan dir.
   *
   * Returns a summary for logging. All I/O is best-effort — a failure here must never
   * break boot.
   */
  cleanupOrphanSessions(): { migrated: number; removedDirs: number } {
    const root = this.opts.rootDir
    const currentName = path.basename(this.dir)
    let migrated = 0
    let removedDirs = 0
    let names: string[]
    try {
      names = fs.readdirSync(root)
    } catch {
      return { migrated, removedDirs }
    }
    for (const name of names) {
      if (name === currentName) continue
      const full = path.join(root, name)
      try {
        if (!fs.statSync(full).isDirectory()) continue
      } catch {
        continue
      }
      // Migrate restorable non-terminal DTs forward before deleting the dir.
      try {
        const files = fs.readdirSync(full).filter((n) => n.endsWith('.json'))
        for (const fileName of files) {
          const filePath = path.join(full, fileName)
          try {
            const body = fs.readFileSync(filePath, 'utf-8')
            const parsed = JSON.parse(body) as unknown
            if (isRestorableDt(parsed) && !isDtClosed(parsed)) {
              const dest = this.fileFor(parsed.id)
              if (!fs.existsSync(dest)) {
                this.ensureDir()
                fs.writeFileSync(dest, body, 'utf-8')
                migrated++
              }
            }
          } catch {
            /* unreadable / malformed file — skip, it dies with the dir below */
          }
        }
      } catch {
        /* unreadable dir — still attempt to remove it below */
      }
      try {
        fs.rmSync(full, { recursive: true, force: true })
        removedDirs++
      } catch (e) {
        console.warn(`[DtWal] failed to remove orphan session dir ${name}:`, e)
      }
    }
    return { migrated, removedDirs }
  }

  /**
   * Remove terminal DTs whose last update is older than the retention window. Called
   * on a timer once started; tests can also invoke directly.
   */
  sweep(now: number = Date.now()): number {
    if (!fs.existsSync(this.dir)) return 0
    let removed = 0
    const names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'))
    for (const name of names) {
      const full = path.join(this.dir, name)
      try {
        const body = fs.readFileSync(full, 'utf-8')
        const parsed = JSON.parse(body) as unknown
        if (!isRestorableDt(parsed)) continue
        if (isDtClosed(parsed) && now - parsed.updatedAt > this.retentionMs) {
          try {
            fs.unlinkSync(full)
            removed++
          } catch {
            /* racey delete — ignore */
          }
        }
      } catch {
        // Unparsable — consider it orphan and remove to keep the dir tidy.
        try {
          fs.unlinkSync(full)
          removed++
        } catch {
          /* ignore */
        }
      }
    }
    return removed
  }

  /**
   * Attach to a DiffTransactionStore. Every broadcast that changes durable state (Created,
   * Transitioned, Rebased) triggers a persist; Closed triggers a persist-and-stop-observing
   * (the terminal DT stays on disk until the sweeper kicks in).
   */
  attachToStore(store: DiffTransactionStore = getDiffTxStore()): void {
    if (this.storeUnsubscribe) this.storeUnsubscribe()
    this.ensureDir()
    this.storeUnsubscribe = store.addListener((event) => {
      switch (event.type) {
        case 'Snapshot':
          // Ignore — rehydration uses loadAll(), this event is for renderer mirrors.
          break
        case 'Created':
          this.persist(event.transaction)
          break
        case 'Transitioned':
        case 'Rebased':
          this.persist(event.transaction)
          break
        case 'Closed':
          // We already persisted on the Transitioned that preceded this Closed, so no
          // additional write needed. Retention handles the eventual cleanup.
          break
        case 'Dropped':
          // In-memory eviction. We do NOT remove the WAL file here — terminal DTs stay
          // for audit until the sweeper gets to them. Remove only if caller invokes `remove()`.
          break
      }
    })

    const interval = this.opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS
    if (interval > 0) {
      this.sweepTimer = setInterval(() => {
        this.sweep()
      }, interval)
      // Prevent the sweep timer from blocking Node exit in tests.
      if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref()
    }
  }

  /** Stop the sweeper and unsubscribe. Safe to call multiple times. */
  detach(): void {
    if (this.storeUnsubscribe) {
      this.storeUnsubscribe()
      this.storeUnsubscribe = null
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  /**
   * Rehydrate: read every WAL file, push each non-terminal DT into the given store.
   * Terminal DTs are loaded but NOT pushed into the live store — they're audit-only.
   *
   * Returns summary for logging.
   */
  rehydrate(store: DiffTransactionStore = getDiffTxStore()): {
    restored: number
    skippedTerminal: number
  } {
    const all = this.loadAll()
    let restored = 0
    let skippedTerminal = 0
    for (const dt of all) {
      if (isDtClosed(dt)) {
        skippedTerminal++
        continue
      }
      // We restore by dropping the DT directly into the store's internal map. Calling
      // `store.create()` with a synthetic id would work but duplicates the event
      // broadcast logic (Created fires again) and we'd rather have a quiet reload.
      //
      // Access pattern: store exposes `create()` publicly, and its `dispatch()` handles
      // ongoing transitions. We pass the full snapshot via a dedicated restore helper
      // added in DiffTransactionStore — see `restoreFromSnapshot`.
      //
      // In absence of that helper, a reasonable fallback is to call store.create() with
      // the DT's original id and manually replay its stateHistory. We use create() here.
      // Idempotency: if the id already lives in the store (e.g. a test double-called
      // rehydrate, or the store was partially initialised elsewhere) skip — overwriting
      // would clobber newer in-memory state we don't own.
      if (store.get(dt.id)) {
        continue
      }
      try {
        store.create({
          id: dt.id,
          filePath: dt.filePath,
          baseSnapshot: dt.baseSnapshot,
          proposed: dt.proposed,
          riskWarnings: dt.riskWarnings,
          at: dt.createdAt,
        })
        // Replay transitions so the restored DT lands in the right state. Each
        // transition broadcast is fine — renderer mirrors will converge.
        for (const entry of dt.stateHistory) {
          if (entry.from === 'Pending' && entry.to === 'Pending') continue // "created" marker
          this.replayTransition(store, dt, entry.from, entry.to, entry.at, entry.reason)
        }
        restored++
      } catch (e) {
        console.warn(`[DtWal] rehydrate(${dt.id}) failed:`, e)
      }
    }
    return { restored, skippedTerminal }
  }

  /** Drive one transition during rehydration via store.dispatch(). */
  private replayTransition(
    store: DiffTransactionStore,
    dt: DiffTransaction,
    from: DiffTransaction['state'],
    to: DiffTransaction['state'],
    at: number,
    reason?: string,
  ): void {
    // Map (from,to) → event. If a transition can't be replayed from its `from` state we
    // silently skip — the WAL has been tampered with or our FSM changed since it was
    // written.
    if (to === 'Approved') {
      store.dispatch({ type: 'PermissionApproved', id: dt.id, at, reason })
      return
    }
    if (to === 'Rejected') {
      store.dispatch({ type: 'PermissionRejected', id: dt.id, at, reason })
      return
    }
    if (to === 'Writing') {
      if (from === 'Failed') store.dispatch({ type: 'Retry', id: dt.id, at })
      else store.dispatch({ type: 'WriteStart', id: dt.id, at })
      return
    }
    if (to === 'Applied') {
      store.dispatch({
        type: 'WriteApplied',
        id: dt.id,
        at,
        appliedContentHash: dt.appliedContentHash ?? '',
        appliedReadId: dt.appliedReadId ?? null,
      })
      return
    }
    if (to === 'Failed') {
      store.dispatch({
        type: 'WriteFailed',
        id: dt.id,
        at,
        error: dt.error ?? { code: 'UNKNOWN', message: 'Restored without error detail.', recoverable: false },
      })
      return
    }
    if (to === 'Stale') {
      store.dispatch({ type: 'MarkStale', id: dt.id, at, reason })
      return
    }
  }
}

/** Narrowing guard for parsed JSON — tolerant but refuses gibberish. */
function isRestorableDt(v: unknown): v is DiffTransaction {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.filePath === 'string' &&
    typeof o.state === 'string' &&
    typeof o.createdAt === 'number' &&
    typeof o.updatedAt === 'number' &&
    typeof o.baseSnapshot === 'object' &&
    o.baseSnapshot !== null &&
    typeof (o.baseSnapshot as Record<string, unknown>).content === 'string' &&
    typeof o.proposed === 'object' &&
    o.proposed !== null &&
    typeof (o.proposed as Record<string, unknown>).content === 'string' &&
    Array.isArray(o.stateHistory)
  )
}

// ---------------------------------------------------------------------------
// Process-wide singleton wiring.
// ---------------------------------------------------------------------------

let globalWal: DtWalStore | null = null

export function getWalStore(): DtWalStore | null {
  return globalWal
}

/**
 * Initialise + attach the WAL to the global DT store. Call from `app.whenReady()`
 * alongside the other diff-subsystem wires. Returns the constructed WAL for
 * potential use by tests / diagnostics.
 */
export function attachWal(opts: WalOptions): DtWalStore {
  if (globalWal) globalWal.detach()
  globalWal = new DtWalStore(opts)
  // Migrate + drop legacy per-pid session dirs into the current (stable) dir before we
  // read, otherwise an interrupted review left behind by an older build would be lost.
  globalWal.cleanupOrphanSessions()
  // Rehydrate BEFORE attaching so the initial rehydrate events don't recursively
  // re-persist what we just read.
  globalWal.rehydrate()
  globalWal.attachToStore()
  return globalWal
}

export function shutdownWal(): void {
  if (globalWal) {
    globalWal.detach()
    globalWal = null
  }
}

/** Test-only reset. */
export function __resetWalForTests(): void {
  if (globalWal) globalWal.detach()
  globalWal = null
}
