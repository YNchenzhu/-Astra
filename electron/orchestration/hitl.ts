/**
 * Durable Human-In-The-Loop primitives.
 *
 * Problem this solves: today `AskUserQuestion` (and the broader "ask user before this tool
 * runs" permission flow) holds an in-process `await` on an IPC promise. When the Electron
 * main process crashes / is OOM-killed / is restarted by an update, the answer the user
 * eventually gives is lost — there is no other side of the promise to receive it. The user
 * also wastes resources while the loop is parked: AbortController, token budget, etc.
 *
 * Design — mirrors LangGraph `interrupt()` / `Command(resume=...)`:
 *
 *   1. The HITL-aware tool first inspects the kernel inbox for a `pending_human_resume`
 *      entry whose `toolUseId` matches its own. If found, it consumes it and returns the
 *      `value` verbatim. (This is the resume path: same tool_use_id, second execution,
 *      cached answer.)
 *
 *   2. If no resume is waiting, the tool throws {@link InterruptForHITL}. The agentic loop's
 *      `toolExec` runtime is expected to recognise this throw and trigger a clean kernel
 *      Terminal exit (state already persisted via inbox file + auto-snapshot). The renderer
 *      sees a phase event tagged `interrupt:hitl` (P1.1 sink) carrying the question payload.
 *
 *   3. The renderer presents the question; user answers; renderer calls
 *      `enqueueHumanResume(conversationId, toolUseId, value)` (see `inbox.ts`). This drops
 *      a `pending_human_resume` inbox item, which survives process restart via
 *      `inboxPersistence`.
 *
 *   4. On the next kernel run (either same process or post-restart) the tool's first
 *      execution again checks the inbox, this time finds the resume, returns the value.
 *
 * Activation: gated behind `POLE_ORCHESTRATION_DURABLE_HITL=1`. When OFF, HITL tools fall
 * back to the legacy "await IPC promise" path. The gate is OFF in production by default
 * for at least one minor release per the rollout plan.
 *
 * **Important — side effect re-execution**: LangGraph documents that `interrupt()` causes
 * the entire node to re-execute on resume; any side effects before the interrupt run again.
 * For us the equivalent is: the tool's `call()` re-runs from the top. `AskUserQuestion` is
 * pure (just validation + the question call) so this is safe. Other HITL-aware tools MUST
 * ensure any pre-interrupt side effects are idempotent.
 */

import { getOrchestrationKernelForConversation } from './activeKernelRegistry'
import type { KernelInboxItem, KernelLoopState } from './kernelTypes'

/**
 * G1 — Detect whether durable HITL can actually run in the current context.
 *
 * Returns `true` only when ALL of these hold:
 *   - the env flag is enabled,
 *   - a non-empty conversation id is available (the kernel registry is keyed on it),
 *   - a kernel is currently registered for that conversation.
 *
 * Callers (AskUserQuestion, permission-ask wrapper) should fall back to the legacy
 * "await IPC promise" path when this returns `false`. Throwing `InterruptForHITL`
 * without a kernel to observe the throw would create a leaked pending registry entry
 * (since `toolExec.ts` can't emit the phase event / interrupt the kernel) — the model
 * would see a placeholder result and might retry, hitting the same throw again.
 */
export function canUseDurableHITL(conversationId: string | undefined): boolean {
  if (!isDurableHITLEnabled()) return false
  const id = conversationId?.trim()
  if (!id) return false
  return !!getOrchestrationKernelForConversation(id)
}

/** Exception thrown by a HITL-aware tool to ask the orchestration runtime to pause + persist. */
export class InterruptForHITL<Q = unknown> extends Error {
  /** Distinguishes this exception class from generic Errors when catching across module
   * boundaries (instanceof works in-package; the tag survives serialisation). */
  readonly tag = 'orchestration:hitl' as const
  /** Tool use id this interrupt belongs to. The renderer + resume entry use this to route. */
  readonly toolUseId: string
  /** Opaque question payload presented to the user — the renderer decides how to render it. */
  readonly question: Q

  constructor(toolUseId: string, question: Q, message?: string) {
    super(message ?? `HITL pause for tool_use ${toolUseId}`)
    this.name = 'InterruptForHITL'
    this.toolUseId = toolUseId
    this.question = question
    // Set prototype explicitly so `instanceof InterruptForHITL` works after transpilation.
    Object.setPrototypeOf(this, InterruptForHITL.prototype)
  }
}

/** Type predicate for runtime / tests catching the throw. */
export function isInterruptForHITL(value: unknown): value is InterruptForHITL {
  return (
    value instanceof InterruptForHITL ||
    (typeof value === 'object' &&
      value !== null &&
      (value as { tag?: unknown }).tag === 'orchestration:hitl' &&
      typeof (value as { toolUseId?: unknown }).toolUseId === 'string')
  )
}

/**
 * Locate the resume value for `toolUseId` in a kernel loop state's inbox. Returns the value
 * AND a list of *other* inbox items (everything except the consumed one) so the caller can
 * commit the consumption back through `applySessionCommands` or `enqueueInboxItem`.
 *
 * Returns null when no matching resume is queued — the caller should then throw
 * {@link InterruptForHITL}.
 */
export function findPendingHumanResume(
  state: Pick<KernelLoopState, 'inbox'>,
  toolUseId: string,
): { value: unknown; remainingInbox: KernelInboxItem[] } | null {
  const target = state.inbox.find(
    (i) => i.kind === 'pending_human_resume' && i.toolUseId === toolUseId,
  )
  if (!target || target.kind !== 'pending_human_resume') return null
  const remainingInbox = state.inbox.filter((i) => i !== target)
  return { value: target.value, remainingInbox }
}

/**
 * Feature flag for P2.1.
 *
 * flipped from opt-in to opt-out (default on) once the renderer
 * grew a `hitlPaused` UI slot + a durable HITL badge (see
 * `src/components/AIChat/AskUserQuestionDialog.tsx`). Set
 * `POLE_ORCHESTRATION_DURABLE_HITL=0` to fall back to the legacy "await IPC
 * promise" path (no durability across process restarts).
 *
 * Recognised "off" values: `'0' | 'false' | 'no'` (case-insensitive).
 */
export function isDurableHITLEnabled(): boolean {
  const v = process.env.POLE_ORCHESTRATION_DURABLE_HITL?.trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'no') return false
  return true
}

/**
 * Helper for tools: look up the kernel registered for the current conversation, query its
 * inbox for a resume, and (if found) consume it before returning the value.
 *
 * Defensive against:
 *   - missing conversation id (tool running outside an orchestrated session)
 *   - missing kernel (legacy path, or session already torn down)
 *   - missing tool_use_id (caller bug)
 *
 * Returns `{ resumed: true, value }` if a queued answer was found; `{ resumed: false }`
 * otherwise. Tools should throw {@link InterruptForHITL} on `resumed === false` when the
 * durable flag is on.
 */
export function tryConsumePendingHumanResume(
  conversationId: string | undefined,
  toolUseId: string | undefined,
): { resumed: true; value: unknown } | { resumed: false } {
  if (!conversationId || !toolUseId) return { resumed: false }
  const kernel = getOrchestrationKernelForConversation(conversationId)
  if (!kernel) return { resumed: false }
  const state = kernel.getState()
  const found = findPendingHumanResume(state, toolUseId)
  if (!found) return { resumed: false }
  // Consume: replace inbox with remainingInbox via the kernel's reducer path. We can't reach
  // applySessionCommands here without coupling, so go through enqueue/clear: clear inbox then
  // re-enqueue everything except the consumed item. This stays in the existing reducer API.
  kernel.consumeHumanResume(toolUseId)
  return { resumed: true, value: found.value }
}

/**
 * P2.1 follow-up — pending HITL interrupt registry.
 *
 * When a tool throws {@link InterruptForHITL} inside a tool batch, the batch runner cannot
 * synchronously call `kernel.interrupt('hitl')` (the kernel is layered above the batch
 * runtime, and a hard interrupt would unwind the batch before its synthetic tool_results
 * land in apiMessages). Instead the batch synthesises a paused placeholder tool_result and
 * **records** the interrupt here. After the batch returns, `toolExec.ts` checks this
 * registry and:
 *
 *   1. fires the `interrupt` phase event tagged `'hitl'` carrying the question payload, then
 *   2. aborts the kernel so the iteration exits cleanly without a follow-up model call.
 *
 * Keyed by `conversationId` so concurrent multi-conversation kernels don't collide.
 */
export type PendingHITL = {
  toolUseId: string
  question: unknown
  /** Best-effort kind tag — telemetry routing only. */
  kind: 'ask_user_question' | 'permission_ask'
  recordedAt: number
}

const pendingByConversation = new Map<string, PendingHITL>()

/**
 * Record an interrupt for `conversationId`. Most recent wins (only one HITL per turn).
 *
 * G7 — if a HITL was already pending for this conversation, log a warning. This
 * should not happen in practice because `AskUserQuestion` is in `NON_PARALLEL_TOOLS`
 * (serial step) and `G4` makes the batch break out after the first HITL. Hitting this
 * warning indicates either:
 *   - a future parallel HITL-capable tool was introduced without batch coordination
 *   - the kernel registry was missing so toolExec's `takePendingHITL` never fired
 *     (G1's fallback should cover this, but the warning leaves a breadcrumb)
 * The warn is single-line and rate-unrelevant (max once per pump cycle).
 */
export function recordPendingHITL(
  conversationId: string | undefined,
  payload: PendingHITL,
): void {
  const id = conversationId?.trim()
  if (!id) return
  const prior = pendingByConversation.get(id)
  if (prior) {
    console.warn(
      `[hitl] recordPendingHITL overwriting prior pending entry for conversation=${id} ` +
        `(was: ${prior.kind}/${prior.toolUseId}, now: ${payload.kind}/${payload.toolUseId}). ` +
        `Either two HITL tools fired in the same batch (see G4) or the prior entry was ` +
        `never consumed by takePendingHITL (see G1).`,
    )
  }
  pendingByConversation.set(id, payload)
}

/** Read + clear the pending interrupt for `conversationId`, if any. */
export function takePendingHITL(
  conversationId: string | undefined,
): PendingHITL | undefined {
  const id = conversationId?.trim()
  if (!id) return undefined
  const v = pendingByConversation.get(id)
  if (!v) return undefined
  pendingByConversation.delete(id)
  return v
}

/**
 * G3 — Clear the pending HITL entry for a single conversation. Called from
 * `unregisterOrchestrationKernelForConversation` so a session that ended without the
 * renderer answering does not leak a registry entry forever.
 *
 * Safe to call when no entry exists (no-op). Distinct from `takePendingHITL` in that it
 * does not return the value — this is the "throw it away on teardown" path, not the
 * "consume to act on" path.
 */
export function clearPendingHITLForConversation(conversationId: string | undefined): void {
  const id = conversationId?.trim()
  if (!id) return
  pendingByConversation.delete(id)
}

/** Test-only: clear all conversations. Production never calls this. */
export function clearAllPendingHITLForTests(): void {
  pendingByConversation.clear()
}

/**
 * Synthesise the placeholder tool_result block the batch returns for the paused tool.
 *
 * Anthropic requires that every `tool_use` block in the assistant message have a paired
 * `tool_result` in the next user message. If we re-throw `InterruptForHITL` out of the
 * batch we'd leave the assistant message dangling. The placeholder preserves wire-format
 * validity for the persisted transcript — the model never actually reads it because the
 * loop terminates before the next model call.
 */
export function buildPausedToolResultBlock(toolUseId: string): Record<string, unknown> {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    is_error: false,
    content:
      '[HITL paused — awaiting human input. Resume value will be supplied on next turn.]',
    // Internal marker so renderer / replay tooling can recognise the placeholder.
    // Anthropic ignores unknown top-level fields on tool_result blocks.
    _hitlPlaceholder: true,
  }
}
