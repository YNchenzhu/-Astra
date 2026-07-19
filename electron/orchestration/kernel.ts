/**
 * OrchestrationKernel — single authority for phase transitions (plan k1).
 *
 * Production main chat runs in **drive mode**: `runDriveMainChat` owns the outer
 * turn `for`, and `CallModel` delegates to `driveInnerLoop` (the kernel-owned
 * inner `while`) via the `runCallModel` override. `runAgenticLoop` is only used
 * by the legacy delegate path (`runCallModel` omitted) and by non-kernel callers
 * (sub-agents / teammates / skill forks). Transcript is synced via the reducer
 * (`applySessionCommands`) on both paths.
 */

import type { AgenticLoopCallbacks, AgenticLoopParams } from './phases/iteration'
// Chunk 8b moved the iteration primitives into `phases/iteration`. Chunk 8c
// further extracted the drive-mode `while` into its own file at
// `phases/driveInnerLoop.ts` (kept separate so vi.mock of `./phases/iteration`
// can intercept the inner setupAgenticLoopForRun / runAgenticIteration calls).
import { driveInnerLoop } from './phases/driveInnerLoop'
import type { OrchestrationPorts } from './ports'
import type { KernelInboxItem, KernelLoopState, TranscriptSnapshot } from './kernelTypes'
import {
  cloneTranscript,
  createInitialKernelLoopState,
  fingerprintTranscript,
  normalizeKernelLoopState,
} from './kernelTypes'
import {
  applySessionCommands,
  drainInboxToTranscript,
} from './sessionCommands'
import { type OrchestrationObserver } from './observability'
import { DefaultToolRuntimePort } from './toolRuntime/defaultToolRuntimePort'
import {
  markPausedToolsResumedForConversation,
  markRunningToolsPausedForConversation,
} from './toolRuntime/state'
import {
  buildHitlFailedPhase,
  buildInterruptPhase,
  buildLifecyclePhase,
  buildOuterLoopPhase,
  buildTranscriptDriftPhase,
  createTransportAdapter,
  emitPhaseEvent,
  noopHookPolicy,
} from './transport'
import type { KernelPhaseCtx } from './phases/types'
import { runPrepareContextPhase } from './phases/prepareContext'
import { runCallModelPhase } from './phases/callModel'
import { runTerminalPhase } from './phases/terminal'
import { createPolicyEnginePermissionPort } from './policyEnginePermissionPort'
import { getMaxOuterIterations } from './config'
import { getToolRuntimeMetrics } from './toolRuntime/metrics'
import { getPolicyEngine } from './toolRuntime/policy'
import {
  decideConductorAction,
  isConductorEnabled,
  type ConductorBestOfNPort,
} from './conductor'
import { getVerificationGateState } from '../planning/verificationGateState'
import type { AgenticLoopResult } from '../ai/loopEvents'
import type { ChatMode } from './chatMode'
import { asAgentId } from '../tools/ids'
import type { ArtifactManifest, ArtifactPort } from './artifact'
import { createNoopMcpSessionAdapter } from './mcpSessionAdapter'
import type { StreamEvent } from '../ai/streamHandler'
import type { InlineSkillSessionState } from '../ai/runAgenticToolUse'
import type { AppendixAFlowReporter } from './appendixAFlow'
import type { CheckpointId, CheckpointPort } from './checkpoint'
import { createInMemoryCheckpointPort } from './checkpoint'
import type { KernelPersistenceAdapter, PauseGate, PersistedKernelState } from './pauseResume'
import { buildPersistedState, createPauseGate } from './pauseResume'
import { DEFAULT_RETRY_POLICY, withRetry } from './retryPolicy'
import { saveInboxToDisk, loadInboxFromDisk } from './inboxPersistence'
import type { KernelSlice } from './kernelInternals'
import {
  bumpInnerIteration as bumpInnerIterationFree,
  emitPhase as emitPhaseFree,
  resetInnerIteration as resetInnerIterationFree,
  transitionPhase as transitionPhaseFree,
  wrapAppendixAReporterWithIterationTracking as wrapAppendixAReporterWithIterationTrackingFree,
} from './kernelTelemetry'

const noopPermission = {
  noteToolInvocation(toolName: string) {
    void toolName
  },
}

/**
 * 阶段 3 — best-effort extraction of "the task" from the kernel transcript for
 * the Conductor's best-of-N action: the most recent user message's text. Returns
 * '' when none is found (the port decides how to handle an empty task).
 */
function extractLastUserTask(transcript: KernelLoopState['transcript']): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i]
    if (!m || m.role !== 'user') continue
    const c = m.content as unknown
    if (typeof c === 'string') {
      if (c.trim()) return c
      continue
    }
    if (Array.isArray(c)) {
      const text = c
        .map((b) =>
          b && typeof b === 'object' && (b as { type?: string }).type === 'text'
            ? String((b as { text?: string }).text ?? '')
            : '',
        )
        .filter(Boolean)
        .join('\n')
      if (text.trim()) return text
    }
  }
  return ''
}

export type LegacyDelegateRunParams = {
  agenticParams: AgenticLoopParams
  agenticCallbacks: AgenticLoopCallbacks
  /** Renderer messages — seed the session reducer before the legacy loop. */
  rendererMessages: AgenticLoopParams['messages']
  /**
   * Optional CallModel implementation. When omitted, `runLegacyDelegateMainChat`
   * dispatches to `runAgenticLoop` (legacy / non-drive path). Drive mode supplies a custom
   * implementation that owns the inner `while` loop directly — see {@link runDriveMainChat}.
   *
   * The implementation receives the same `agenticParams` (already augmented with merged
   * abort signal, kernel inbox drain, orchestrated tool execution etc.) and `callbacks` that
   * the default path would have used.
   */
  runCallModel?: (
    agenticParams: AgenticLoopParams,
    callbacks: AgenticLoopCallbacks,
  ) => Promise<void>
  /**
   * 阶段 2/3 — optional outcome capture. In drive mode this is forwarded into
   * the `driveInnerLoop` hooks → `setupAgenticLoopForRun`'s `onTerminate`
   * option, so callers (notably orchestrated sub-agents) can read the typed
   * {@link AgenticLoopResult}'s termination reason to drive retry / Conductor
   * decisions. Main chat omits it.
   */
  onTerminate?: (result: AgenticLoopResult) => void
  /**
   * 阶段 3 — optional best-of-N execution port for the kernel Conductor. When
   * wired AND `POLE_KERNEL_CONDUCTOR` is on, an unaddressed verification `FAIL`
   * at turn end fans out a best-of-N exploration instead of (or before) a plain
   * re-dispatch. Left as an injected port so the kernel never hard-depends on
   * the sub-agent / best-of-n machinery. Omitted → FAIL falls back to rewind.
   */
  conductorBestOfNPort?: ConductorBestOfNPort
}

export type KernelInterruptReason =
  | 'user'
  | 'timeout'
  | 'fork_replaced'
  | 'superseded'
  | 'shutdown'
  /**
   * P2.1 follow-up — Human-In-The-Loop pause. A tool threw {@link InterruptForHITL}; the
   * loop must exit cleanly so the renderer can collect the user's answer and call
   * `enqueueHumanResume(...)` for the resumed turn.
   *
   * Difference from `'user'`: HITL is initiated by the model (not the user clicking Stop),
   * the iteration's tool_use ↔ tool_result pairing has already been preserved with
   * placeholder blocks, and the renderer surfaces a dialog instead of a cancel toast.
   */
  | 'hitl'

export class OrchestrationKernel implements KernelPhaseCtx {
  /** Mutated only through {@link setState}; phase modules read it directly. */
  state: KernelLoopState
  readonly ports: OrchestrationPorts
  readonly observer: OrchestrationObserver | undefined
  /** Routes `orchestration_phase` stream telemetry to the correct tab */
  readonly streamConversationId: string | undefined
  /**
   * kernel-owned abort controller — the **soft** signal. Aborts on any `interrupt()` call.
   * `runLegacyDelegateMainChat` derives a merged signal that aborts if EITHER the caller's
   * `agenticParams.signal` fires OR `interrupt(reason)` is called on this kernel. Keeping
   * ownership here lets operator UI (the IDE pause / cancel / supersede) cancel through
   * the kernel without racing the caller's signal.
   *
   * P0-2 split: "cancel" tools (default `interruptBehavior`) react to THIS signal.
   * "block" tools (long-running rsync / migrations / remote polls) read
   * {@link getHardAbortSignal} instead so a single mid-turn user interrupt does not waste
   * their in-flight work.
   */
  readonly abortController: AbortController = new AbortController()
  /**
   * P0-2 — kernel-owned **hard** abort controller. Used by tools with
   * `interruptBehavior: 'block'`. Aborts only on:
   *   1. An explicit `interrupt(reason, { hard: true })` call (renderer "second Stop" or
   *      shutdown).
   *   2. Soft-interrupt grace period expiry (auto-promotion after
   *      {@link softInterruptGraceMs}, default 30s).
   *
   * Process shutdown signals reach 'block' tools via the caller's external
   * `agenticParams.signal` (we merge both into the soft lane), so "process exit" never
   * depends on hard escalation alone.
   */
  readonly hardAbortController: AbortController = new AbortController()
  private interruptReason: KernelInterruptReason | undefined = undefined
  /**
   * P0-2 — auto-promote soft interrupt to hard after this many ms. Set to 0 to disable
   * auto-promotion (block tools then only honor explicit hard interrupt). Default 30s.
   */
  private softInterruptGraceMs: number = 30000
  private gracePromoteTimer: ReturnType<typeof setTimeout> | null = null
  /** optional checkpoint port used for auto + manual snapshots. */
  private readonly checkpointPort: CheckpointPort | undefined
  /** cooperative pause gate awaited at iteration boundaries. */
  private readonly pauseGate: PauseGate = createPauseGate()
  /** optional persistence adapter for save/restore across process restarts. */
  private readonly persistenceAdapter: KernelPersistenceAdapter | undefined
  /** optional artifact port aggregating rich outputs emitted during the turn. */
  private readonly artifactPort: ArtifactPort | undefined
  /**
   * P0-1 — wall-clock timestamp of the last successful `persist()` write. Used
   * to throttle the per-inner-iteration auto-checkpoint so callers can call
   * `persist({ throttleMs: 200 })` cheaply at every iteration boundary without
   * flooding disk I/O on multi-iteration turns.
   *
   * Force-saves (e.g. IPC-triggered "before quit") pass no `throttleMs` and
   * always proceed.
   */
  private lastPersistAt: number = 0
  /**
   * P2-1 (audit Bug-4 fix) — throttle for `hitl_persistence_failed` phase events.
   *
   * Without throttling, a burst of `enqueueInboxItem` calls (slash commands +
   * mailbox drafts + synthetic user text + HITL resume) on a full disk would
   * fire ONE `hitl_persistence_failed` event per call, spamming the renderer
   * with repeated toasts for the SAME underlying disk failure.
   *
   * `key` is the failure reason; if the same reason fires again within
   * {@link hitlFailureEmitWindowMs}, we suppress. A different reason
   * (e.g. transition from `'disk_error'` to `'cleanup_failed'`) re-emits.
   */
  private lastHitlFailureEmit: { key: string; at: number } | null = null
  private hitlFailureEmitWindowMs: number = 5_000
  /**
   * Telemetry / state-accessor slice handed to the free functions in
   * `kernelTelemetry.ts` (`emitPhase`, `bumpInnerIteration`,
   * `wrapAppendixAReporterWithIterationTracking`, `transitionPhase`,
   * `resetInnerIteration`). Built lazily on first access so subclass /
   * test mocks that override `state` don't see a stale reference.
   *
   * The slice exposes only what the helpers need (no private field leak):
   * a read/write pair for `state`, a read/write pair for `interruptReason`,
   * and read-only references to ports / observer / abortController /
   * pauseGate / checkpointPort / artifactPort / persistenceAdapter.
   */
  private cachedSlice: KernelSlice | null = null
  private getSlice(): KernelSlice {
    if (this.cachedSlice) return this.cachedSlice
    // Arrow methods capture `this` correctly when handed to free helpers.
    this.cachedSlice = {
      state: {
        get: () => this.state,
        set: (next) => { this.state = next },
      },
      interruptReason: {
        get: () => this.interruptReason,
        set: (reason) => { this.interruptReason = reason },
      },
      ports: this.ports,
      streamConversationId: this.streamConversationId,
      abortController: this.abortController,
      pauseGate: this.pauseGate,
      observer: this.observer,
      checkpointPort: this.checkpointPort,
      artifactPort: this.artifactPort,
      persistenceAdapter: this.persistenceAdapter,
    }
    return this.cachedSlice
  }

  constructor(
    ports: OrchestrationPorts,
    observer: OrchestrationObserver | undefined,
    initial: KernelLoopState,
    streamConversationId?: string,
    options?: {
      /** supply to enable snapshot/rewind/fork. Omit for legacy behavior. */
      checkpointPort?: CheckpointPort
      /** supply to enable pause/resume durability across restarts. */
      persistenceAdapter?: KernelPersistenceAdapter
      /** supply to collect artifacts and emit a Terminal-phase manifest. */
      artifactPort?: ArtifactPort
    },
  ) {
    this.ports = ports
    this.observer = observer
    this.streamConversationId = streamConversationId
    this.state = normalizeKernelLoopState(initial)
    this.checkpointPort = options?.checkpointPort
    this.persistenceAdapter = options?.persistenceAdapter
    this.artifactPort = options?.artifactPort
  }

  getState(): KernelLoopState {
    return this.state
  }

  /** Phase modules (and adjacent helpers) call this to advance kernel state. */
  setState(next: KernelLoopState): void {
    this.state = next
  }

  /**
   * interrupt the in-flight model turn.
   *
   * Safe to call at any time. Multiple soft calls are idempotent; the first reason wins.
   * Emits a `orchestration_phase` telemetry event tagged `interrupt` so the renderer can
   * surface the cancel cause. The kernel's internal soft signal is aborted, which cascades
   * to any `streamText` / 'cancel' tool execution currently observing it. Terminal +
   * `onSessionEnd` still run.
   *
   * P0-2 — `opts.hard === true` ALSO aborts the hard signal, which terminates 'block'
   * tools. Soft interrupts auto-promote to hard after {@link softInterruptGraceMs} (30s
   * default) so 'block' tools cannot indefinitely block the user from canceling. A second
   * `interrupt()` call with `hard: true` (renderer "press Stop again to force") cancels
   * the grace timer and escalates immediately.
   */
  interrupt(reason: KernelInterruptReason = 'user', opts?: { hard?: boolean }): void {
    const isHard = opts?.hard === true

    // Hard escalation path — even if we already soft-interrupted, allow promotion.
    if (isHard) {
      if (this.gracePromoteTimer) {
        clearTimeout(this.gracePromoteTimer)
        this.gracePromoteTimer = null
      }
      if (this.interruptReason === undefined) {
        this.interruptReason = reason
        // P2 §6.3 migration — strict builder.
        emitPhaseEvent(
          this.ports.transport,
          buildInterruptPhase({
            iteration: this.state.iteration,
            innerIteration: this.state.innerIteration,
            conversationId: this.streamConversationId,
            interruptReason: reason,
          }),
        )
        try {
          this.abortController.abort(new Error(`[OrchestrationKernel] interrupt: ${reason}`))
        } catch {
          /* ignore */
        }
      }
      if (!this.hardAbortController.signal.aborted) {
        emitPhaseEvent(
          this.ports.transport,
          buildInterruptPhase({
            iteration: this.state.iteration,
            innerIteration: this.state.innerIteration,
            conversationId: this.streamConversationId,
            interruptReason: `${reason}:hard`,
          }),
        )
        try {
          this.hardAbortController.abort(
            new Error(`[OrchestrationKernel] hard interrupt: ${reason}`),
          )
        } catch {
          /* ignore */
        }
      }
      return
    }

    // Soft path — idempotent for repeated soft calls.
    if (this.interruptReason !== undefined) return
    this.interruptReason = reason
    emitPhaseEvent(
      this.ports.transport,
      buildInterruptPhase({
        iteration: this.state.iteration,
        innerIteration: this.state.innerIteration,
        conversationId: this.streamConversationId,
        interruptReason: reason,
      }),
    )
    try {
      this.abortController.abort(new Error(`[OrchestrationKernel] interrupt: ${reason}`))
    } catch {
      /* ignore — already aborted */
    }
    // Schedule auto-promotion to hard so 'block' tools don't hold the user hostage.
    if (this.softInterruptGraceMs > 0 && !this.hardAbortController.signal.aborted) {
      this.gracePromoteTimer = setTimeout(() => {
        this.gracePromoteTimer = null
        if (this.hardAbortController.signal.aborted) return
        try {
          emitPhaseEvent(
            this.ports.transport,
            buildInterruptPhase({
              iteration: this.state.iteration,
              innerIteration: this.state.innerIteration,
              conversationId: this.streamConversationId,
              interruptReason: `${reason}:grace_expired`,
            }),
          )
          this.hardAbortController.abort(
            new Error(
              `[OrchestrationKernel] soft interrupt grace expired (${this.softInterruptGraceMs}ms): ${reason}`,
            ),
          )
        } catch {
          /* ignore */
        }
      }, this.softInterruptGraceMs)
      // unref so test/dev shutdown isn't blocked by a pending timer.
      if (typeof (this.gracePromoteTimer as unknown as { unref?: () => void }).unref === 'function') {
        try {
          ;(this.gracePromoteTimer as unknown as { unref: () => void }).unref()
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** for tests and advanced callers that want to observe the kernel's soft signal directly. */
  getAbortSignal(): AbortSignal {
    return this.abortController.signal
  }

  /**
   * P0-2 (audit Bug-2 fix) — Lifecycle teardown. Cancels any pending grace
   * promotion timer so a soft interrupt that fired late in a turn doesn't
   * emit a phantom `interrupt:grace_expired` event 30 seconds after the
   * session ended.
   *
   * `unregisterOrchestrationKernelForConversation` calls this on session
   * teardown. Idempotent; safe to call multiple times.
   *
   * Does NOT abort the kernel signal — by the time dispose() is called the
   * session has already finished naturally (Terminal ran). Aborting now
   * would race with any post-Terminal cleanup that observes the signal.
   */
  dispose(): void {
    if (this.gracePromoteTimer) {
      try {
        clearTimeout(this.gracePromoteTimer)
      } catch {
        /* ignore */
      }
      this.gracePromoteTimer = null
    }
  }

  /**
   * P0-2 — observable for the kernel's hard signal. 'block' tools (long-running shell /
   * remote polls / file sync) react to this signal only; ordinary 'cancel' tools react to
   * {@link getAbortSignal} instead.
   */
  getHardAbortSignal(): AbortSignal {
    return this.hardAbortController.signal
  }

  /**
   * P0-2 — override the grace period after which a soft interrupt auto-promotes to
   * hard. Set to 0 to disable auto-promotion. Defaults to 30000ms.
   */
  setSoftInterruptGraceMs(ms: number): void {
    this.softInterruptGraceMs = Math.max(0, ms)
  }

  /** last reason supplied to {@link interrupt}, or `undefined` when not interrupted. */
  getInterruptReason(): KernelInterruptReason | undefined {
    return this.interruptReason
  }

  /**
   * take a manual snapshot of the current kernel state. Returns undefined when no
   * checkpoint port is wired. Safe to call at any time; callers typically do it at phase boundaries
   * or immediately before committing a risky tool batch.
   */
  snapshot(tag: string): CheckpointId | undefined {
    if (!this.checkpointPort) return undefined
    try {
      return this.checkpointPort.snapshot(tag, this.state)
    } catch (e) {
      console.warn('[OrchestrationKernel] snapshot failed:', e)
      return undefined
    }
  }

  /**
   * rewind kernel state to a prior checkpoint id. Returns true when successfully
   * applied, false when the id is unknown or the port is missing. Does NOT roll back external
   * side effects (filesystem / shell); the caller is responsible for any renderer-side rollback.
   */
  rewind(id: CheckpointId): boolean {
    if (!this.checkpointPort) return false
    const restored = this.checkpointPort.rewind(id)
    if (!restored) return false
    // Rewind restores historical content while preserving monotonic revision.
    // Any AgentLoop still based on the pre-rewind snapshot is now stale.
    const transcript = cloneTranscript(restored.transcript)
    this.state = normalizeKernelLoopState({
      ...restored,
      transcript,
      transcriptRevision: this.state.transcriptRevision + 1,
      transcriptFingerprint: fingerprintTranscript(transcript),
    })
    emitPhaseEvent(
      this.ports.transport,
      buildLifecyclePhase({
        phase: 'rewound',
        iteration: this.state.iteration,
        innerIteration: this.state.innerIteration,
        conversationId: this.streamConversationId,
      }),
    )
    return true
  }

  /** expose checkpoint port so fork flows can peek/list without mutation. */
  getCheckpointPort(): CheckpointPort | undefined {
    return this.checkpointPort
  }

  /**
   * expose artifact port so producers (tools, compact, subagents) can publish without
   * holding a reference to the kernel. Returns undefined when no port is wired.
   */
  getArtifactPort(): ArtifactPort | undefined {
    return this.artifactPort
  }

  /** snapshot artifacts for the current outer turn as a manifest. */
  buildArtifactManifest(): ArtifactManifest | undefined {
    if (!this.artifactPort) return undefined
    const entries = this.artifactPort.list({ producerTurn: this.state.iteration })
    return { turn: this.state.iteration, entries }
  }

  /**
   * cooperative pause. Sets a flag that the next iteration boundary observes; in-flight
   * tool execution and streaming are not interrupted (use `interrupt('user')` for hard stop).
   * Emits a `pause` phase event for UI + telemetry. Safe to call multiple times.
   */
  pause(): void {
    if (this.pauseGate.isPaused()) return
    this.pauseGate.pause()
    emitPhaseEvent(
      this.ports.transport,
      buildLifecyclePhase({
        phase: 'paused',
        iteration: this.state.iteration,
        innerIteration: this.state.innerIteration,
        conversationId: this.streamConversationId,
      }),
    )
    // Audit §3.2 wire-up — flip every currently-running tool owned by this
    // conversation into the `'paused'` ToolRuntimeState status. Cooperative:
    // the tool's async work keeps running (use `interrupt()` for hard
    // cancellation), but the registry's status reflects the pause so
    // renderer / telemetry / future scheduler decisions that read the
    // ToolRuntimeSnapshot see consistent state.
    const convForPause = this.streamConversationId?.trim()
    if (convForPause) {
      try {
        markRunningToolsPausedForConversation(convForPause)
      } catch (e) {
        console.warn('[OrchestrationKernel] markRunningToolsPausedForConversation threw:', e)
      }
    }
  }

  /** resume a paused kernel. No-op if not paused. */
  resume(): void {
    if (!this.pauseGate.isPaused()) return
    this.pauseGate.resume()
    emitPhaseEvent(
      this.ports.transport,
      buildLifecyclePhase({
        phase: 'resumed',
        iteration: this.state.iteration,
        innerIteration: this.state.innerIteration,
        conversationId: this.streamConversationId,
      }),
    )
    // Audit §3.2 wire-up — flip the tools that we paused above back to
    // `'running'`. Only tools still in `'paused'` are flipped; tools that
    // completed / failed / aborted while paused stay terminal.
    const convForResume = this.streamConversationId?.trim()
    if (convForResume) {
      try {
        markPausedToolsResumedForConversation(convForResume)
      } catch (e) {
        console.warn('[OrchestrationKernel] markPausedToolsResumedForConversation threw:', e)
      }
    }
  }

  /** for tests + renderer polling. */
  isPaused(): boolean {
    return this.pauseGate.isPaused()
  }

  /**
   * to be awaited by the drive-mode outer `while` at iteration boundaries. Legacy
   * delegate path doesn't call this today (single `runAgenticLoop` invocation = single step); it
   * will wire in once drive mode owns the while.
   */
  async awaitPauseResume(): Promise<void> {
    await this.pauseGate.awaitResume()
  }

  /**
   * persist the kernel's current state to the configured adapter, if any. Callers
   * typically invoke this from `pause()` + `Terminal` to survive process restart. Returns the
   * persisted blob for observability (undefined when no adapter wired).
   *
   * P0-1 — when `options.throttleMs` is set, the call short-circuits if the
   * previous successful persist happened less than `throttleMs` ago. Callers
   * driving per-inner-iteration auto-checkpoints (see
   * `phases/iteration.ts:runAgenticIteration`) pass `throttleMs: 200` so a
   * burst of 5-15 inner iterations in a single turn does not generate a write
   * per millisecond. Force-saves (IPC "before quit", Terminal phase) pass no
   * options and always proceed.
   */
  async persist(options?: { throttleMs?: number }): Promise<PersistedKernelState | undefined> {
    if (!this.persistenceAdapter) return undefined
    if (!this.streamConversationId?.trim()) return undefined
    const throttleMs = options?.throttleMs
    if (typeof throttleMs === 'number' && throttleMs > 0) {
      const since = Date.now() - this.lastPersistAt
      if (since < throttleMs) return undefined
    }
    const blob = buildPersistedState({
      conversationId: this.streamConversationId.trim(),
      state: this.state,
      paused: this.pauseGate.isPaused(),
      ...(this.interruptReason ? { interruptReason: this.interruptReason } : {}),
    })
    // P1 (audit §3.1 wire-up) — use the unified retry policy. Disk-write
    // transient failures (antivirus index lock, brief EBUSY on Windows,
    // OneDrive sync churn, sandbox tmp races) are common; one retry with
    // jitter recovers the vast majority. We keep `maxAttempts: 2` (one
    // initial + one retry) rather than the default 3 because force-saves
    // ("before-quit", Terminal phase) need to return quickly — a longer
    // retry chain would block the IPC reply on a stuck filesystem. Throttled
    // mid-iter persists also benefit because the next iteration will retry
    // ~200ms later anyway via the normal call path.
    const persistPolicy = {
      ...DEFAULT_RETRY_POLICY,
      maxAttempts: 2,
      initialIntervalMs: 100,
      maxIntervalMs: 500,
      // Only retry on transient-looking errors. `RetryPolicy.retryOn`
      // already filters out `TypeError`/`SyntaxError`/`RangeError`
      // (programmer errors); on top of that, a disk-write throw is almost
      // always retryable so we accept the default predicate.
    }
    try {
      await withRetry(
        () => Promise.resolve(this.persistenceAdapter!.save(blob)),
        persistPolicy,
      )
      this.lastPersistAt = Date.now()
      return blob
    } catch (e) {
      console.warn('[OrchestrationKernel] persist failed after retries:', e)
      return undefined
    }
  }

  /**
   * seed this kernel's state from a prior persisted blob (shape must match
   * {@link PersistedKernelState}). Caller decides whether to preserve the persisted `paused`
   * flag or resume automatically.
   */
  restoreFrom(blob: PersistedKernelState): void {
    this.state = {
      ...blob.state,
      transcript: cloneTranscript(blob.state.transcript),
      inbox: blob.state.inbox.map((item) => ({ ...item })),
    }
    if (blob.paused) {
      this.pauseGate.pause()
    }
  }

  /**
   * Delegates to `kernelTelemetry.emitPhase` so the FSM event-emit logic
   * lives in one testable free function. The slice closure captures `this`
   * so phase-tag strings and counter snapshots stay accurate even when the
   * helper is invoked from outside the class.
   */
  emitPhase(phase: KernelLoopState['phase']): void {
    emitPhaseFree(this.getSlice(), phase)
  }

  /**
   * Called by the agentic loop (or its stepper) on every inner model-call
   * boundary so telemetry can correlate `P2_Q_*` stage events with the
   * kernel's outer turn counter. Delegates to `kernelTelemetry.bumpInnerIteration`.
   */
  bumpInnerIteration(): number {
    return bumpInnerIterationFree(this.getSlice())
  }

  /** Reset inner counter at the start of a new outer turn. Delegates to `kernelTelemetry.resetInnerIteration`. */
  private resetInnerIteration(): void {
    resetInnerIterationFree(this.getSlice())
  }

  /**
   * Phase modules that need to write `state.phase` AND emit it in lockstep
   * use this helper. Mirrors the legacy two-line pattern in the kernel
   * but routed through `kernelTelemetry.transitionPhase` so the
   * write-then-emit invariant is enforced in one place.
   */
  transitionPhase(phase: KernelLoopState['phase']): void {
    transitionPhaseFree(this.getSlice(), phase)
  }

  /**
   * P0 fix (audit §4.1) — reflect the inner agentic loop's
   * `maxOutputRecoveryCycles` and `consecutiveCompactFailures` counters back
   * into `KernelLoopState` so that `persist()` captures them in the on-disk
   * blob. Without this, restart-recovery always seeds these two counters as 0
   * even when the iteration before the crash had attempted multiple compact
   * or max-output-recovery cycles, defeating the soft caps that exist to
   * stop runaway compact / recovery loops.
   *
   * Called from `phases/iteration.ts` once per inner iteration, immediately
   * before the throttled mid-iter `kernel.persist()`. Counter ownership stays
   * with the inner loop (`agenticLoop/stream.ts`, `agenticLoop/postModel.ts`);
   * this method only mirrors them into kernel state for persistence purposes.
   */
  syncMetaCounters(counters: {
    maxOutputRecoveryCycles: number
    consecutiveCompactFailures: number
  }): void {
    if (
      this.state.maxOutputRecoveryCycles === counters.maxOutputRecoveryCycles &&
      this.state.consecutiveCompactFailures === counters.consecutiveCompactFailures
    ) {
      return
    }
    this.state = {
      ...this.state,
      maxOutputRecoveryCycles: counters.maxOutputRecoveryCycles,
      consecutiveCompactFailures: counters.consecutiveCompactFailures,
    }
  }

  /**
   * Wraps an AppendixA reporter so every stage it emits carries the kernel's current
   * outer/inner turn counters. Also tracks inner iteration progression by listening for the
   * `P2_Q_iteration_open` stage that the agentic loop fires once per model iteration.
   * Delegates to `kernelTelemetry.wrapAppendixAReporterWithIterationTracking`.
   */
  wrapAppendixAReporterWithIterationTracking(
    inner: AppendixAFlowReporter | undefined,
  ): AppendixAFlowReporter | undefined {
    return wrapAppendixAReporterWithIterationTrackingFree(this.getSlice(), inner)
  }

  /**
   * Per-turn primitive: runs PrepareContext (reducer + inbox flush + hooks), then
   * `CallModel`, then `Terminal`. `CallModel` invokes `params.runCallModel` when
   * supplied (drive mode injects `driveInnerLoop` here) or falls back to
   * `runAgenticLoop` when omitted (legacy delegate path). In production this is
   * always reached via `runDriveMainChat`'s outer `for`, so `runCallModel` is set.
   * Establishes phase boundaries and a single pre-loop mutation path for transcript/inbox.
   *
   * Error invariant : `Terminal` transcript commit and `onSessionEnd` always run even if
   * `runAgenticLoop` throws. On failure we also emit a distinct `Error` orchestration_phase event.
   */
  async runLegacyDelegateMainChat(params: LegacyDelegateRunParams): Promise<void> {
    // Bump outer turn counter + reset inner counter once per call.
    this.state = { ...this.state, iteration: this.state.iteration + 1 }
    this.resetInnerIteration()

    let callModelError: unknown = undefined
    try {
      await this.ports.hooks.onSessionStart?.()
      const rendererSeedPending =
        this.state.transcriptRevision === 0 && this.state.transcript.length === 0
      await runPrepareContextPhase(this, {
        rendererMessages: rendererSeedPending ? params.rendererMessages : [],
      })
      try {
        await runCallModelPhase(this, {
          agenticParams: params.agenticParams,
          agenticCallbacks: params.agenticCallbacks,
          ...(params.runCallModel ? { runCallModel: params.runCallModel } : {}),
        })
      } catch (e) {
        callModelError = e
      }
    } finally {
      // Terminal phase + onSessionEnd are invariant — they fire even when an earlier
      // phase threw. `runTerminalPhase` catches + logs its own errors so that
      // `onSessionEnd` always gets a chance to run.
      await runTerminalPhase(this)
      // P2-3 — force-persist AFTER Terminal so the on-disk blob records
      // `phase: 'Terminal'`, marking this turn as cleanly completed. A genuine
      // mid-turn process crash (OOM / kill) never reaches this line, so its
      // blob keeps the last mid-iteration `phase` ('CallModel' / 'Error') and
      // restart-recovery still inherits the soft-cap counters (audit §4.1).
      // `createKernelForLegacyMainChat` reads this marker to decide whether the
      // next turn should inherit the counters (crash) or reset them (clean
      // completion), preventing the counters from leaking across normal turns.
      // `persist()` self-guards (no adapter / no conversationId → no-op) and
      // never throws.
      try {
        await this.persist()
      } catch (e) {
        console.warn('[OrchestrationKernel] post-Terminal persist failed:', e)
      }
      try {
        await this.ports.hooks.onSessionEnd?.()
      } catch (e) {
        console.warn('[OrchestrationKernel] onSessionEnd failed:', e)
      }
    }
    if (callModelError !== undefined) {
      throw callModelError
    }
  }

  /** Plan h2 — enqueue before `runLegacyDelegateMainChat` PrepareContext runs. */
  enqueueInboxItem(item: KernelInboxItem): void {
    this.state = applySessionCommands(this.state, [{ kind: 'EnqueueInbox', item }])
    // Crash-survivable inbox: write the queue to disk on every enqueue so a hard process exit
    // (OOM, power loss) doesn't drop the queued slash command / synthetic text / mailbox draft.
    this.persistInbox()
  }

  /**
   * Remove the first `pending_human_resume` item whose `toolUseId` matches, persist
   * the updated inbox, and return whether anything was consumed. Called by
   * `tryConsumePendingHumanResume` after a HITL-aware tool successfully observes a resume
   * value via {@link findPendingHumanResume}.
   *
   * No-op when nothing matches; safe to call optimistically.
   */
  consumeHumanResume(toolUseId: string): boolean {
    const found = this.state.inbox.some(
      (i) => i.kind === 'pending_human_resume' && i.toolUseId === toolUseId,
    )
    if (!found) return false
    // use the dedicated RemoveInboxItem command instead of the
    // legacy ClearInbox + re-enqueue dance. One reducer pass, O(n) instead of
    // n+1 invocations of `applySessionCommands`, and one disk write instead of
    // n+1 in `persistInbox`.
    this.state = applySessionCommands(this.state, [
      {
        kind: 'RemoveInboxItem',
        predicate: (i) => i.kind === 'pending_human_resume' && i.toolUseId === toolUseId,
      },
    ])
    this.persistInbox()
    return true
  }

  /**
   * Best-effort inbox persistence. No-op when no `streamConversationId` is bound (e.g. unit
   * tests) or when running outside Electron (no userData path).
   *
   * P2-1: when the save fails AND the in-memory inbox contains a HITL
   * `pending_human_resume` item, emit a typed `hitl_persistence_failed`
   * phase event so the renderer can surface a toast — losing a queued
   * user answer is the worst failure mode for durable HITL. Save errors
   * for non-HITL inbox items remain console-warned only because re-issuing
   * synthetic_user_text / slash_command on the next turn is cheap.
   */
  persistInbox(): void {
    const id = this.streamConversationId?.trim()
    if (!id) return
    const result = saveInboxToDisk(id, this.state.inbox)
    if (result.ok) {
      // Audit Bug-4 fix — a successful save clears the dedup window so a
      // NEW failure later (different time, possibly different cause) is
      // surfaced rather than suppressed by a stale match.
      this.lastHitlFailureEmit = null
      return
    }
    if (result.reason === 'no_user_data_path') return // expected outside Electron
    // Count the at-risk HITL items so the renderer can size the warning.
    const pendingHumanResumeCount = this.state.inbox.filter(
      (i) => i.kind === 'pending_human_resume',
    ).length
    if (pendingHumanResumeCount === 0) return // no user-visible loss
    // Audit Bug-4 fix — throttle: a burst of enqueueInboxItem calls on a
    // full disk shouldn't spam the renderer with 5 identical toasts. The
    // key is `<reason>` (NOT the count) because the count fluctuates as
    // items are added/drained but the underlying disk failure is the same
    // single user-actionable error. A different reason (or a successful
    // intervening save that cleared `lastHitlFailureEmit`) re-emits.
    const key = result.reason
    const now = Date.now()
    if (
      this.lastHitlFailureEmit &&
      this.lastHitlFailureEmit.key === key &&
      now - this.lastHitlFailureEmit.at < this.hitlFailureEmitWindowMs
    ) {
      return
    }
    this.lastHitlFailureEmit = { key, at: now }
    try {
      emitPhaseEvent(
        this.ports.transport,
        buildHitlFailedPhase({
          iteration: this.state.iteration,
          innerIteration: this.state.innerIteration,
          conversationId: this.streamConversationId,
          hitlPersistenceFailed: {
            reason: result.reason,
            error: result.error,
            pendingHumanResumeCount,
          },
        }),
      )
    } catch (e) {
      console.warn('[OrchestrationKernel] hitl_persistence_failed emit threw:', e)
    }
  }

  /**
   * Drive-mode entry — the production main-chat path since the F1 cleanup removed the
   * `POLE_ORCHESTRATION_KERNEL_DRIVE` opt-out.
   *
   * Kernel owns both loops:
   *   - Outer turn loop (this method) — one iteration per user prompt; PrepareContext /
   *     CallModel / Terminal phases are dispatched by `runLegacyDelegateMainChat`
   *     (still used internally as the per-turn primitive).
   *   - Inner iteration loop — `phases/driveInnerLoop.ts` provides the kernel-owned
   *     `while` with pause/abort/snapshot at each boundary, wrapped here as the
   *     `runCallModel` override.
   */
  async runDriveMainChat(params: LegacyDelegateRunParams): Promise<void> {
    // Outer counter was 256 (safety upper bound). In practice the outer `for`
    // terminates after a single iteration in 99% of turns because `state.inbox`
    // is empty after `flushInboxToTranscript` in PrepareContext. The only
    // legitimate case for >1 outer iteration is mid-turn inbox injection (slash
    // command / mailbox draft / synthetic user text arriving while
    // `runLegacyDelegateMainChat` was executing). The default (16) is a
    // realistic upper bound; anything higher signals a pathological inbox
    // producer and should fail loudly rather than spin indefinitely.
    //
    // Audit fix L-1 — resolved per call from `getMaxOuterIterations()` so
    // operators can tune it via `POLE_ORCHESTRATION_MAX_OUTER_ITERATIONS`.
    const maxOuterIterations = getMaxOuterIterations()

    // 阶段 3 — capture the most recent turn's typed outcome so the outer loop's
    // Conductor block can read the termination reason. Composes (does not
    // replace) any caller-supplied `onTerminate` so the sub-agent retry capture
    // still fires.
    let lastOutcome: AgenticLoopResult | undefined
    const captureOutcome = (r: AgenticLoopResult): void => {
      lastOutcome = r
    }

    const driveParams: LegacyDelegateRunParams = {
      ...params,
      runCallModel: (agenticParams, callbacks) =>
        driveInnerLoop(agenticParams, callbacks, {
          abortSignal: this.abortController.signal,
          pauseGate: this.pauseGate,
          snapshot: (tag) => {
            this.snapshot(tag)
          },
          // 阶段 2/3 — capture the typed AgenticLoopResult (termination reason +
          // transition) for the Conductor and for any caller-supplied onTerminate.
          onTerminate: captureOutcome,
          // 阶段 1 — inject the typed kernel-loop port so the inner iteration's
          // mid-iteration persistence routes through this contract instead of
          // the global `getOrchestrationKernelForConversation` service-locator.
          // Folds the former two-step `syncMetaCounters` + throttled `persist`
          // the inner loop used to call on the looked-up kernel. Best-effort:
          // both calls self-guard and never throw.
          kernelLoopPort: {
            persistThrottled: (counters) => {
              try {
                this.syncMetaCounters(counters)
              } catch (e) {
                console.warn('[OrchestrationKernel] kernelLoopPort.syncMetaCounters threw:', e)
              }
              void this.persist({ throttleMs: 200 }).catch((e) => {
                console.warn('[OrchestrationKernel] kernelLoopPort mid-iter persist threw:', e)
              })
            },
          },
          // Contract audit (2026-07) — per-iteration transcript invariant
          // tracer. At every inner-iteration boundary compare the loop-side
          // transcript length against the kernel transcript; a mismatch means
          // a producer mutated `apiMessages` without `syncConversation` (the
          // exact drift the Terminal-commit check catches too late to
          // attribute). Emits one `transcript_drift` event per distinct delta
          // (deduped so a persistent off-by-N doesn't emit every iteration).
          // Strict mode (`POLE_TRANSCRIPT_INVARIANT_STRICT=1`) turns the
          // drift into a throw → CallModel Error phase → the turn fails
          // loudly instead of committing questionable state.
          assertTranscriptInvariant: (() => {
            let lastReportedIdentity: string | null = null
            return ({ iteration, loopTranscriptLength, loopTranscriptFingerprint }: {
              iteration: number
              loopTranscriptLength: number
              loopTranscriptFingerprint: string
            }): Array<Record<string, unknown>> | undefined => {
              const kernelLen = this.state.transcript.length
              const delta = loopTranscriptLength - kernelLen
              const fingerprintMatches =
                loopTranscriptFingerprint === this.state.transcriptFingerprint
              if (delta === 0 && fingerprintMatches) {
                lastReportedIdentity = null
                return
              }
              const identity =
                `${delta}:${loopTranscriptFingerprint}:${this.state.transcriptFingerprint}`
              if (identity !== lastReportedIdentity) {
                lastReportedIdentity = identity
                console.warn(
                  `[OrchestrationKernel] transcript invariant violated at iteration ${iteration} boundary: ` +
                    `loop=${loopTranscriptLength} kernel=${kernelLen} (delta=${delta}); ` +
                    'a producer mutated apiMessages without syncConversation.',
                )
                emitPhaseEvent(
                  this.ports.transport,
                  buildTranscriptDriftPhase({
                    iteration: this.state.iteration,
                    innerIteration: iteration,
                    conversationId: this.streamConversationId,
                    transcriptDrift: {
                      agentContextLength: loopTranscriptLength,
                      kernelTranscriptLength: kernelLen,
                      agentContextFingerprintPrefix: loopTranscriptFingerprint.slice(0, 12),
                      kernelFingerprintPrefix: this.state.transcriptFingerprint.slice(0, 12),
                      resolvedWith: 'kernel',
                      checkpoint: 'iteration_boundary',
                    },
                  }),
                )
              }
              if (process.env.POLE_TRANSCRIPT_INVARIANT_STRICT === '1') {
                throw new Error(
                  `Transcript invariant violated (strict mode): loop=${loopTranscriptLength} ` +
                    `kernel=${kernelLen} at inner iteration ${iteration}`,
                )
              }
              return cloneTranscript(this.state.transcript)
            }
          })(),
        }),
    }

    // Audit P2-1 — telemetry: count outer iterations actually executed and
    // classify the exit reason. Emitted once on loop exit via the typed
    // `outer_loop_complete` phase event so dashboards can plot the
    // distribution + alarm on overflow.
    let outerIterationsExecuted = 0
    let exitReason: 'completed' | 'aborted' | 'overflow' | 'error' = 'completed'
    // 阶段 3 — bound how many times the Conductor may auto-re-dispatch a turn
    // on an unaddressed verification FAIL, so a model that cannot fix the
    // failure can't burn the whole outer budget. Small + independent of the
    // inbox-drain path.
    let conductorRedispatches = 0
    const maxConductorRedispatches = 2

    try {
      let lastIterDidWork = false
      for (let outerIter = 0; outerIter < maxOuterIterations; outerIter++) {
        if (this.abortController.signal.aborted) {
          exitReason = 'aborted'
          break
        }
        await this.awaitPauseResume()
        if (this.abortController.signal.aborted) {
          exitReason = 'aborted'
          break
        }
        await this.runLegacyDelegateMainChat(driveParams)
        outerIterationsExecuted++
        lastIterDidWork = true
        // After Terminal, check whether the kernel was paused mid-turn
        // and wait before beginning the next turn.
        if (this.pauseGate.isPaused()) {
          await this.awaitPauseResume()
        }
        // 阶段 3 — Conductor: act autonomously on the EXISTING verification-gate
        // signal. When enabled and within the re-dispatch cap, an unaddressed
        // `FAIL` at a clean turn end triggers either a best-of-N exploration
        // (when a port is wired) or a plain re-dispatch (so the model meets the
        // gate's FAIL directive again, optionally after rewinding to the last
        // boundary snapshot). Default OFF → zero impact on production main chat.
        if (
          isConductorEnabled() &&
          conductorRedispatches < maxConductorRedispatches &&
          !this.abortController.signal.aborted
        ) {
          const convId = this.streamConversationId?.trim()
          const action = decideConductorAction({
            enabled: true,
            budgetRemaining: outerIter < maxOuterIterations - 1,
            gate: convId ? getVerificationGateState(convId) : undefined,
            outcomeReason: lastOutcome?.terminationResult?.reason,
            bestOfNAvailable: !!params.conductorBestOfNPort,
          })
          if (action.kind === 'rewind') {
            conductorRedispatches++
            // Best-effort rewind to the latest boundary snapshot; even when no
            // checkpoint is available the re-dispatch (continue) gives the model
            // another turn against the gate's FAIL directive.
            try {
              const head = this.getCheckpointPort()?.getBranchHead()
              if (head) this.rewind(head)
            } catch (e) {
              console.warn('[OrchestrationKernel] conductor rewind threw:', e)
            }
            continue
          }
          if (action.kind === 'best_of_n' && params.conductorBestOfNPort) {
            conductorRedispatches++
            let bestOfNFailed = false
            try {
              await params.conductorBestOfNPort.run({
                task: extractLastUserTask(this.state.transcript),
                signal: this.abortController.signal,
              })
            } catch (e) {
              bestOfNFailed = true
              console.warn('[OrchestrationKernel] conductor best-of-n threw:', e)
            }
            // best-of-N attempted — finish either way (the user inspects the
            // integrated change), but do NOT classify a throw as a clean
            // completion: a failed verification-fix exploration previously
            // exited with `exitReason: 'completed'`, making "修复失败" look
            // like a normal turn end in `outer_loop_complete` telemetry and
            // in the renderer. Tag it 'error' so dashboards + the toast strip
            // see the truth.
            exitReason = bestOfNFailed ? 'error' : 'completed'
            break
          }
        }
        // Inbox-drain mode: if there are *drainable* buffered items,
        // continue immediately rather than waiting for a new renderer
        // message.
        //
        // P0 fix (audit §4.2): `pending_human_resume` items are NOT drained
        // by `flushInboxToTranscript` (they're retained for the HITL-aware
        // tool to consume by toolUseId). If the model that just ran did not
        // call AskUserQuestion this turn — e.g. because it answered the
        // user's question in plain text instead — the HITL item stays in
        // the inbox forever and the old `inbox.length === 0` break would
        // burn all `maxOuterIterations` (16) doing nothing useful before
        // overflowing. The fix is to filter HITL items out of the drainable
        // check; they're consumed (or aged out by the next user turn) on a
        // different path.
        const drainable = this.state.inbox.filter(
          (i) => i.kind !== 'pending_human_resume',
        )
        if (drainable.length === 0) {
          exitReason = 'completed'
          lastIterDidWork = false
          break
        }
      }
      // Loop exited the `for` head without `break`: we hit the cap with
      // drainable inbox items still pending. This is the pathological-producer
      // case the original comment warned about.
      const drainableRemaining = this.state.inbox.filter(
        (i) => i.kind !== 'pending_human_resume',
      ).length
      if (lastIterDidWork && drainableRemaining > 0) {
        exitReason = 'overflow'
        getToolRuntimeMetrics().recordOuterLoopOverflow() // L-2
        console.warn(
          `[OrchestrationKernel] runDriveMainChat hit maxOuterIterations=${maxOuterIterations} ` +
            `with drainable inbox.length=${drainableRemaining} ` +
            `(total=${this.state.inbox.length}); ` +
            `conversationId=${this.streamConversationId ?? '<unset>'}`,
        )
      }
    } catch (e) {
      // Audit fix (2026-06) — a throw out of `runLegacyDelegateMainChat`
      // previously left exitReason at its 'completed' initial value, so the
      // `outer_loop_complete` telemetry classified a failed turn as a clean
      // completion. Tag it 'error' and rethrow; the caller still owns
      // user-facing error handling.
      exitReason = 'error'
      throw e
    } finally {
      this.emitOuterLoopComplete({
        iterations: outerIterationsExecuted,
        exitReason,
        maxOuterIterations,
        ...(lastOutcome?.terminationResult.reason
          ? { terminationReason: lastOutcome.terminationResult.reason }
          : {}),
      })
      if (lastOutcome) {
        try {
          params.onTerminate?.(lastOutcome)
        } catch (e) {
          console.warn('[OrchestrationKernel] onTerminate hook threw:', e)
        }
      }
    }
  }

  /**
   * Audit P2-1 — fire-and-forget outer-loop telemetry. Lives on the kernel
   * (not on a phase module) because the data is owned by the outer FSM, and
   * the emit must run on every exit path including aborts — keeping the
   * emit site inside `runDriveMainChat`'s `finally` is the only way to
   * guarantee that.
   *
   * Reads `this.state.inbox.length` at emit time (post-loop) so the renderer
   * sees the *actual remaining inbox* the loop gave up on, not a snapshot
   * from earlier.
   */
  private emitOuterLoopComplete(input: {
    iterations: number
    exitReason: 'completed' | 'aborted' | 'overflow' | 'error'
    maxOuterIterations: number
    terminationReason?: import('../ai/queryTermination').TerminationReason
  }): void {
    try {
      // Audit P2 §6.3 demo wire-up — built via the strict
      // `buildOuterLoopPhase` builder so the typed `outerLoopStats` field
      // is enforced (vs the legacy loose shape which would have allowed
      // wrong fields paired with this phase tag). Same wire-format
      // output as the old literal; same `emitPhaseEvent` consumer.
      emitPhaseEvent(
        this.ports.transport,
        buildOuterLoopPhase({
          iteration: this.state.iteration,
          innerIteration: this.state.innerIteration,
          conversationId: this.streamConversationId,
          outerLoopStats: {
            iterations: input.iterations,
            overflowed: input.exitReason === 'overflow',
            exitReason: input.exitReason,
            inboxRemaining: this.state.inbox.length,
            maxOuterIterations: input.maxOuterIterations,
            ...(input.terminationReason ? { terminationReason: input.terminationReason } : {}),
          },
        }),
      )
    } catch (e) {
      // Telemetry must never bubble into the kernel hot path.
      console.warn('[OrchestrationKernel] emitOuterLoopComplete failed:', e)
    }
  }

  /** Atomically consume visible inbox entries and return the accepted Kernel snapshot. */
  drainInboxForInnerIteration():
    | { injected: false }
    | { injected: true; snapshot: TranscriptSnapshot } {
    const drained = drainInboxToTranscript(this.state)
    this.state = drained.state
    this.persistInbox()
    return drained.snapshot
      ? { injected: true, snapshot: drained.snapshot }
      : { injected: false }
  }
}

export function buildOrchestrationPortsForLegacyMainChat(
  emitStream: (ev: StreamEvent) => void,
  skillSession?: { get: () => InlineSkillSessionState; set: (s: InlineSkillSessionState) => void },
  options?: {
    permissionRules?: import('../ai/permissionRuleMatch').PermissionRulePayload[]
    permissionDefaultMode?: 'allow' | 'ask' | 'deny'
    /**
     * Chat mode getter. When supplied, the PermissionPort evaluates plan/ask mode
     * denial alongside workspace permission rules — both happen in a single
     * `PolicyEngine.evaluate` call now that Chunk 6 has collapsed the layered ports.
     */
    getChatMode?: () => ChatMode
  },
): OrchestrationPorts {
  const skill = skillSession ?? {
    get: (): InlineSkillSessionState => null,
    set: () => {},
  }
  // Chunk 6 — single PolicyEngine-backed PermissionPort. Evaluates chat mode,
  // workspace permission rules, agent allowlist/denylist, global rules, resource
  // quota admission, and cross-agent repeat-failure history in one call.
  // Replaces the previous three-layer decorator stack
  // (createRulePermissionPort → createChatModePermissionPort → createPolicyEnginePermissionPort)
  // and the two flags that gated it (POLE_ORCHESTRATION_CHATMODE,
  // POLE_ORCHESTRATION_POLICY_ENGINE).
  const transport = createTransportAdapter(emitStream)
  const permission: import('./ports').PermissionPort = {
    ...noopPermission,
    ...createPolicyEnginePermissionPort({
      engine: getPolicyEngine(),
      resolveContext: () => ({
        agentId: asAgentId('main'),
        ...(options?.getChatMode ? { chatMode: options.getChatMode() } : {}),
        ...(options?.permissionRules ? { permissionRules: options.permissionRules } : {}),
        ...(options?.permissionDefaultMode
          ? { permissionDefaultMode: options.permissionDefaultMode }
          : {}),
      }),
    }),
  }
  return {
    tools: new DefaultToolRuntimePort(skill, { permissionPort: permission, transport }),
    permission,
    session: createNoopMcpSessionAdapter(),
    transport,
    hooks: noopHookPolicy,
  }
}

export function createKernelForLegacyMainChat(
  emitStream: (ev: StreamEvent) => void,
  observer: OrchestrationObserver | undefined,
  rendererMessages: AgenticLoopParams['messages'],
  options?: {
    skillSession?: { get: () => InlineSkillSessionState; set: (s: InlineSkillSessionState) => void }
    streamConversationId?: string
    /** thread permission policy into the kernel's `DefaultToolRuntimePort`. */
    permissionRules?: import('../ai/permissionRuleMatch').PermissionRulePayload[]
    permissionDefaultMode?: 'allow' | 'ask' | 'deny'
    /** supply to enable snapshot/rewind/fork. Omit for legacy behavior. */
    checkpointPort?: CheckpointPort
    /** supply to enable pause/resume durability across restarts. */
    persistenceAdapter?: KernelPersistenceAdapter
    /** supply to opt into chat-mode-aware plan/ask/agent policy. */
    getChatMode?: () => ChatMode
    /** supply to collect artifacts emitted during the turn. */
    artifactPort?: ArtifactPort
    /**
     * Bug A fix — previously-persisted `KernelLoopState` blob for restart
     * recovery. When supplied, the kernel seeds its iteration counters /
     * phase / maxOutputRecoveryCycles / consecutiveCompactFailures from
     * the blob, while `transcript` is still overwritten by `rendererMessages`
     * (renderer is the source-of-truth) and `inbox` still comes from
     * `inboxPersistence` (which is the most-recent live snapshot, written
     * on every enqueue). This avoids the bug where a post-construction
     * `kernel.restoreFrom(blob)` would nuke the freshly-synced renderer
     * messages with stale blob transcript.
     */
    prevPersistedBlob?: PersistedKernelState
  },
): OrchestrationKernel {
  // Bug A fix — seed counter-style metadata from the persisted blob first so
  // subsequent renderer-message sync and inbox persistence layer can override
  // the volatile parts (transcript, inbox) without losing the durable parts
  // (iteration counters, recovery cycle counts).
  const prev = options?.prevPersistedBlob
  // P2-3 — only a blob that was NOT written by a clean Terminal completion
  // represents a genuine mid-turn crash worth resuming the soft-cap counters
  // from. A blob marked `phase: 'Terminal'` (or the initial `'Idle'`) means
  // the previous turn finished normally, so the next turn must start its
  // recovery budgets fresh — otherwise `maxOutputRecoveryCycles` (which has no
  // per-turn reset) and `consecutiveCompactFailures` would monotonically leak
  // across every turn in the conversation and prematurely trip the soft caps.
  // The cumulative `iteration` counter is always inherited (it is a per-prompt
  // turn count, not a per-turn recovery budget).
  const resumedMidTurn =
    !!prev && prev.state.phase !== 'Terminal' && prev.state.phase !== 'Idle'
  const initial = prev
    ? {
        ...normalizeKernelLoopState(prev.state),
        inbox: [],
        maxOutputRecoveryCycles: resumedMidTurn ? prev.state.maxOutputRecoveryCycles : 0,
        consecutiveCompactFailures: resumedMidTurn ? prev.state.consecutiveCompactFailures : 0,
      }
    : createInitialKernelLoopState([])
  // A mid-turn restart keeps the last committed Kernel snapshot. A clean
  // Terminal/Idle blob means this is a new renderer request, so seed that new
  // request exactly once and advance the existing monotonic revision.
  let seed = resumedMidTurn
    ? initial
    : applySessionCommands(initial, [
        { kind: 'SyncTranscriptFromRenderer', messages: rendererMessages },
      ])
  // Crash-recovery: re-hydrate any inbox items that were persisted by a previous run of this
  // conversation but never drained (e.g. process killed before PrepareContext ran). Items are
  // restored to the head of the queue so they're processed before any new ones.
  //
  // Bug A fix — `inboxPersistence` (file at `<userData>/orchestration-inbox/<id>.json`,
  // written on every enqueue) is the freshest snapshot of inbox. The
  // `PersistedKernelState` blob's `inbox` is intentionally ignored here in
  // favor of `inboxPersistence`, because the blob is only written by explicit
  // `kernel.persist()` calls and may be much older than the live inbox.
  const convId = options?.streamConversationId?.trim()
  if (convId) {
    const recovered = loadInboxFromDisk(convId)
    if (recovered && recovered.length > 0) {
      const enqueueCommands = recovered.map(
        (item) => ({ kind: 'EnqueueInbox', item } as const),
      )
      seed = applySessionCommands(seed, enqueueCommands)
    }
  }
  const ports = buildOrchestrationPortsForLegacyMainChat(emitStream, options?.skillSession, {
    ...(options?.permissionRules ? { permissionRules: options.permissionRules } : {}),
    ...(options?.permissionDefaultMode
      ? { permissionDefaultMode: options.permissionDefaultMode }
      : {}),
    ...(options?.getChatMode ? { getChatMode: options.getChatMode } : {}),
  })
  // Auto-enable an in-memory checkpoint port unless the caller supplied one explicitly.
  // Callers that want durable storage can pass a custom port via options.checkpointPort.
  const checkpointPort = options?.checkpointPort ?? createInMemoryCheckpointPort()
  const kernel = new OrchestrationKernel(
    ports,
    observer,
    seed,
    options?.streamConversationId?.trim() || undefined,
    {
      ...(checkpointPort ? { checkpointPort } : {}),
      ...(options?.persistenceAdapter ? { persistenceAdapter: options.persistenceAdapter } : {}),
      ...(options?.artifactPort ? { artifactPort: options.artifactPort } : {}),
    },
  )
  // Fire a one-shot `Idle` phase signalling "kernel constructed, no work
  // yet" before any phase has had a chance to flip `state.phase`. Renderer
  // subscribers that want a "ready for first turn" cue can observe this;
  // they remain free to ignore it. The next emission is `PrepareContext`
  // from the first `runDriveMainChat` / `runLegacyDelegateMainChat` call.
  try {
    kernel.emitPhase('Idle')
  } catch (e) {
    console.warn('[OrchestrationKernel] Idle phase emit failed:', e)
  }
  return kernel
}

