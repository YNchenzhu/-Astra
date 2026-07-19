/**
 * Orchestration **kernel** domain types (query loop FSM) — separate from persisted {@link OrchestrationState}.
 */

/**
 * Explicit phase of the orchestration loop (upstream report §2 analogue).
 *
 * **Emitted phases (audit P2 §6.2 + 2026-05 inner-phase wire-up)**:
 *
 *   Kernel-level (outer FSM, written to `state.phase`):
 *     - `PrepareContext` — emitted by `phases/prepareContext.ts`
 *     - `CallModel`      — emitted by `phases/callModel.ts`
 *     - `Terminal`       — emitted by `phases/terminal.ts`
 *     - `Error`          — emitted by `phases/callModel.ts` catch branch
 *     - `Idle`           — emitted once by `createKernelForLegacyMainChat`
 *                          after construction (kernel ready, no work yet)
 *
 *   Inner-loop-level (mid-iteration sub-phases, NOT written to
 *   `state.phase`; emitted on the `orchestration_phase` stream only so
 *   the renderer's activity timeline can show finer-grained status):
 *     - `RunToolBatch`         — emitted by `agenticLoop/toolExec.ts`
 *                                at the top of `executeToolBatch`
 *     - `ApplyToolResults`     — emitted by `agenticLoop/toolExec.ts`
 *                                after the batch settles + results are
 *                                appended to `apiMessages`
 *     - `ResolveStop`          — emitted by `agenticLoop/noTools.ts`
 *                                at the entry of `handleNoToolsBranch`
 *     - `StopHooksOrContinue`  — emitted by `agenticLoop/noTools.ts`
 *                                immediately before `runStopHooks(...)`
 *
 * Inner phases are advisory — they are informational signals on the
 * renderer event stream, NOT FSM transitions. They do not flip
 * `state.phase` (which stays on `'CallModel'` for the whole turn body).
 * Tests / renderer subscribers may observe any inner phase between a
 * `'CallModel'` enter and the next `'Terminal' | 'Error'` exit.
 */
export type KernelTurnPhase =
  | 'Idle'
  | 'PrepareContext'
  | 'CallModel'
  | 'ResolveStop'
  | 'RunToolBatch'
  | 'ApplyToolResults'
  | 'StopHooksOrContinue'
  | 'Terminal'
  | 'Error'

/** Whether to keep spinning the outer loop after a model turn. */
export type KernelContinueDecision =
  | { kind: 'end'; reason?: string }
  | { kind: 'continue'; reason: string }

/** Kernel-observable stream (profiler / tests). */
export type OrchestrationKernelEvent =
  | { type: 'phase_enter'; phase: KernelTurnPhase; iteration: number }
  | { type: 'phase_exit'; phase: KernelTurnPhase; iteration: number; durationMs: number }
  | { type: 'command_applied'; commandKind: string }
  | { type: 'note'; message: string }

/**
 * `source` value marking a `synthetic_user_text` inbox item as REAL human
 * input (typed by the user mid-turn), as opposed to host/kernel-synthesised
 * text. The mid-turn drain (`drainInboxForInnerIteration`) partitions on
 * this so genuine user speech reaches the model under the instruction-level
 * `kernel_user_input` side-channel kind (2026-07 复审 N2 fix).
 */
export const USER_INPUT_INBOX_SOURCE = 'user_input'

/** Stable id for inbox items (IPC / telemetry); cleared when {@link flushInboxToTranscript} consumes the queue. */
export type KernelInboxItem =
  | { kind: 'synthetic_user_text'; text: string; source?: string; inboxItemId?: string }
  | { kind: 'slash_command'; name: string; args: string; inboxItemId?: string }
  | { kind: 'inter_agent_mailbox_draft'; lines: string[]; inboxItemId?: string }
  /**
   * Durable HITL resume value.
   *
   * Pushed by `enqueueHumanResume(conversationId, toolUseId, value)` after the renderer
   * receives the user's answer to a paused `AskUserQuestion` (or, in a follow-up, a
   * permission ask). Unlike the other inbox kinds this item is **not** flushed into the
   * transcript by `flushInboxToTranscript`; it is consumed by HITL-aware tools that look
   * it up by `toolUseId` via {@link findPendingHumanResume}.
   *
   * The `value` is forwarded back to the tool as its return payload. Producers should
   * keep `value` JSON-serialisable so the inbox persistence file is always valid JSON.
   */
  | {
      kind: 'pending_human_resume'
      toolUseId: string
      value: unknown
      inboxItemId?: string
    }

import { createHash } from 'node:crypto'

export type TranscriptCommitSource =
  | 'renderer_seed'
  | 'agent_loop'
  | 'inbox'
  | 'compaction'
  | 'rewind'

export type TranscriptSnapshot = {
  revision: number
  fingerprint: string
  messages: Array<Record<string, unknown>>
}

export type TranscriptCommit = {
  baseRevision: number
  source: TranscriptCommitSource
  messages: Array<Record<string, unknown>>
}

export type TranscriptCommitResult =
  | { ok: true; snapshot: TranscriptSnapshot }
  | {
      ok: false
      kind: 'revision_conflict'
      expectedRevision: number
      actualRevision: number
    }

/**
 * Stable content identity for transcript CAS and drift checks. Object keys are
 * sorted so semantically identical JSON objects do not drift because a provider
 * reconstructed their property order.
 */
export function fingerprintTranscript(messages: Array<Record<string, unknown>>): string {
  const seen = new WeakSet<object>()
  const stable = JSON.stringify(messages, (_key, value: unknown) => {
    if (typeof value === 'bigint') return `${value.toString()}n`
    if (typeof value === 'function') return `[Function:${value.name || 'anonymous'}]`
    if (!value || typeof value !== 'object') return value
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    if (Array.isArray(value)) return value
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = (value as Record<string, unknown>)[key]
    }
    return sorted
  })
  return createHash('sha256').update(stable ?? 'undefined').digest('hex')
}

export function createTranscriptSnapshot(state: KernelLoopState): TranscriptSnapshot {
  return {
    revision: state.transcriptRevision,
    fingerprint: state.transcriptFingerprint,
    messages: cloneTranscript(state.transcript),
  }
}

/** Backward-compatible loader for version-1 state/checkpoint files. */
export function normalizeKernelLoopState(
  state: KernelLoopState | (Omit<KernelLoopState, 'transcriptRevision' | 'transcriptFingerprint'> & {
    transcriptRevision?: number
    transcriptFingerprint?: string
  }),
): KernelLoopState {
  const transcript = cloneTranscript(state.transcript)
  const revision = Number.isSafeInteger(state.transcriptRevision) && state.transcriptRevision! >= 0
    ? state.transcriptRevision!
    : 0
  const computedFingerprint = fingerprintTranscript(transcript)
  return {
    ...state,
    transcript,
    inbox: state.inbox.map((item) => ({ ...item })),
    transcriptRevision: revision,
    // Recompute rather than trusting disk. This both upgrades legacy files and
    // detects a partially-written/corrupted cached fingerprint.
    transcriptFingerprint: computedFingerprint,
  }
}

/** In-memory transcript + inbox for the kernel strangler path. */
export type KernelLoopState = {
  phase: KernelTurnPhase
  /**
   * Outer "turn" counter (incremented once per `runLegacyDelegateMainChat` call —
   * i.e. once per user prompt). Semantics match CC's queryLoop-level turn.
   */
  iteration: number
  /**
   * Inner "model iteration" counter (incremented each time the agentic loop calls the
   * model again within the same outer turn, e.g. after tool results or stop-hook continue). Reset
   * to 0 at the start of every outer turn. Used by telemetry consumers to disambiguate phase
   * events emitted by the inner stepper vs the outer kernel.
   */
  innerIteration: number
  transcript: Array<Record<string, unknown>>
  /** Monotonic CAS revision. Rewind restores content but never rolls this back. */
  transcriptRevision: number
  /** SHA-256 of the canonical transcript content. */
  transcriptFingerprint: string
  inbox: KernelInboxItem[]
  maxOutputRecoveryCycles: number
  consecutiveCompactFailures: number
}

export function createInitialKernelLoopState(
  transcript: Array<Record<string, unknown>>,
): KernelLoopState {
  const clonedTranscript = cloneTranscript(transcript)
  return {
    phase: 'Idle',
    iteration: 0,
    innerIteration: 0,
    transcript: clonedTranscript,
    transcriptRevision: 0,
    transcriptFingerprint: fingerprintTranscript(clonedTranscript),
    inbox: [],
    maxOutputRecoveryCycles: 0,
    consecutiveCompactFailures: 0,
  }
}

export function cloneTranscript(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (typeof structuredClone === 'function') {
    return structuredClone(messages)
  }
  return JSON.parse(JSON.stringify(messages)) as Array<Record<string, unknown>>
}
