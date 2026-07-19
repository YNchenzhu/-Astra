/**
 * Effect ports — kernel depends only on these interfaces.
 *
 * Active ports wired on the kernel hot path:
 *   - {@link ToolRuntimePort}  — `DefaultToolRuntimePort` (tool batch execution + preflight).
 *   - {@link TransportPort}    — `createTransportAdapter` (stream events + interrupts + artifact manifest).
 *   - {@link HookPolicyPort}   — stop / session / prompt_submit hooks.
 *   - {@link SessionStorePort} — `onTranscriptCommitted` at Terminal phase.
 *   - {@link PermissionPort}   — `createPolicyEnginePermissionPort` preflight (single PEP since Chunk 6).
 *
 * `ModelPort` used to live here as a "future migration target" — removed in Chunk 3 because
 * `runAgenticLoop` calls `streamText` directly and the adapter had no production consumer.
 * If a future need for record/replay or alternate providers arises, reintroduce the port at
 * that point with a real caller, not as speculative scaffolding.
 */

import type { PermissionRulePayload } from '../ai/permissionRuleMatch'
import type { TerminationReason } from '../ai/queryTermination'
import type { KernelLoopState } from './kernelTypes'
import type { TranscriptCommitSource } from './kernelTypes'
import type { StreamEvent } from '../ai/streamHandler'
import type { InlineSkillSessionState } from '../ai/runAgenticToolUse'
import type { AgenticToolBatchCallbacks } from '../ai/agenticToolBatch'

export type ToolUseCall = {
  id: string
  name: string
  input: Record<string, unknown>
  thoughtSignature?: string
}

export type ToolBatchOutcome = {
  toolResultBlocks: Array<Record<string, unknown>>
  /** True if any tool reported failure */
  hadFailure: boolean
}

export interface ToolRuntimePort {
  executeToolBatch(params: {
    state: KernelLoopState
    toolUses: ToolUseCall[]
    signal: AbortSignal
    diffPermissionMode: 'default' | 'bypassPermissions'
    permissionDefaultMode: 'allow' | 'ask' | 'deny'
    permissionRules?: PermissionRulePayload[]
    discoveryExclude: Set<string>
    /**
     * When the agentic loop owns inline Skill session state, pass through so {@link runAgenticToolUseBatch}
     * matches the non-orchestrated path (orchestrated main chat).
     */
    inlineSkillSession?: {
      get: () => InlineSkillSessionState
      set: (s: InlineSkillSessionState) => void
    }
    /** Forward tool start/result to UI / telemetry (same as {@link runAgenticToolUseBatch} callbacks). */
    toolCallbacks?: AgenticToolBatchCallbacks
    /** Optional: record each tool name before execution (e.g. {@link PermissionPort.noteToolInvocation}). */
    noteToolInvocation?: (toolName: string) => void
    /**
     * P0-2 — per-tool signal resolver. The orchestration kernel passes a closure that
     * maps each tool name + input to either its soft signal (for `interruptBehavior:
     * 'cancel'`, the default) or its hard signal (for `'block'` tools — long-running
     * rsync / remote polls / DB migrations). The `input` is passed so tools whose
     * interruptBehavior depends on arguments (e.g. bash with a long `timeoutMs`)
     * can decide per-invocation. When omitted, every tool inherits the batch-wide
     * `signal` (legacy behaviour).
     */
    resolveToolSignal?: (
      toolName: string,
      input: Record<string, unknown>,
      /**
       * P1 (audit §5.2) — optional toolUseId so the adapter can merge a
       * per-tool preempt signal from `ToolRuntimeState`. Resolvers that
       * only care about cancel/block lanes can ignore the third arg.
       */
      toolUseId?: string,
    ) => AbortSignal | undefined
  }): Promise<ToolBatchOutcome>
}

export type PermissionRequest = {
  toolName: string
  toolUseId: string
  /** Serialized prompt for UI */
  summary: string
}

/**
 * pre-flight decision produced by {@link PermissionPort.preflight}. When `decision`
 * is `deny`, the runtime must **not** invoke the tool; instead it synthesizes a failure
 * `tool_result` block using `reason` so the assistant message stays well-formed.
 */
export type PermissionPreflightResult = {
  decision: 'allow' | 'deny'
  reason?: string
  /** Optional matched rule id / pattern for telemetry + UI. */
  matchedRule?: string
}

export type PermissionPreflightRequest = {
  toolName: string
  toolUseId: string
  toolInput: Record<string, unknown>
}

export interface PermissionPort {
  /**
   * @deprecated Prefer {@link PermissionPort.preflight} . Kept for callers that only
   * need a passive "count invocations" hook.
   */
  noteToolInvocation?(toolName: string): void
  /**
   * synchronous or async pre-flight gate called by the runtime before executing each
   * pending `tool_use`. Returning `{ decision: 'deny' }` causes the runtime to emit a failure
   * tool_result block and skip actual execution. Returning `{ decision: 'allow' }` (or returning
   * `undefined`) lets execution proceed. Implementations SHOULD be fast (no UI prompts); blocking
   * UI-driven permission asks still live inside `runAgenticToolUse`.
   */
  preflight?(
    req: PermissionPreflightRequest,
  ):
    | PermissionPreflightResult
    | undefined
    | Promise<PermissionPreflightResult | undefined>
}

export interface SessionStorePort {
  /** MCP / persistence hooks live here — kernel never imports MCP directly (plan h1). */
  onTranscriptCommitted?(snapshot: Array<Record<string, unknown>>): Promise<void> | void
}

/**
 * typed payload for `orchestration_phase` stream events.
 *
 * Background: the kernel and `DefaultToolRuntimePort` together emit ~7 different shapes that all
 * ride the single `orchestration_phase` stream type (PrepareContext/CallModel/Terminal/Error,
 * `interrupt`, `rewound`, `paused`, `resumed`, `artifact_manifest`, `permission_denied_preflight`).
 * Each callsite duplicated the conversationId-trim ternary + counter wiring. This struct lets
 * callers declare *intent* once; the transport adapter handles the StreamEvent shape.
 *
 * # Type discipline (audit P2 §6.3)
 *
 * The shape below is intentionally LOOSE: `phase: string` + all field bags optional. Many
 * producers were written before the wire schema stabilised and rely on this looseness to
 * add new tags incrementally.
 *
 * NEW producers should construct payloads via {@link OrchestrationPhasePayloadVariant} (the
 * strict discriminated union also exported from this module) and the per-variant builders
 * in `transport.ts` — `buildKernelFsmPhase`, `buildInterruptPhase`, `buildPreemptionPhase`,
 * etc. The builders return a value assignable to BOTH `OrchestrationPhasePayload` (legacy)
 * AND `OrchestrationPhasePayloadVariant` (strict), so opting in is incremental and
 * non-breaking.
 *
 * Renderer routing: see `electron/orchestration/STREAM_SINKS.md` for which renderer modules
 * consume which phase tags.
 */
export type OrchestrationPhasePayload = {
  /**
   * Phase tag. Values come from {@link KernelTurnPhase} OR one of the lifecycle/admin tags
   * (`interrupt` / `rewound` / `paused` / `resumed` / `artifact_manifest` /
   * `permission_denied_preflight`). Kept as `string` for forward-compat with future tags.
   */
  phase: string
  iteration: number
  innerIteration?: number
  /** Renderer multi-tab routing key (set when the kernel owns one). */
  conversationId?: string
  /** Set when `phase === 'interrupt'`. */
  interruptReason?: string
  /** Set when `phase === 'artifact_manifest'`. */
  artifactManifest?: {
    turn: number
    entries: Array<{
      id: string
      kind: string
      label?: string
      producer: string
      producerTurn?: number
      producerInnerTurn?: number
      payload: Record<string, unknown>
      at: number
    }>
  }
  /** Set when `phase === 'permission_denied_preflight'`. */
  permissionDenial?: {
    toolName: string
    toolUseId: string
    reason: string
    matchedRule?: string
  }
  /**
   * Bug B fix — set when `phase === 'interrupt'` AND `interruptReason === 'hitl'`.
   *
   * Carries the HITL pause payload (toolUseId / question / kind) so the renderer
   * can show a "可重启续接" badge on the AskUserQuestion dialog when the kernel
   * has persisted state to disk and the answer will resume the right turn even
   * after a process restart.
   *
   * Previously this was injected as a free-form `_hitl` field via a typecast in
   * `toolExec.ts`, but `buildPhaseStreamEvent` doesn't spread unknown fields so
   * the payload was silently dropped before reaching the renderer.
   */
  hitlPending?: {
    toolUseId: string
    question: unknown
    kind: 'ask_user_question' | 'permission_ask'
  }
  /**
   * Audit P2-2 — set when `phase === 'transcript_clone_degraded'`.
   *
   * Emitted by `setupAgenticLoopForRun`'s `syncConversation` when
   * `cloneApiMessagesForOrchestration`'s ladder degrades:
   *
   *   - `mode: 'json'` — `structuredClone` (preferred) threw on an
   *     unclonable value; the JSON round-trip fallback still produced a
   *     real deep copy (with JSON-incompatible fields dropped — acceptable
   *     for message arrays). The kernel keeps its own copy; no reference
   *     sharing.
   *   - `mode: 'frozen-shared'` — BOTH strategies failed. The loop
   *     survives by returning an `Object.freeze`-d shared reference, which
   *     prevents accidental cross-side mutation but does not give the
   *     kernel its own copy. Operators investigating "kernel transcript
   *     drifted from AgentContext.messages" should look for this event in
   *     the turn's preceding history.
   *
   * Audit SA-6 — degradation is no longer a fire-once signal: the helper
   * counts every occurrence per mode (see `occurrenceCount`) and emits a
   * counted console warning each time, so a transcript that fails to
   * clone on every sync is distinguishable from a one-off failure.
   */
  transcriptCloneDegraded?: {
    /** Which fallback layer is in effect after the failure(s). */
    mode: 'json' | 'frozen-shared'
    /** Stringified primary error (structuredClone or JSON throw). */
    error: string
    /** Stringified secondary error when `mode === 'frozen-shared'`. */
    secondaryError?: string
    /** Number of messages in the transcript at the time of failure. */
    messageCount: number
    /**
     * Audit SA-6 — process-lifetime running count of degradations in this
     * `mode` (including this one), forwarded from the clone helper's
     * counter when the producer supplies it.
     */
    occurrenceCount?: number
  }
  /**
   * P2-1 — set when `phase === 'hitl_persistence_failed'`.
   *
   * Emitted by `OrchestrationKernel.persistInbox()` when a save attempt
   * failed AND the in-memory inbox contained at least one
   * `pending_human_resume` HITL item. Renderer surfaces this as a toast
   * ("Your answer wasn't saved to disk — please re-submit") so the user
   * doesn't silently lose their AskUserQuestion answer if the process
   * crashes between now and the next inbox drain.
   *
   * `reason` mirrors `SaveInboxResult.reason` from `inboxPersistence.ts`:
   *   - `'disk_error'`     — disk write threw (full disk, permissions,
   *                          antivirus interference). `error` carries the
   *                          underlying message.
   *   - `'cleanup_failed'` — stale file delete failed but the inbox was
   *                          empty so no items lost (informational only).
   *
   * `pendingHumanResumeCount` is the number of HITL items at risk so the
   * renderer can size the warning ("1 answer at risk" vs "3 answers at
   * risk" UX).
   */
  hitlPersistenceFailed?: {
    reason: 'disk_error' | 'cleanup_failed'
    error: string
    pendingHumanResumeCount: number
  }
  /**
   * Audit P2-1 — set when `phase === 'outer_loop_complete'`.
   *
   * Atomic per-turn snapshot of the kernel's outer-iteration FSM
   * (`runDriveMainChat`). One event fires when the outer `for` loop exits,
   * regardless of why (normal completion, mid-turn abort, or overflow).
   *
   * Why this exists: the audit found that the outer counter ceiling (16)
   * was a safety cap with no telemetry on how often real turns approach
   * or hit it. Without `outerLoopStats` an operator investigating
   * "inbox not draining" or "synthetic user text dropped" had no signal
   * other than parsing console logs. The renderer / dashboards can
   * subscribe to this single event to:
   *
   *   - Plot `iterations` distribution to confirm the "1 in 99%" claim.
   *   - Alarm on `overflowed: true` (pathological inbox producer).
   *   - Show the operator how many mailbox drafts / synthetic user texts
   *     were drained during the turn.
   */
  outerLoopStats?: {
    /** Number of outer iterations actually executed in this turn (≥0). */
    iterations: number
    /** True iff the loop hit `maxOuterIterations` without inbox draining. */
    overflowed: boolean
    /** Why the loop exited. `'error'` = an exception escaped the outer loop. */
    exitReason: 'completed' | 'aborted' | 'overflow' | 'error'
    /** Canonical task outcome from AgenticLoopResult; independent of mechanical exitReason. */
    terminationReason?: TerminationReason
    /** Inbox size at exit (non-zero only for `'overflow'`). */
    inboxRemaining: number
    /** Cap that was in effect for this turn (lets dashboards normalize over future bumps). */
    maxOuterIterations: number
  }
  /**
   * Contract audit (2026-07) — set when `phase === 'transcript_drift'`.
   *
   * Emitted by the Terminal phase when `AgentContext.messages` and the kernel
   * transcript disagree on content identity at commit time. Previously this
   * was a console.warn only — invisible to the renderer and to anyone
   * auditing rewind/recovery behaviour. One event per divergent Terminal.
   */
  transcriptDrift?: {
    /** Length of the loop-side transcript (AgentContext / apiMessages). */
    agentContextLength: number
    /** Length of the kernel transcript at check time. */
    kernelTranscriptLength: number
    /** Hash prefixes allow content drift diagnosis without emitting transcript text. */
    agentContextFingerprintPrefix?: string
    kernelFingerprintPrefix?: string
    /** Which side stays authoritative after the check. */
    resolvedWith: 'agent_context' | 'kernel'
    /**
     * Where the invariant was evaluated: at the Terminal commit (turn end)
     * or at an inner-iteration boundary (the per-iteration tracer wired by
     * `runDriveMainChat` → `driveInnerLoop.assertTranscriptInvariant`).
     */
    checkpoint?: 'terminal_commit' | 'iteration_boundary'
  }
  /** CAS rejection metadata. Never contains transcript text. */
  transcriptConflict?: {
    source: TranscriptCommitSource
    expectedRevision: number
    actualRevision: number
    incomingFingerprintPrefix: string
    currentFingerprintPrefix: string
  }
  /**
   * Contract audit (2026-07) — set when `phase === 'scheduler_backpressure'`.
   *
   * Emitted by `DefaultToolRuntimePort.runQuotaAdmitAndPreemptPhase` when a
   * tool actually entered a wait state: either the scheduler-drive cross-agent
   * hold gate (`kind: 'scheduler_hold'`) or the quota backpressure loop
   * (`kind: 'quota_backpressure'`). Previously these waits were visible only
   * as console.log lines + ToolRuntimeState 'blocked' status — the user just
   * saw the turn stall with no cause.
   */
  schedulerBackpressure?: {
    toolName: string
    toolUseId: string
    kind: 'scheduler_hold' | 'quota_backpressure'
    /** Quota / hold reason when known (e.g. 'shell_quota'). */
    reason?: string
    /** For scheduler holds: how long the tool actually held (ms). */
    waitedMs?: number
  }
  /**
   * P1 (audit §5.2 wire-up) — set when `phase === 'tool_preempted'`.
   *
   * Emitted by `DefaultToolRuntimePort.executeToolBatch` when
   * `ResourceQuotaManager.admit` returns a non-empty `preemptionTarget` and
   * the adapter aborts that victim's per-tool signal to free a resource
   * slot for a higher-priority newcomer. Lets the renderer surface a
   * "<tool> was paused so <higher-priority tool> could run" badge instead
   * of silently swallowing the cancellation.
   */
  preemption?: {
    /** toolUseId of the tool that was preempted. */
    victimToolUseId: string
    /** Tool name of the victim (best-effort, looked up from the registry). */
    victimToolName?: string
    /** toolUseId of the newcomer that triggered the preempt. */
    incomingToolUseId: string
    /** Tool name of the newcomer. */
    incomingToolName: string
    /** Resource lane that was contended (`shell` / `network` / `mutation`). */
    resource: 'shell' | 'network' | 'mutation'
    /** Victim's priority at the time of preempt. */
    victimPriority?: number
    /** Newcomer's priority at the time of preempt. */
    incomingPriority: number
  }
}

// ---------------------------------------------------------------------------
// Strict discriminated union (audit P2 §6.3)
//
// Each variant carries ONLY the fields valid for its phase tag. New producers
// should construct payloads via these variants (or the per-variant builders in
// `transport.ts`) so the type checker prevents wrong-field-with-wrong-tag
// regressions. The legacy `OrchestrationPhasePayload` (loose) remains the input
// type for `emitPhaseEvent` so existing producers keep compiling unchanged.
//
// Adding a new phase tag: extend this union with a new variant, then add the
// matching builder in `transport.ts` and forward the new field(s) in
// `buildPhaseStreamEvent` + `electron/ai/streamHandlerTypes.ts`.
// ---------------------------------------------------------------------------

/** Fields every variant shares. */
export interface OrchestrationPhaseCommon {
  iteration: number
  innerIteration?: number
  conversationId?: string
}

/**
 * Kernel FSM lifecycle — every {@link KernelTurnPhase} value (kernel-level
 * coarse phases AND the formerly-deprecated mid-iteration phases that are
 * now emitted by the inner agentic loop: `RunToolBatch` / `ApplyToolResults`
 * / `ResolveStop` / `StopHooksOrContinue` / `Idle`).
 */
export interface OrchestrationPhaseKernelFsm extends OrchestrationPhaseCommon {
  phase:
    | 'Idle'
    | 'PrepareContext'
    | 'CallModel'
    | 'ResolveStop'
    | 'RunToolBatch'
    | 'ApplyToolResults'
    | 'StopHooksOrContinue'
    | 'Terminal'
    | 'Error'
}

/** Admin lifecycle events that don't transition the FSM (pause / resume / rewind). */
export interface OrchestrationPhaseLifecycle extends OrchestrationPhaseCommon {
  phase: 'paused' | 'resumed' | 'rewound'
}

/** User / system interrupt with a typed reason. */
export interface OrchestrationPhaseInterrupt extends OrchestrationPhaseCommon {
  phase: 'interrupt'
  interruptReason: string
  /** Set when `interruptReason === 'hitl'` to carry the HITL pause payload. */
  hitlPending?: NonNullable<OrchestrationPhasePayload['hitlPending']>
}

/** Audit P2-1 — outer-loop telemetry (one event per `runDriveMainChat` exit). */
export interface OrchestrationPhaseOuterLoop extends OrchestrationPhaseCommon {
  phase: 'outer_loop_complete'
  outerLoopStats: NonNullable<OrchestrationPhasePayload['outerLoopStats']>
}

/** Audit P2-1 — HITL persistence-failure toast trigger. */
export interface OrchestrationPhaseHitlFailed extends OrchestrationPhaseCommon {
  phase: 'hitl_persistence_failed'
  hitlPersistenceFailed: NonNullable<OrchestrationPhasePayload['hitlPersistenceFailed']>
}

/** Audit P2-2 — transcript clone degradation signal. */
export interface OrchestrationPhaseTranscriptDegraded extends OrchestrationPhaseCommon {
  phase: 'transcript_clone_degraded'
  transcriptCloneDegraded: NonNullable<OrchestrationPhasePayload['transcriptCloneDegraded']>
}

/** Contract audit (2026-07) — Terminal-commit dual-source content divergence. */
export interface OrchestrationPhaseTranscriptDrift extends OrchestrationPhaseCommon {
  phase: 'transcript_drift'
  transcriptDrift: NonNullable<OrchestrationPhasePayload['transcriptDrift']>
}

export interface OrchestrationPhaseTranscriptConflict extends OrchestrationPhaseCommon {
  phase: 'transcript_conflict'
  transcriptConflict: NonNullable<OrchestrationPhasePayload['transcriptConflict']>
}

/** Terminal-phase consolidated artifact manifest. */
export interface OrchestrationPhaseArtifactManifest extends OrchestrationPhaseCommon {
  phase: 'artifact_manifest'
  artifactManifest: NonNullable<OrchestrationPhasePayload['artifactManifest']>
}

/** PolicyEngine preflight denial — emitted by both port and fallback paths. */
export interface OrchestrationPhasePermissionDenied extends OrchestrationPhaseCommon {
  phase: 'permission_denied_preflight'
  permissionDenial: NonNullable<OrchestrationPhasePayload['permissionDenial']>
}

/** Audit P1 §5.2 — tool was preempted by a higher-priority newcomer. */
export interface OrchestrationPhasePreempted extends OrchestrationPhaseCommon {
  phase: 'tool_preempted'
  preemption: NonNullable<OrchestrationPhasePayload['preemption']>
}

/** Contract audit (2026-07) — tool entered a scheduler hold / quota backpressure wait. */
export interface OrchestrationPhaseSchedulerBackpressure extends OrchestrationPhaseCommon {
  phase: 'scheduler_backpressure'
  schedulerBackpressure: NonNullable<OrchestrationPhasePayload['schedulerBackpressure']>
}

/**
 * Strict discriminated union covering every phase tag the editor actually
 * emits today. Code that wants compile-time discrimination should declare
 * its parameter type as `OrchestrationPhasePayloadVariant` (or use the
 * builders in `transport.ts`); code that needs the legacy loose shape
 * (e.g. forwarding through generic transports) should continue using
 * `OrchestrationPhasePayload`.
 *
 * When adding a new phase tag:
 *   1. Add a new `OrchestrationPhase<Name>` interface above.
 *   2. Add it to this union.
 *   3. Add the corresponding optional field on the legacy
 *      {@link OrchestrationPhasePayload} so callers using the loose shape
 *      keep working (and update the StreamEvent shape in lockstep).
 *   4. Add a builder in `transport.ts` for the strict variant.
 */
export type OrchestrationPhasePayloadVariant =
  | OrchestrationPhaseKernelFsm
  | OrchestrationPhaseLifecycle
  | OrchestrationPhaseInterrupt
  | OrchestrationPhaseOuterLoop
  | OrchestrationPhaseHitlFailed
  | OrchestrationPhaseTranscriptDegraded
  | OrchestrationPhaseTranscriptDrift
  | OrchestrationPhaseTranscriptConflict
  | OrchestrationPhaseArtifactManifest
  | OrchestrationPhasePermissionDenied
  | OrchestrationPhasePreempted
  | OrchestrationPhaseSchedulerBackpressure

export interface TransportPort {
  /**
   * Low-level escape hatch. New code should prefer typed sinks (see {@link emitPhase}).
   * Kept for back-compat with `text_delta` / `tool_start` / `tool_result` / `subagent_*` events
   * that have not been moved off the generic `StreamEvent` union yet.
   */
  emit(event: StreamEvent): void
  /**
   * typed sink for `orchestration_phase` events. Adapter default builds a
   * `StreamEvent` and routes through {@link emit}; callers MAY override to short-circuit.
   *
   * Optional in the interface so legacy inline `{ emit }` mocks keep type-checking; production
   * transports built via `createTransportAdapter` always provide it.
   */
  emitPhase?(payload: OrchestrationPhasePayload): void
}

export interface HookPolicyPort {
  onPromptSubmit?(cwd: string | undefined): Promise<void> | void
  onSessionStart?(): Promise<void> | void
  onSessionEnd?(): Promise<void> | void
}

export type OrchestrationPorts = {
  tools: ToolRuntimePort
  permission: PermissionPort
  session: SessionStorePort
  transport: TransportPort
  hooks: HookPolicyPort
}
