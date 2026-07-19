/**
 * Coordinator workflow scaffolding — phased fan-out with injectable task execution.
 *
 * Also exposes upstream-style coordinator session helpers from
 * `restored-src/src/coordinator/coordinatorMode.ts`: environment toggle, resumed-session mode
 * matching, injectable **worker tool surface** context, and the long coordinator system prompt
 * body ({@link getCoordinatorSystemPromptForBuiltinAgent}).
 *
 * Wires to TeamCreate: call {@link noteCoordinatorLead} after spawning a coordinator-bound team
 * so the lead id is tracked in the TeamFile member list.
 *
 * **Runtime note:** Production chat flows are model-driven (Agent tool + optional
 * {@link evaluatePreAgentSpawn} strict gates). {@link runCoordinatorWorkflow} is the reusable
 * engine for callers that explicitly schedule phased tasks (tests, future coordinator IPC, or
 * internal orchestrators); it is not auto-invoked on every send-message.
 */

import type { CoordinatorPhase, SubAgentResult } from './types'
import { ASYNC_AGENT_ALLOWED_TOOLS } from './types'
import { ensureTeamMember } from '../tools/TeamCreateTool'
import { asAgentId } from '../tools/ids'
import {
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  registryPrimaryToolName,
  SEND_MESSAGE_TOOL_NAME,
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  TASK_OUTPUT_TOOL_NAME,
} from '../tools/builtinToolAliases'
import { renderCoordinatorSystemPrompt } from './coordinatorSystemPrompt'
import { isOrchestrationStrictMode } from '../orchestration/config'

function isEnvTruthy(v: string | undefined): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes'
}

/** Primary env flag; `CLAUDE_CODE_COORDINATOR_MODE` accepted for upstream parity. */
const COORDINATOR_MODE_ENV_KEYS = ['ASTRA_COORDINATOR_MODE', 'CLAUDE_CODE_COORDINATOR_MODE'] as const

/** When set, coordinator user-context lists only Bash + Read + Edit (+ MCP). */
const COORDINATOR_SIMPLE_ENV_KEYS = ['ASTRA_COORDINATOR_SIMPLE', 'CLAUDE_CODE_SIMPLE'] as const

/** Env override for the coordinator failure policy surfaced to the model-driven coordinator. */
const COORDINATOR_FAILURE_POLICY_ENV_KEY = 'ASTRA_COORDINATOR_FAILURE_POLICY'

/**
 * Tools sub-agents use for coordination / mailbox — excluded from the **worker capability** list
 * shown to the coordinator (upstream `INTERNAL_WORKER_TOOLS` analogue).
 */
export const INTERNAL_COORDINATOR_ORCHESTRATION_TOOLS = new Set<string>([
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  TASK_OUTPUT_TOOL_NAME,
])

export function isCoordinatorModeEnvEnabled(): boolean {
  for (const k of COORDINATOR_MODE_ENV_KEYS) {
    if (isEnvTruthy(process.env[k])) return true
  }
  return false
}

function isCoordinatorSimpleToolSurfaceEnv(): boolean {
  for (const k of COORDINATOR_SIMPLE_ENV_KEYS) {
    if (isEnvTruthy(process.env[k])) return true
  }
  return false
}

/**
 * Align process env with a resumed session’s stored coordinator vs normal mode.
 * Returns a short user-facing notice when the env was flipped, else `undefined`.
 */
export function matchSessionCoordinatorMode(
  sessionMode: 'coordinator' | 'normal' | undefined,
): string | undefined {
  if (!sessionMode) return undefined
  const current = isCoordinatorModeEnvEnabled()
  const wantCoordinator = sessionMode === 'coordinator'
  if (current === wantCoordinator) return undefined

  if (wantCoordinator) {
    process.env.ASTRA_COORDINATOR_MODE = '1'
  } else {
    delete process.env.ASTRA_COORDINATOR_MODE
    delete process.env.CLAUDE_CODE_COORDINATOR_MODE
  }

  return wantCoordinator
    ? 'Entered coordinator mode to match resumed session.'
    : 'Exited coordinator mode to match resumed session.'
}

function formatWorkerToolListString(): string {
  if (isCoordinatorSimpleToolSurfaceEnv()) {
    return [BASH_TOOL_NAME, READ_TOOL_NAME, EDIT_TOOL_NAME].sort().join(', ')
  }
  const canon = new Set<string>()
  for (const raw of ASYNC_AGENT_ALLOWED_TOOLS) {
    const p = registryPrimaryToolName(raw)
    if (INTERNAL_COORDINATOR_ORCHESTRATION_TOOLS.has(p)) continue
    canon.add(p)
  }
  return [...canon].sort().join(', ')
}

export function describeWorkerCapabilitiesParagraph(): string {
  return isCoordinatorSimpleToolSurfaceEnv()
    ? 'Sub-agents have access to Bash, Read, and Edit tools, plus MCP tools from configured MCP servers.'
    : 'Sub-agents have access to standard tools (see the enumerated list below), MCP tools from configured MCP servers, and project skills via the Skill tool. Delegate skill-style workflows (e.g. heavy verification) to sub-agents when appropriate.'
}

/**
 * Extra system/user-context key/value pairs for coordinator sessions (upstream `getCoordinatorUserContext`).
 * When `scratchpadDir` is set, documents a durable scratch workspace for cross-sub-agent notes.
 */
export function getCoordinatorUserContext(
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
): Record<string, string> {
  const workerTools = formatWorkerToolListString()
  let content = `Sub-agents spawned via the Agent tool have access to these tools: ${workerTools}`

  if (mcpClients.length > 0) {
    const serverNames = mcpClients.map((c) => c.name.trim()).filter(Boolean).join(', ')
    if (serverNames) {
      content += `\n\nThey also receive MCP tools from connected MCP servers: ${serverNames}`
    }
  }

  const sp = scratchpadDir?.trim()
  if (sp) {
    content += `\n\nScratchpad directory: ${sp}\nSub-agents can read and write here without extra prompts when policy allows — use it for durable cross-sub-agent knowledge.`
  }

  return { workerToolsContext: content }
}

/**
 * Read the coordinator failure policy from env (parity with the rest of the env-driven coordinator
 * config in this module). Returns undefined when unset or invalid — the caller decides whether to
 * fall back to its own default.
 */
export function getCoordinatorFailurePolicyFromEnv(): CoordinatorFailurePolicy | undefined {
  const raw = process.env[COORDINATOR_FAILURE_POLICY_ENV_KEY]?.trim().toLowerCase()
  if (raw === 'abort' || raw === 'continue' || raw === 'retry') return raw
  return undefined
}

/**
 * Full coordinator role prompt (built-in Coordinator agent + main session when agentType is Coordinator).
 *
 * When a failure policy is provided (or {@link getCoordinatorFailurePolicyFromEnv} returns one),
 * the relevant paragraph is injected so the model-driven coordinator stays consistent with the
 * program-driven {@link runCoordinatorWorkflow} semantics.
 *
 * Phase-ordering text is wired to {@link isOrchestrationStrictMode}: when strict mode is OFF,
 * the prompt explicitly states that phase ordering is advisory, matching the actual runtime
 * behavior of {@link evaluatePreAgentSpawn} (which short-circuits to allow when not strict).
 */
export function getCoordinatorSystemPromptForBuiltinAgent(
  failurePolicy?: CoordinatorFailurePolicy,
): string {
  const policy = failurePolicy ?? getCoordinatorFailurePolicyFromEnv()
  return renderCoordinatorSystemPrompt(describeWorkerCapabilitiesParagraph(), {
    strictPhaseOrdering: isOrchestrationStrictMode(),
    ...(policy ? { failurePolicy: policy } : {}),
  })
}

export type CoordinatorFailurePolicy = 'abort' | 'continue' | 'retry'

/**
 * P0-3 — fine-grained retry policy used when {@link CoordinatorConfig.failurePolicy}
 * is `'retry'`. When omitted, the legacy default `{ maxAttempts: 2 }` (i.e. one
 * extra attempt, no backoff) is used so existing callers keep working.
 *
 * `nonRetryableErrors` is matched against `SubAgentResult.output` — a string
 * entry uses substring match, a RegExp uses `.test`. Matching errors skip
 * the retry path and surface immediately.
 */
export interface RetryPolicy {
  /** Total attempts including the first call. Must be ≥ 1. */
  maxAttempts: number
  /** Wait before the first retry. Default 0. */
  initialBackoffMs?: number
  /** Multiplier applied to the previous wait. Default 2 (exponential). */
  backoffMultiplier?: number
  /** Errors that should NOT be retried (matched against `result.output`). */
  nonRetryableErrors?: Array<string | RegExp>
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  initialBackoffMs: 0,
  backoffMultiplier: 2,
}

/**
 * P1-5 — workflow-level budget guard. Tokens and wall-clock are tracked
 * across all tasks; crossing `warnAtFraction` flips `state.budgetWarning`
 * (executors can poll `state.budgetWarning` and instruct downstream agents
 * to wrap up). Crossing the hard limit terminates the workflow with an
 * error pushed to `state.errors`.
 *
 * USD-cost budgets are deferred: they require a per-model pricing registry
 * (model → $/1K tokens lookup) that doesn't exist at this layer yet. Token
 * and wall-clock budgets (above) provide practical guardrails in the meantime.
 */
export interface WorkflowBudget {
  /** Cumulative input+output tokens cap across every task. */
  maxTotalTokens?: number
  /** Wall-clock cap measured from `runCoordinatorWorkflow` entry. */
  maxWallClockMs?: number
  /** Fraction (0–1) at which `state.budgetWarning` is flipped. Default 0.8. */
  warnAtFraction?: number
}

export interface CoordinatorConfig {
  /** Ordered phases to run; empty uses default research → verification. */
  phases: CoordinatorPhase[]
  /** Max parallel {@link CoordinatorTaskExecutor} calls per phase. */
  maxParallelAgents: number
  failurePolicy: CoordinatorFailurePolicy
  /** Optional fine-grained retry config (active when failurePolicy='retry'). */
  retryPolicy?: RetryPolicy
  /** Optional workflow-level budget guard. */
  budget?: WorkflowBudget
  /**
   * Max times any single phase may be entered. Guards against infinite loops
   * when {@link CoordinatorCommand.goto} cycles. Default 5.
   */
  maxPhaseVisits?: number
}

/**
 * P1-4 — LangGraph-style command produced by an executor to influence next
 * step routing. `goto` jumps to a phase (or `'end'` terminates); `spawn`
 * appends new tasks to the workflow queue; `update` merges into
 * {@link CoordinatorState.sharedState}; `invalidateCompleted` clears the
 * completed-set for the listed phases so their already-finished tasks are
 * eligible to run again on a goto loop (without callers having to manually
 * `spawn` duplicates of every task they want re-executed).
 */
export interface CoordinatorCommand {
  goto?: CoordinatorPhase | 'end'
  spawn?: CoordinatorTask[]
  update?: Record<string, unknown>
  /**
   * Phases whose previously-completed tasks should be marked re-runnable.
   * Combined with `goto`, this gives "super-graph backtracking" semantics:
   * the workflow can loop a section of the DAG without manual respawning.
   *
   * Note: this only un-completes tasks; `spawn`-added tasks are already
   * tracked separately and don't need invalidation.
   */
  invalidateCompleted?: CoordinatorPhase[]
}

export interface CoordinatorTaskOutcome {
  result: SubAgentResult
  command?: CoordinatorCommand
}

export interface CoordinatorState {
  currentPhase: CoordinatorPhase | null
  phaseResults: Map<CoordinatorPhase, SubAgentResult[]>
  pendingTaskIds: string[]
  completedTaskIds: string[]
  errors: string[]
  /** P1-4 — accumulated cross-task data set via {@link CoordinatorCommand.update}. */
  sharedState: Record<string, unknown>
  /** P1-4 — phase entry counter for loop detection. */
  phaseVisits: Map<CoordinatorPhase, number>
  /** P1-5 — set when budget warn threshold has been crossed. */
  budgetWarning: boolean
  /** P1-5 — running total of tokens consumed by tasks reported via SubAgentResult. */
  totalTokens: number
  /** P1-5 — wall-clock (ms) since workflow entry. */
  totalDurationMs: number
}

export interface CoordinatorTask {
  id: string
  phase: CoordinatorPhase
  /** Short label for logs / UI */
  label: string
  prompt: string
  subagentType?: string
  /** P0-3 — per-task override of the workflow-wide retry policy. */
  retryPolicy?: RetryPolicy
}

/**
 * Executor return type — accepts either a bare `SubAgentResult` (legacy) or
 * a `CoordinatorTaskOutcome` wrapping the result with an optional command.
 * The wrapped form is detected by the presence of a `.result` property.
 */
export type CoordinatorTaskExecutor = (
  task: CoordinatorTask,
) => Promise<SubAgentResult | CoordinatorTaskOutcome>

const DEFAULT_PHASES: CoordinatorPhase[] = [
  'research',
  'synthesis',
  'implementation',
  'verification',
]

const DEFAULT_MAX_PHASE_VISITS = 5
const DEFAULT_BUDGET_WARN_FRACTION = 0.8

/**
 * Register the coordinator agent id as a team member (durable TeamFile).
 */
export function noteCoordinatorLead(teamName: string, coordinatorAgentId: string): void {
  void ensureTeamMember(teamName, asAgentId(coordinatorAgentId)).catch((e) =>
    console.warn('[Coordinator] ensureTeamMember failed:', e),
  )
}

function isWrappedOutcome(
  v: SubAgentResult | CoordinatorTaskOutcome,
): v is CoordinatorTaskOutcome {
  return (
    typeof v === 'object' &&
    v !== null &&
    'result' in v &&
    typeof (v as CoordinatorTaskOutcome).result === 'object'
  )
}

function matchesNonRetryable(
  output: string,
  patterns: Array<string | RegExp> | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false
  for (const p of patterns) {
    if (typeof p === 'string') {
      if (output.includes(p)) return true
    } else if (p.test(output)) {
      return true
    }
  }
  return false
}

/**
 * Run tasks grouped by phase. Execution is delegated to `execute` (e.g. wrap `runSubAgent`).
 *
 * Failure policy semantics:
 * - **abort**: first failed result stops the workflow (remaining tasks skipped).
 * - **continue**: failures become error strings; later phases still run.
 * - **retry**: each failure retried per {@link CoordinatorConfig.retryPolicy} (or default
 *   {@link DEFAULT_RETRY_POLICY} = 1 extra attempt, no backoff). Per-task override via
 *   {@link CoordinatorTask.retryPolicy}.
 *
 * Routing extensions (P1-4): if the executor returns a {@link CoordinatorTaskOutcome}
 * with `command.goto`, the next-phase pointer jumps to that phase after the current
 * phase finishes (loop-guarded by {@link CoordinatorConfig.maxPhaseVisits}).
 *
 * Budget guard (P1-5): {@link CoordinatorConfig.budget} stops the workflow when
 * cumulative tokens or wall-clock crosses its hard limit, and flips
 * `state.budgetWarning` at the warn fraction.
 */
export async function runCoordinatorWorkflow(
  config: CoordinatorConfig,
  tasks: CoordinatorTask[],
  execute: CoordinatorTaskExecutor,
): Promise<CoordinatorState> {
  const phaseOrder = config.phases.length > 0 ? config.phases : DEFAULT_PHASES
  const maxP = Math.max(1, config.maxParallelAgents)
  const maxPhaseVisits = Math.max(1, config.maxPhaseVisits ?? DEFAULT_MAX_PHASE_VISITS)
  const startedAt = Date.now()
  const warnFrac = config.budget?.warnAtFraction ?? DEFAULT_BUDGET_WARN_FRACTION

  // Live, mutable working set so `command.spawn` can append new tasks at runtime.
  const workingTasks: CoordinatorTask[] = [...tasks]

  const state: CoordinatorState = {
    currentPhase: null,
    phaseResults: new Map(),
    pendingTaskIds: workingTasks.map((t) => t.id),
    completedTaskIds: [],
    errors: [],
    sharedState: {},
    phaseVisits: new Map(),
    budgetWarning: false,
    totalTokens: 0,
    totalDurationMs: 0,
  }

  /** Returns true when budget guard says workflow MUST stop (hard limit hit). */
  const updateBudgetAndCheckStop = (): boolean => {
    state.totalDurationMs = Date.now() - startedAt
    const b = config.budget
    if (!b) return false

    if (b.maxTotalTokens !== undefined) {
      if (state.totalTokens >= b.maxTotalTokens) {
        state.errors.push(
          `workflow_budget_exceeded:tokens (used ${state.totalTokens}/${b.maxTotalTokens})`,
        )
        return true
      }
      if (state.totalTokens >= b.maxTotalTokens * warnFrac) {
        state.budgetWarning = true
      }
    }
    if (b.maxWallClockMs !== undefined) {
      if (state.totalDurationMs >= b.maxWallClockMs) {
        state.errors.push(
          `workflow_budget_exceeded:wallClock (used ${state.totalDurationMs}/${b.maxWallClockMs}ms)`,
        )
        return true
      }
      if (state.totalDurationMs >= b.maxWallClockMs * warnFrac) {
        state.budgetWarning = true
      }
    }
    return false
  }

  const resolveRetryPolicy = (
    task: CoordinatorTask,
  ): Required<Pick<RetryPolicy, 'maxAttempts' | 'initialBackoffMs' | 'backoffMultiplier'>> &
    Pick<RetryPolicy, 'nonRetryableErrors'> => {
    const src: RetryPolicy = task.retryPolicy ?? config.retryPolicy ?? DEFAULT_RETRY_POLICY
    return {
      maxAttempts: Math.max(1, src.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts ?? 2),
      initialBackoffMs: src.initialBackoffMs ?? DEFAULT_RETRY_POLICY.initialBackoffMs ?? 0,
      backoffMultiplier: src.backoffMultiplier ?? DEFAULT_RETRY_POLICY.backoffMultiplier ?? 2,
      ...(src.nonRetryableErrors ? { nonRetryableErrors: src.nonRetryableErrors } : {}),
    }
  }

  /** Run a single task with full retry + outcome-unwrapping plumbing. */
  const runOne = async (task: CoordinatorTask): Promise<CoordinatorTaskOutcome> => {
    const policy = resolveRetryPolicy(task)
    let lastOutcome: CoordinatorTaskOutcome | undefined
    let backoff = policy.initialBackoffMs

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      const raw = await execute(task)
      const outcome: CoordinatorTaskOutcome = isWrappedOutcome(raw)
        ? raw
        : { result: raw }
      lastOutcome = outcome

      if (outcome.result.success) return outcome
      if (config.failurePolicy !== 'retry') return outcome
      if (attempt >= policy.maxAttempts) return outcome
      if (matchesNonRetryable(outcome.result.output ?? '', policy.nonRetryableErrors)) {
        return outcome
      }

      if (backoff > 0) {
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.round(backoff * policy.backoffMultiplier)
      }
    }
    // Defensive — loop above always returns; this satisfies TS narrowing.
    return lastOutcome ?? { result: { success: false, agentId: asAgentId(task.id), agentType: task.subagentType ?? 'unknown', output: 'no_attempts', totalTokens: 0, totalDurationMs: 0, totalToolUses: 0 } }
  }

  // ===== Phase loop with goto support =====
  // We index into `phaseOrder` but allow `command.goto` to override the next pointer.

  let phaseIdx = 0

  while (phaseIdx < phaseOrder.length) {
    const phase = phaseOrder[phaseIdx]
    const visits = (state.phaseVisits.get(phase) ?? 0) + 1
    state.phaseVisits.set(phase, visits)
    if (visits > maxPhaseVisits) {
      state.errors.push(`phase_visit_limit_exceeded:${phase} (>${maxPhaseVisits})`)
      break
    }

    state.currentPhase = phase
    const phaseTasks = workingTasks.filter(
      (t) => t.phase === phase && !state.completedTaskIds.includes(t.id),
    )
    if (phaseTasks.length === 0) {
      phaseIdx++
      continue
    }

    const batchResults: SubAgentResult[] = []
    let nextPhaseIdx: number | undefined  // set by command.goto
    let stopWorkflow = false  // set by command.goto='end' or budget hit

    for (let i = 0; i < phaseTasks.length; i += maxP) {
      const chunk = phaseTasks.slice(i, i + maxP)
      const chunkOut = await Promise.all(chunk.map((task) => runOne(task)))

      for (let j = 0; j < chunk.length; j++) {
        const task = chunk[j]
        const outcome = chunkOut[j]
        const res = outcome.result
        state.pendingTaskIds = state.pendingTaskIds.filter((id) => id !== task.id)
        if (res.success) {
          state.completedTaskIds.push(task.id)
        } else {
          state.errors.push(`${task.id}: ${res.output || 'failed'}`)
        }
        batchResults.push(res)
        state.totalTokens += res.totalTokens || 0

        // Apply command extensions (P1-4)
        if (outcome.command) {
          if (outcome.command.update) {
            Object.assign(state.sharedState, outcome.command.update)
          }
          if (outcome.command.spawn?.length) {
            for (const newTask of outcome.command.spawn) {
              workingTasks.push(newTask)
              state.pendingTaskIds.push(newTask.id)
            }
          }
          if (outcome.command.invalidateCompleted?.length) {
            // P1-4 ext — clear completed flags for the listed phases so a
            // subsequent goto loops re-runs their tasks. Pairs with goto;
            // applied to the current phase has no effect on the in-progress
            // batch (phaseTasks is snapshotted at line 485) — only on the
            // next entry. Unknown phases are flagged for visibility.
            const phasesToReset = new Set(outcome.command.invalidateCompleted)
            for (const ph of phasesToReset) {
              if (!phaseOrder.includes(ph)) {
                state.errors.push(
                  `coordinator_command_invalidate_unknown_phase:${ph}`,
                )
              }
            }
            const idsToReset = new Set(
              workingTasks
                .filter((t) => phasesToReset.has(t.phase))
                .map((t) => t.id),
            )
            if (idsToReset.size > 0) {
              state.completedTaskIds = state.completedTaskIds.filter(
                (id) => !idsToReset.has(id),
              )
            }
          }
          if (outcome.command.goto) {
            if (outcome.command.goto === 'end') {
              stopWorkflow = true
            } else {
              const targetIdx = phaseOrder.indexOf(outcome.command.goto)
              if (targetIdx >= 0) {
                nextPhaseIdx = targetIdx
              } else {
                state.errors.push(
                  `coordinator_command_goto_unknown_phase:${outcome.command.goto}`,
                )
              }
            }
          }
        }
      }

      // Budget hard-stop check after each chunk
      if (updateBudgetAndCheckStop()) {
        stopWorkflow = true
        break
      }

      if (config.failurePolicy === 'abort' && chunkOut.some((o) => !o.result.success)) {
        state.phaseResults.set(phase, batchResults)
        state.currentPhase = null
        return state
      }
    }

    state.phaseResults.set(phase, batchResults)

    if (stopWorkflow) break
    phaseIdx = nextPhaseIdx !== undefined ? nextPhaseIdx : phaseIdx + 1
  }

  state.currentPhase = null
  return state
}

/** Minimal allowlist reminder (default extended surface; strict env → upstream core four only). */
export const COORDINATOR_WORKFLOW_TOOL_HINT =
  'Coordinator agents should stay on the orchestration surface: Agent, SendMessage, TaskStop, TaskOutput (SyntheticOutput analogue), plus optional TeamStatus/Read/Grep/Glob unless ASTRA_COORDINATOR_STRICT_OC_TOOLS=1.'
