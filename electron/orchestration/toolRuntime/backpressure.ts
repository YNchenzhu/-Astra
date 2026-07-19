/**
 * P2-5 quota backpressure — shared admission wait loop.
 *
 * Extracted (audit SA-1, 2026-06) from
 * `DefaultToolRuntimePort.runQuotaAdmitAndPreemptPhase` so the fallback batch
 * path in `electron/ai/agenticLoop/toolExec.ts` shares the exact same
 * semantics — parity by construction. A quota rejection is NOT an instant
 * hard failure: the tool is marked `'blocked'` (reason `'backpressure'`) and
 * admission is re-attempted at `decision.retryAfterMs` intervals until a slot
 * frees up, the batch-wide deadline passes, or the signal aborts.
 *
 * Callers gate entry with the same condition the main path used
 * (`!decision.allowed && waitBudgetMs > 0 && !signal.aborted`) and own the
 * "skip denial synthesis on abort" decision afterwards
 * (`signal.aborted && !decision.allowed` → no denial tool_result).
 */

import { markToolBlocked, markToolUnblocked } from './state'
import type { AdmissionDecision, getResourceQuotaManager } from './quota'
import type { AgentId } from '../../tools/ids'

type QuotaManager = ReturnType<typeof getResourceQuotaManager>
export type QuotaAdmitInput = Parameters<QuotaManager['admit']>[0]

/**
 * Abort-aware sleep used by the backpressure wait loop. Resolves (never
 * rejects) either after `ms` or as soon as the signal aborts, so the caller
 * can re-check `signal.aborted` and exit quickly.
 */
export function sleepUntilAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Backpressure wait loop: re-attempt `quota.admit(admitInput)` until it
 * allows, `phaseDeadline` passes, or `signal` aborts. Returns the final
 * decision (allowed, or the last denied decision so the caller reports the
 * real quota reason).
 *
 * Side effects: first wait marks the tool `'blocked'` (`'backpressure'`);
 * when the slot frees up or the signal aborts the tool flips back via
 * `markToolUnblocked` (budget exhaustion leaves it blocked — the caller's
 * denial path marks it failed). A throw during a retry admit ends the wait
 * with the last denied decision.
 */
export async function waitForQuotaSlotWithBackpressure(params: {
  quota: QuotaManager
  admitInput: QuotaAdmitInput
  initialDecision: AdmissionDecision
  /** Shared batch-wide deadline (`Date.now() + backpressureMaxWaitMs`). */
  phaseDeadline: number
  signal: AbortSignal
  /** Log prefix, e.g. `'DefaultToolRuntimePort'` or `'toolExec.fallback'`. */
  logTag: string
}): Promise<AdmissionDecision> {
  const { quota, admitInput, phaseDeadline, signal, logTag } = params
  let decision = params.initialDecision
  let waitedForSlot = false
  while (!decision.allowed && Date.now() < phaseDeadline && !signal.aborted) {
    const remainingMs = phaseDeadline - Date.now()
    const delayMs = Math.min(Math.max(decision.retryAfterMs ?? 500, 50), remainingMs)
    if (!waitedForSlot) {
      waitedForSlot = true
      try {
        markToolBlocked(admitInput.toolUseId, 'backpressure')
      } catch {
        /* bookkeeping must not break execution */
      }
      console.log(
        `[${logTag}] backpressure: ${admitInput.toolName} (toolUseId=${admitInput.toolUseId}) ` +
          `waiting for quota slot (reason=${decision.reason ?? 'unknown'}, ` +
          `budget=${remainingMs}ms)`,
      )
    }
    await sleepUntilAbort(delayMs, signal)
    if (signal.aborted) break
    try {
      decision = quota.admit(admitInput)
    } catch (e) {
      // A throw during retry ends the wait. Keep the last (denied) decision
      // so the caller's deny path reports the real quota reason rather than
      // a synthetic one.
      console.warn(`[${logTag}] quota.admit threw during backpressure retry:`, e)
      break
    }
  }
  if (waitedForSlot && (decision.allowed || signal.aborted)) {
    // Slot freed up (→ back to 'queued') or the batch was aborted (sweep /
    // inner batch abort handling owns the terminal state).
    try {
      markToolUnblocked(admitInput.toolUseId)
    } catch {
      /* ignore */
    }
  }
  return decision
}

/** Minimal scheduler surface the hold-release wait needs (decoupled for tests). */
export interface SchedulerHoldGate {
  shouldHoldForHigherPriority(
    agentId: AgentId,
    selfPriority: number,
  ): { held: boolean; reason?: string }
}

/**
 * Scheduler-drive cross-agent hold wait (`POLE_TOOL_SCHEDULER_DRIVE=1`).
 *
 * Structurally mirrors {@link waitForQuotaSlotWithBackpressure}: while the
 * scheduler reports this tool should hold for a higher-priority agent, mark it
 * `'blocked'` (reason `'scheduler_hold'`), sleep abort-aware, and re-evaluate.
 * Returns when the hold releases, the shared `phaseDeadline` passes
 * (anti-starvation — the tool then proceeds to normal quota admission), or the
 * signal aborts.
 *
 * Unlike quota backpressure, a hold NEVER denies — it only delays. The caller
 * runs its existing quota admit / backpressure unchanged afterwards. Reuses
 * the same batch-wide `phaseDeadline` so holding + quota waiting can't stack
 * beyond `backpressureMaxWaitMs`.
 */
export async function waitForSchedulerHoldRelease(params: {
  scheduler: SchedulerHoldGate
  agentId: AgentId
  selfPriority: number
  toolUseId: string
  toolName: string
  /** Shared batch-wide deadline (`Date.now() + backpressureMaxWaitMs`). */
  phaseDeadline: number
  signal: AbortSignal
  /** Log prefix, e.g. `'DefaultToolRuntimePort'` or `'toolExec.fallback'`. */
  logTag: string
}): Promise<{ held: boolean; waitedMs: number; reason?: string }> {
  const { scheduler, agentId, selfPriority, toolUseId, toolName, phaseDeadline, signal, logTag } =
    params
  let hold = scheduler.shouldHoldForHigherPriority(agentId, selfPriority)
  if (!hold.held) return { held: false, waitedMs: 0 }
  // Contract audit (2026-07) — report whether the tool actually held (and for
  // how long) so the caller can emit user-visible backpressure telemetry
  // instead of leaving the stall explained only by console.log.
  const holdStartedAt = Date.now()
  const firstReason = hold.reason
  let markedBlocked = false
  while (hold.held && Date.now() < phaseDeadline && !signal.aborted) {
    if (!markedBlocked) {
      markedBlocked = true
      try {
        markToolBlocked(toolUseId, 'scheduler_hold')
      } catch {
        /* bookkeeping must not break execution */
      }
      console.log(
        `[${logTag}] scheduler-hold: ${toolName} (toolUseId=${toolUseId}) ` +
          `holding for higher-priority agent (reason=${hold.reason ?? 'unknown'}, ` +
          `budget=${phaseDeadline - Date.now()}ms)`,
      )
    }
    const remainingMs = phaseDeadline - Date.now()
    await sleepUntilAbort(Math.min(500, Math.max(50, remainingMs)), signal)
    if (signal.aborted) break
    hold = scheduler.shouldHoldForHigherPriority(agentId, selfPriority)
  }
  if (markedBlocked) {
    // Released, deadline reached, or aborted — flip back to 'queued' so the
    // subsequent quota admit sees a clean state (quota backpressure owns its
    // own blocked/unblocked cycle; terminal state is owned by execution).
    try {
      markToolUnblocked(toolUseId)
    } catch {
      /* ignore */
    }
  }
  return {
    held: true,
    waitedMs: Date.now() - holdStartedAt,
    ...(firstReason ? { reason: firstReason } : {}),
  }
}
