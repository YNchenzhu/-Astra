/**
 * Plan-step scope check — flags "drive-by refactoring" drift
 * (2026-07 deep-loop uplift, item #4).
 *
 * ## Why
 *
 * The plan surface now has a per-step TIME budget (`planStepBudget`) but
 * nothing watches WHERE the work lands: a model "just quickly fixing"
 * files unrelated to the current step is the classic scope-creep drift —
 * it burns the step's budget on side quests and produces diffs the user
 * never asked for. This collector compares the current tool batch's
 * file MUTATIONS against the current `in_progress` step's declared scope
 * and nudges ONCE per step when edits repeatedly land outside it.
 *
 * ## Scope resolution (deterministic, graceful degradation)
 *
 *   1. The step's `files` array from the plan-json block (paths or simple
 *      globs — `*` matches within a segment, `**` across segments),
 *      persisted on the task's `planStepFiles` metadata.
 *   2. Fallback: path-like tokens extracted from the step subject
 *      (`extractPathLikeTerms` — same extractor as the clamp relevance
 *      layer).
 *   3. Neither yields terms → collector stays silent. Plans that never
 *      declare scope (or writing-style plans with prose-only steps) are
 *      completely unaffected.
 *
 * A path is IN scope when it matches the CURRENT step's scope or ANY
 * OTHER step's declared scope (working ahead on a later step is progress,
 * not drift — the step driver handles ordering separately).
 *
 * ## Escalation
 *
 * Out-of-scope mutation targets accumulate per (conversation, step).
 * Once {@link DEFAULT_MIN_OUT_OF_SCOPE_FILES} DISTINCT files (default 2 —
 * a single incidental edit, e.g. fixing an import, is normal collateral)
 * are seen, ONE nudge fires for this step: reconcile — either return to
 * the step, or update the plan/step scope to make the extra work
 * explicit. Never blocks execution; purely a drift signal.
 *
 * ## Gating
 *
 * - On by default. Disable via `POLE_PLAN_STEP_SCOPE=0`.
 * - Main chat only. `post_tool` only (needs this iteration's batch).
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'
import {
  getActivePlanStepsSnapshot,
  type ActivePlanStep,
} from '../../../planning/planRuntime'
import {
  isBuiltinFileMutationTool,
  extractWorkspaceFilePathFromToolInput,
} from '../../../tools/builtinToolAliases'
import { extractPathLikeTerms } from '../../../context/activeTaskRelevance'

/** Marker for tests / telemetry greps. */
export const PLAN_STEP_SCOPE_MARKER = '[Plan step scope — host check]'

export const DEFAULT_MIN_OUT_OF_SCOPE_FILES = 2
const MAX_SCOPE_BUCKETS = 32
const MAX_FILES_LISTED = 5

function isEnabled(): boolean {
  const raw = process.env.POLE_PLAN_STEP_SCOPE?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
}

function minOutOfScopeFiles(): number {
  const n = Number.parseInt(process.env.POLE_PLAN_STEP_SCOPE_MIN_FILES ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_OUT_OF_SCOPE_FILES
}

// ─── Matching ───────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** Convert a simple glob to a RegExp: `**` spans segments, `*` stays in
 *  one segment. Everything else is literal. Matches ANYWHERE in the
 *  normalized path so plans can declare workspace-relative fragments. */
function globToRegExp(glob: string): RegExp {
  const escaped = normalizePath(glob)
    .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
    .replace(/\*\*/g, '\uE000')
    .replace(/\*/g, '[^/]*')
    .replace(/\uE000/g, '.*')
  return new RegExp(escaped)
}

/** One scope term (glob or plain fragment) vs one normalized path. */
export function scopeTermMatchesPath(term: string, normalizedPath: string): boolean {
  const t = normalizePath(term.trim())
  if (!t) return false
  if (t.includes('*')) {
    try {
      return globToRegExp(t).test(normalizedPath)
    } catch {
      return false
    }
  }
  return normalizedPath.includes(t)
}

/** Resolve a step's scope terms: declared files, else path-like tokens
 *  from the subject, else []. Exported for tests. */
export function resolveStepScopeTerms(step: ActivePlanStep): string[] {
  if (step.files && step.files.length > 0) return step.files
  return extractPathLikeTerms([step.subject])
}

// ─── Per-step tracking ──────────────────────────────────────────────────

interface ScopeTracking {
  taskId: string
  outOfScopePaths: Set<string>
  nudged: boolean
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
export function __resetPlanStepScopeTrackingForTests(): void {
  trackingByScope.clear()
}

function buildDirective(
  stepSubject: string,
  offenders: ReadonlyArray<string>,
): string {
  const listed = offenders.slice(0, MAX_FILES_LISTED).map((p) => `  - ${p}`)
  const overflow =
    offenders.length > MAX_FILES_LISTED
      ? `\n  … (+${offenders.length - MAX_FILES_LISTED} more)`
      : ''
  return (
    `${PLAN_STEP_SCOPE_MARKER}\n\n` +
    `The current plan step is "${stepSubject}", but this run has modified ` +
    `${offenders.length} file(s) outside every step's declared scope:\n` +
    `${listed.join('\n')}${overflow}\n\n` +
    `If these edits are required by the current step, briefly say why and continue — ` +
    `then consider updating the step's file scope so the plan reflects reality. ` +
    `If they are side work the user did not ask for, stop expanding: revert or park ` +
    `them, and return to the current step. Do not let the task quietly grow.`
  )
}

export const planStepScopeCollector: Collector = {
  name: 'plan_step_scope',
  callSites: ['post_tool'],

  async run(ctx) {
    if (!isEnabled()) return null
    const { state } = ctx

    const agentCtx = getAgentContext()
    if ((agentCtx?.agentId ?? 'main') !== 'main') return null

    const snapshot = getActivePlanStepsSnapshot()
    const current = snapshot?.steps.find((s) => s.status === 'in_progress')
    if (!snapshot || !current) return null

    const currentTerms = resolveStepScopeTerms(current)
    if (currentTerms.length === 0) return null // no declared scope → silent

    // Mutations in THIS batch.
    const mutatedPaths = new Set<string>()
    for (const block of state.toolUseBlocks) {
      if (!isBuiltinFileMutationTool(block.name)) continue
      const p = extractWorkspaceFilePathFromToolInput(block.input)
      if (p) mutatedPaths.add(p)
    }
    if (mutatedPaths.size === 0) return null

    // In-scope = current step's scope OR any other step's scope. Audit fix
    // (2026-07): other steps resolve through the SAME fallback chain as the
    // current step (declared files → subject-derived path tokens) — the
    // previous `s.files ?? []` only honoured declared files, so on a plan
    // that never declares `files`, working ahead on a later step's
    // subject-named file was misreported as out-of-scope drift.
    const otherTerms = snapshot.steps
      .filter((s) => s.taskId !== current.taskId)
      .flatMap((s) => resolveStepScopeTerms(s))
    const inScope = (normalized: string): boolean =>
      currentTerms.some((t) => scopeTermMatchesPath(t, normalized)) ||
      otherTerms.some((t) => scopeTermMatchesPath(t, normalized))

    const scopeKey = agentCtx?.streamConversationId?.trim() || 'main'
    touchScope(scopeKey)
    let entry = trackingByScope.get(scopeKey)
    if (!entry || entry.taskId !== current.taskId) {
      entry = { taskId: current.taskId, outOfScopePaths: new Set(), nudged: false }
      trackingByScope.set(scopeKey, entry)
    }

    for (const p of mutatedPaths) {
      if (!inScope(normalizePath(p))) entry.outOfScopePaths.add(p)
    }

    if (entry.nudged) return null
    if (entry.outOfScopePaths.size < minOutOfScopeFiles()) return null

    entry.nudged = true
    const offenders = [...entry.outOfScopePaths]

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'plan_step_scope',
      outOfScopeCount: offenders.length,
    })

    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      message: {
        role: 'user',
        content: wrapSideChannelBody(
          SIDE_CHANNEL_KIND.genericConvertedSystem,
          buildDirective(current.subject, offenders),
        ),
        _convertedFromSystem: true,
        _sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      },
    }
  },
}
