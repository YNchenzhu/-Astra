import type { CompactOptions } from './compact'
import type { ContextThresholds } from './manager'

export type PhaseAwareCompactBoundary = NonNullable<
  CompactOptions['proactiveCompact']
>['boundary']

export type PhaseAwareCompactStrength = 'strong' | 'medium' | 'weak'

export type PhaseAwareCompactReason =
  | 'exit_plan_mode'
  | 'enter_plan_mode'
  | 'todo_checkpoint'
  | 'verification_checkpoint'
  | 'agent_checkpoint'
  | 'tool_batch_checkpoint'
  | 'degradation_checkpoint'

export interface PhaseAwareToolUse {
  name: string
  input?: Record<string, unknown>
}

export interface PhaseAwareCompactSignal {
  reason: PhaseAwareCompactReason
  strength: PhaseAwareCompactStrength
  sourceToolName: string
  detail?: string
}

export type PhaseAwareCompactSkippedReason =
  | 'disabled'
  | 'no_signal'
  | 'below_threshold'
  | 'cooldown'
  | 'no_reclaimable_history'

export type PhaseAwareCompactDecision =
  | {
      shouldCompact: true
      request: NonNullable<CompactOptions['proactiveCompact']>
      signal: PhaseAwareCompactSignal
      signals: PhaseAwareCompactSignal[]
      estimatedTokens: number
      thresholdTokens: number
    }
  | {
      shouldCompact: false
      skippedReason: PhaseAwareCompactSkippedReason
      signals: PhaseAwareCompactSignal[]
      estimatedTokens: number
      thresholdTokens?: number
    }

/**
 * GAP 4 (2026-06 long-run hallucination audit) — degradation signal.
 *
 * ARC-style "reflection-driven context reorganization": the host
 * already DETECTS degenerate behaviour (repetition guard counting
 * consecutive identical tool calls), but until now the only responses
 * were a warn advisory or a hard halt. Long-horizon research (ARC,
 * arXiv 2601.12030) shows degradation signals should also trigger
 * context REORGANIZATION — repetition in a long transcript is often a
 * symptom of context rot, and reclaiming stale tool results refocuses
 * the model. This signal plugs the existing detector into the existing
 * proactive-compact pipeline; both halves already existed, only the
 * wire was missing.
 *
 * Deterministic: built from `RepetitionGuard.snapshot()` counts by the
 * caller (`postModel.ts`); no semantic judgement.
 */
export interface PhaseAwareDegradationSignal {
  kind: 'tool_repetition'
  toolName: string
  consecutiveCount: number
}

/**
 * Consecutive identical-call count at which the degradation signal is
 * considered `strong` (compacts from the earliest `warningTokens`
 * threshold). Matches the repetition guard's default `haltThreshold`.
 * Below this (but ≥ the guard's warn level) the signal is `medium`.
 */
export const DEGRADATION_STRONG_REPETITION_COUNT = 5

export interface DecidePhaseAwareCompactParams {
  boundary: PhaseAwareCompactBoundary
  toolUseBlocks: PhaseAwareToolUse[]
  messages: Array<Record<string, unknown>>
  thresholds: ContextThresholds
  estimatedTokens: number
  iteration: number
  lastPhaseAwareCompactIteration: number
  /** Optional degradation signal from the agent runtime (see {@link PhaseAwareDegradationSignal}). */
  degradation?: PhaseAwareDegradationSignal
}

const STRENGTH_RANK: Record<PhaseAwareCompactStrength, number> = {
  weak: 1,
  medium: 2,
  strong: 3,
}

/**
 * P3.3 — Cooldown between phase-aware compact runs (iterations).
 *
 * upstream parity: their `services/compact/autoCompact.ts` doesn't have a
 * direct equivalent of this cooldown (auto-compact fires on every turn
 * that crosses the threshold), but the spirit is the same — back off so
 * one big context bump doesn't trigger a compact storm on consecutive
 * turns.
 *
 * Tunable via `POLE_COMPACT_COOLDOWN_ITERATIONS` (operator override, no
 * rebuild). Invalid / negative values fall back to the default.
 */
const PHASE_AWARE_COMPACT_COOLDOWN_ITERATIONS = parsePositiveIntEnv(
  process.env.POLE_COMPACT_COOLDOWN_ITERATIONS,
  2,
)
const MICRO_COMPACT_KEEP_RECENT_GROUPS = 5

function parsePositiveIntEnv(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue
}

const MUTATION_OR_COMMAND_TOOLS = new Set([
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
  'PowerShell',
  'Agent',
])

const VERIFICATION_COMMAND_RE =
  /\b(test|vitest|jest|playwright|typecheck|tsc\s+-b|lint|eslint|build|verify|verification)\b/i

export function collectPhaseAwareCompactSignals(
  toolUseBlocks: PhaseAwareToolUse[],
): PhaseAwareCompactSignal[] {
  const signals: PhaseAwareCompactSignal[] = []

  for (const toolUse of toolUseBlocks) {
    const name = toolUse.name
    if (name === 'ExitPlanMode') {
      signals.push({
        reason: 'exit_plan_mode',
        strength: 'strong',
        sourceToolName: name,
      })
      continue
    }

    if (name === 'EnterPlanMode') {
      signals.push({
        reason: 'enter_plan_mode',
        strength: 'medium',
        sourceToolName: name,
      })
      continue
    }

    if (name === 'TodoWrite') {
      const todoSignal = signalFromTodoWrite(toolUse.input)
      if (todoSignal) signals.push({ ...todoSignal, sourceToolName: name })
      continue
    }

    if (name === 'Agent') {
      signals.push(signalFromAgent(toolUse.input))
      continue
    }

    if (toolUseLooksLikeVerification(toolUse)) {
      signals.push({
        reason: 'verification_checkpoint',
        strength: 'medium',
        sourceToolName: name,
      })
    }
  }

  if (
    toolUseBlocks.length >= 3 &&
    toolUseBlocks.some((toolUse) => MUTATION_OR_COMMAND_TOOLS.has(toolUse.name))
  ) {
    signals.push({
      reason: 'tool_batch_checkpoint',
      strength: 'weak',
      sourceToolName: 'tool_batch',
      detail: `${toolUseBlocks.length} tools`,
    })
  }

  return dedupeSignals(signals)
}

export function decidePhaseAwareCompact(
  params: DecidePhaseAwareCompactParams,
): PhaseAwareCompactDecision {
  if (process.env.POLE_PHASE_AWARE_COMPACT === '0') {
    return {
      shouldCompact: false,
      skippedReason: 'disabled',
      signals: [],
      estimatedTokens: params.estimatedTokens,
    }
  }

  const collected = collectPhaseAwareCompactSignals(params.toolUseBlocks)
  const degradationSignal = signalFromDegradation(params.degradation)
  const signals = degradationSignal
    ? dedupeSignals([...collected, degradationSignal])
    : collected
  const signal = signals[0]
  if (!signal) {
    return {
      shouldCompact: false,
      skippedReason: 'no_signal',
      signals,
      estimatedTokens: params.estimatedTokens,
    }
  }

  const thresholdTokens = compactThresholdForSignal(signal, params.thresholds)
  if (params.estimatedTokens < thresholdTokens) {
    return {
      shouldCompact: false,
      skippedReason: 'below_threshold',
      signals,
      estimatedTokens: params.estimatedTokens,
      thresholdTokens,
    }
  }

  if (
    params.lastPhaseAwareCompactIteration > 0 &&
    params.iteration - params.lastPhaseAwareCompactIteration <
      PHASE_AWARE_COMPACT_COOLDOWN_ITERATIONS
  ) {
    return {
      shouldCompact: false,
      skippedReason: 'cooldown',
      signals,
      estimatedTokens: params.estimatedTokens,
      thresholdTokens,
    }
  }

  if (!hasReclaimableToolResultHistory(params.messages)) {
    return {
      shouldCompact: false,
      skippedReason: 'no_reclaimable_history',
      signals,
      estimatedTokens: params.estimatedTokens,
      thresholdTokens,
    }
  }

  return {
    shouldCompact: true,
    request: {
      action: 'micro_compact',
      boundary: params.boundary,
      reason: signal.reason,
      estimatedTokens: params.estimatedTokens,
    },
    signal,
    signals,
    estimatedTokens: params.estimatedTokens,
    thresholdTokens,
  }
}

export function countToolResultGroups(
  messages: Array<Record<string, unknown>>,
): number {
  let count = 0
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    if (
      (msg.content as Array<Record<string, unknown>>).some(
        (block) => block.type === 'tool_result',
      )
    ) {
      count++
    }
  }
  return count
}

function hasReclaimableToolResultHistory(
  messages: Array<Record<string, unknown>>,
): boolean {
  return countToolResultGroups(messages) > MICRO_COMPACT_KEEP_RECENT_GROUPS
}

function signalFromTodoWrite(
  input: Record<string, unknown> | undefined,
): Omit<PhaseAwareCompactSignal, 'sourceToolName'> | null {
  const todos = Array.isArray(input?.todos)
    ? (input.todos as Array<Record<string, unknown>>)
    : []
  if (todos.length === 0) return null

  const completed = todos.filter((todo) => todo.status === 'completed').length
  const active = todos.filter(
    (todo) => todo.status === 'pending' || todo.status === 'in_progress',
  ).length
  if (completed === 0) return null

  return {
    reason: 'todo_checkpoint',
    strength: active === 0 ? 'strong' : 'medium',
    detail: `${completed} completed, ${active} active`,
  }
}

function signalFromDegradation(
  degradation: PhaseAwareDegradationSignal | undefined,
): PhaseAwareCompactSignal | null {
  if (!degradation) return null
  return {
    reason: 'degradation_checkpoint',
    strength:
      degradation.consecutiveCount >= DEGRADATION_STRONG_REPETITION_COUNT
        ? 'strong'
        : 'medium',
    sourceToolName: degradation.toolName,
    detail: `${degradation.kind}: ${degradation.consecutiveCount} consecutive identical calls`,
  }
}

function signalFromAgent(
  input: Record<string, unknown> | undefined,
): PhaseAwareCompactSignal {
  const subagentType = readString(input, 'subagent_type') || readString(input, 'subagentType')
  if (subagentType.toLowerCase() === 'verification') {
    return {
      reason: 'verification_checkpoint',
      strength: 'strong',
      sourceToolName: 'Agent',
      detail: 'Verification',
    }
  }
  return {
    reason: 'agent_checkpoint',
    strength: 'medium',
    sourceToolName: 'Agent',
    detail: subagentType || undefined,
  }
}

function toolUseLooksLikeVerification(toolUse: PhaseAwareToolUse): boolean {
  if (!['Bash', 'PowerShell', 'ReadDiagnostics', 'LSP'].includes(toolUse.name)) {
    return false
  }
  const text = Object.values(toolUse.input ?? {})
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
  return VERIFICATION_COMMAND_RE.test(text)
}

/**
 * P3.3 — Optional global threshold multiplier. upstream-aligned operator
 * knob (env `POLE_COMPACT_PERCENT`) that scales all phase-aware compact
 * thresholds at once. Default 1.0 (no change). Values < 1 make compact
 * fire EARLIER (more aggressive); values > 1 make it fire LATER (lazier).
 *
 * Typical use: production operator notices compact is firing too eagerly
 * on a 1M-window model and bumps the multiplier to 1.5 without rebuilding.
 *
 * Invalid / non-positive values fall back to 1.0.
 */
const PHASE_AWARE_COMPACT_THRESHOLD_MULTIPLIER = parsePositiveFloatEnv(
  process.env.POLE_COMPACT_PERCENT,
  1.0,
)

function parsePositiveFloatEnv(raw: string | undefined, defaultValue: number): number {
  if (!raw) return defaultValue
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue
}

function compactThresholdForSignal(
  signal: PhaseAwareCompactSignal,
  thresholds: ContextThresholds,
): number {
  let base: number
  if (signal.strength === 'strong') {
    base = finiteThreshold(thresholds.warningTokens)
  } else if (signal.strength === 'medium') {
    base = finiteThreshold(thresholds.errorTokens)
  } else {
    base = finiteThreshold(thresholds.historySnipTokens)
  }
  // Operator-tunable scaling (P3.3). Skip the multiply on Infinity so
  // an undefined threshold stays undefined.
  return Number.isFinite(base)
    ? base * PHASE_AWARE_COMPACT_THRESHOLD_MULTIPLIER
    : base
}

function finiteThreshold(value: number): number {
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
}

function dedupeSignals(signals: PhaseAwareCompactSignal[]): PhaseAwareCompactSignal[] {
  const byReason = new Map<PhaseAwareCompactReason, PhaseAwareCompactSignal>()
  for (const signal of signals) {
    const existing = byReason.get(signal.reason)
    if (
      !existing ||
      STRENGTH_RANK[signal.strength] > STRENGTH_RANK[existing.strength]
    ) {
      byReason.set(signal.reason, signal)
    }
  }
  return [...byReason.values()].sort((a, b) => {
    const rank = STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength]
    if (rank !== 0) return rank
    return a.reason.localeCompare(b.reason)
  })
}

function readString(
  input: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = input?.[key]
  return typeof value === 'string' ? value.trim() : ''
}
