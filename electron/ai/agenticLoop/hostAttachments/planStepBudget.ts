/**
 * Plan-step budget — per-step iteration budget for the active plan
 * (2026-07 deep-loop uplift, item #8).
 *
 * ## Why
 *
 * The plan surface has a step DRIVER (`planRuntime` auto-advance +
 * `planStepGuard`) but no per-step BUDGET: one stuck step can burn the
 * whole turn's `max_turns` while every later step starves — the classic
 * "first half of the long task is fine, second half never happens"
 * failure. This collector counts post-tool iterations spent on the
 * current `in_progress` plan step and escalates in two stages:
 *
 *   - **Soft budget** ({@link DEFAULT_SOFT_BUDGET_ITERATIONS}, default 12):
 *     one nudge per step — converge to the smallest verifiable unit,
 *     split the step, or mark it blocked and move on.
 *   - **Hard budget** ({@link DEFAULT_HARD_BUDGET_ITERATIONS}, default 24):
 *     the host marks the step `failed` via TaskManager (which triggers
 *     `planRuntime`'s auto-advance to open the next pending step) and
 *     tells the model to write down what blocked it and continue with
 *     the rest of the plan. Set `POLE_PLAN_STEP_BUDGET_HARD=0` to
 *     disable the hard action and keep nudge-only behaviour.
 *
 * "Iteration" here = one `post_tool` collector pass = one executed tool
 * batch. Deterministic, no LLM judgement — same philosophy as the
 * fact-ledger / verification-gate counters.
 *
 * ## Gating
 *
 * - On by default. Disable via `POLE_PLAN_STEP_BUDGET=0`.
 * - Main chat only (sub-agents own their own runs).
 * - Requires an active plan with exactly one `in_progress` step; counter
 *   resets whenever the current step changes (progress) or the plan
 *   goes away.
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'
import { getActivePlanStepsSnapshot } from '../../../planning/planRuntime'
import { taskManager } from '../../../tools/TaskManager'

/** Marker for tests / telemetry greps. */
export const PLAN_STEP_BUDGET_MARKER = '[Plan step budget — host check]'

export const DEFAULT_SOFT_BUDGET_ITERATIONS = 12
export const DEFAULT_HARD_BUDGET_ITERATIONS = 24

const MAX_SCOPE_BUCKETS = 32

function isEnabled(): boolean {
  const raw = process.env.POLE_PLAN_STEP_BUDGET?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function softBudget(): number {
  const n = parseIntEnv(
    process.env.POLE_PLAN_STEP_BUDGET_SOFT,
    DEFAULT_SOFT_BUDGET_ITERATIONS,
  )
  return n > 0 ? n : DEFAULT_SOFT_BUDGET_ITERATIONS
}

/** 0 ⇒ hard action disabled (nudge-only mode). */
function hardBudget(soft: number): number {
  const n = parseIntEnv(
    process.env.POLE_PLAN_STEP_BUDGET_HARD,
    DEFAULT_HARD_BUDGET_ITERATIONS,
  )
  if (n === 0) return 0
  // Hard must exceed soft to leave room for the nudge to work.
  return Math.max(n, soft + 1)
}

interface ScopeTracking {
  taskId: string
  ticks: number
  softNudged: boolean
}

const trackingByScope = new Map<string, ScopeTracking>()

function touchScope(scopeKey: string): void {
  const entry = trackingByScope.get(scopeKey)
  if (entry) {
    trackingByScope.delete(scopeKey)
    trackingByScope.set(scopeKey, entry)
  }
  while (trackingByScope.size > MAX_SCOPE_BUCKETS) {
    const oldest = trackingByScope.keys().next().value
    if (oldest === undefined || oldest === scopeKey) break
    trackingByScope.delete(oldest)
  }
}

/** @internal Test-only seam. */
export function __resetPlanStepBudgetTrackingForTests(): void {
  trackingByScope.clear()
}

function buildSoftDirective(subject: string, ticks: number, hard: number): string {
  return (
    `${PLAN_STEP_BUDGET_MARKER}\n\n` +
    `The current plan step ("${subject}") has consumed ${ticks} tool-batch iterations ` +
    `without completing.` +
    (hard > 0
      ? ` At ${hard} iterations the host will mark it failed and advance to the next step.`
      : '') +
    `\n\nConverge now — pick exactly one:\n` +
    `  (a) finish the smallest verifiable unit of this step and mark it completed via TaskUpdate; OR\n` +
    `  (b) split it into smaller steps (TaskCreate) and complete the first one; OR\n` +
    `  (c) if it is genuinely blocked, say what blocks it, mark it failed via TaskUpdate, and move on.\n\n` +
    `Do not keep grinding the same step without visible progress.`
  )
}

function buildHardDirective(subject: string, ticks: number): string {
  return (
    `${PLAN_STEP_BUDGET_MARKER}\n\n` +
    `The plan step ("${subject}") exceeded its hard budget (${ticks} tool-batch ` +
    `iterations) and the host has marked it FAILED. The next pending step (if any) ` +
    `has been opened automatically.\n\n` +
    `Before continuing: state in one or two sentences what blocked this step so the ` +
    `user can see it. Then work the newly opened step. Do NOT silently retry the ` +
    `failed step — if you believe it is still essential, say so and let the user decide.`
  )
}

export const planStepBudgetCollector: Collector = {
  name: 'plan_step_budget',
  callSites: ['post_tool'],

  async run(_ctx) {
    if (!isEnabled()) return null

    const agentCtx = getAgentContext()
    const agentId = agentCtx?.agentId ?? 'main'
    if (agentId !== 'main') return null

    const scopeKey = agentCtx?.streamConversationId?.trim() || 'main'

    const snapshot = getActivePlanStepsSnapshot()
    const current = snapshot?.steps.find((s) => s.status === 'in_progress')
    if (!current) {
      trackingByScope.delete(scopeKey)
      return null
    }

    touchScope(scopeKey)
    let entry = trackingByScope.get(scopeKey)
    if (!entry || entry.taskId !== current.taskId) {
      entry = { taskId: current.taskId, ticks: 0, softNudged: false }
      trackingByScope.set(scopeKey, entry)
    }
    entry.ticks += 1

    const soft = softBudget()
    const hard = hardBudget(soft)

    if (hard > 0 && entry.ticks >= hard) {
      // Host-driven granularity: fail the stuck step. planRuntime's
      // lifecycle listener auto-advances the next pending step.
      try {
        taskManager.update(current.taskId, { status: 'failed' })
      } catch (e) {
        console.warn('[planStepBudget] failed to mark step failed:', e)
      }
      trackingByScope.delete(scopeKey)
      return {
        kind: 'push_message',
        message: {
          role: 'user',
          content: wrapSideChannelBody(
            SIDE_CHANNEL_KIND.genericConvertedSystem,
            buildHardDirective(current.subject, entry.ticks),
          ),
          _convertedFromSystem: true,
          _sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
        },
        sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      }
    }

    if (entry.ticks >= soft && !entry.softNudged) {
      entry.softNudged = true
      return {
        kind: 'push_message',
        message: {
          role: 'user',
          content: wrapSideChannelBody(
            SIDE_CHANNEL_KIND.genericConvertedSystem,
            buildSoftDirective(current.subject, entry.ticks, hard),
          ),
          _convertedFromSystem: true,
          _sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
        },
        sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      }
    }

    return null
  },
}
