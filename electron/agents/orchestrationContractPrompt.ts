/**
 * Auto-derived "Orchestration Contract" appendix for sub-agent system
 * prompts (Path A from the agent-workbench review).
 *
 * Imported industry bundle agents (法律 / 医疗 / 售前 / …) are authored as
 * pure persona prompts — Role / Strengths / Guidelines / Constraints /
 * Report format. Built-in agents (Explore / Plan / Coordinator / …)
 * additionally hand-write orchestration directives:
 *
 *   - "you are a worker, not a coordinator — do NOT use SendMessage"
 *   - "READ-ONLY MODE — no Edit/Write/state-changing Bash"
 *   - "max 150 iterations, MUST stop and finalize"
 *   - "your final reply must start with VERDICT:"
 *
 * Bundle authors don't know to write those — and they shouldn't have
 * to. This module derives the directives from existing AgentDefinition
 * metadata (`isReadOnly` / `coordinatorPhase` / `maxTurns` / tools list)
 * and an explicit `orchestrationRole` field, then formats them as a
 * compact contract block appended to the user-authored persona.
 *
 * Built-in agents are skipped — their prompts already say all this and
 * adding it again would just bloat tokens.
 *
 * Opt-out: set `POLE_AUTO_ORCHESTRATION_CONTRACT=0`.
 */

import type {
  AgentDefinitionUnion,
  CoordinatorPhase,
  OrchestrationRole,
} from './types'

/**
 * The runtime tools surface usually contains both canonical names
 * (`'SendMessage'`) and snake_case aliases (`'send_message'`). The
 * caller normally hands us the canonical names from
 * `resolveAgentTools()`. We lower-case + strip non-alphanumerics
 * inside this module so checks like "has SendMessage" tolerate
 * both casings without the caller worrying about it.
 */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const SPAWN_TOOL_KEYS = new Set([
  normalizeToolName('Agent'),
  normalizeToolName('Task'),
  normalizeToolName('Spawn'),
])

const MESSAGE_TOOL_KEYS = new Set([
  normalizeToolName('SendMessage'),
  normalizeToolName('TeamCreate'),
])

const WRITE_TOOL_KEYS = new Set([
  normalizeToolName('Edit'),
  normalizeToolName('Write'),
  normalizeToolName('MultiEdit'),
])

export interface OrchestrationContractInput {
  /** AgentDefinition discriminated source — built-ins are skipped. */
  source?: AgentDefinitionUnion['source'] | undefined
  /** Explicit role (Workbench Path B). When unset, role is inferred. */
  orchestrationRole?: OrchestrationRole | undefined
  isReadOnly?: boolean
  coordinatorPhase?: CoordinatorPhase
  maxTurns?: number
  /** Names of tools actually available at runtime (canonical or snake_case). */
  toolNames: string[]
}

/**
 * Decide an effective role from explicit declaration + metadata signals.
 * Mirrors the priorities the user would pick manually:
 *   1. explicit `orchestrationRole`
 *   2. `coordinatorPhase: 'verification'` → verifier
 *   3. spawn-style tools without write tools → coordinator
 *   4. `isReadOnly: true` → readonly-worker
 *   5. otherwise → writing-worker
 */
export function inferOrchestrationRole(
  input: OrchestrationContractInput,
): OrchestrationRole {
  if (input.orchestrationRole) return input.orchestrationRole
  if (input.coordinatorPhase === 'verification') return 'verifier'

  const toolKeys = new Set(input.toolNames.map(normalizeToolName))
  const hasSpawn = [...SPAWN_TOOL_KEYS].some((k) => toolKeys.has(k))
  const hasWrite = [...WRITE_TOOL_KEYS].some((k) => toolKeys.has(k))
  if (hasSpawn && !hasWrite) return 'coordinator'
  if (input.isReadOnly === true) return 'readonly-worker'
  return 'writing-worker'
}

/**
 * Build the orchestration-contract appendix. Returns an empty string
 * when nothing should be injected (built-in source, env opt-out, or
 * `solo` role) so callers can blindly concatenate.
 *
 * Pure function — no side effects, no IO, no globals (besides one
 * `process.env` read for the opt-out flag).
 */
export function buildOrchestrationContractAppend(
  input: OrchestrationContractInput,
): string {
  if (process.env.POLE_AUTO_ORCHESTRATION_CONTRACT === '0') return ''
  if (input.source === 'built-in') return ''
  if (input.orchestrationRole === 'solo') return ''

  const role = inferOrchestrationRole(input)
  const toolKeys = new Set(input.toolNames.map(normalizeToolName))
  const hasSpawnTool = [...SPAWN_TOOL_KEYS].some((k) => toolKeys.has(k))
  const hasMessageTool = [...MESSAGE_TOOL_KEYS].some((k) => toolKeys.has(k))

  const bullets: string[] = []

  switch (role) {
    case 'coordinator':
      bullets.push(
        'You are a **Coordinator**: delegate work via the `Agent` tool. Do not execute the work yourself — keep your own actions to routing, decomposition, and synthesis. Worker results come back through the parent loop; aggregate them in your final reply.',
      )
      break
    case 'verifier':
      bullets.push(
        'You are a **Verifier** in the pipeline. READ-ONLY: do not Edit/Write/run state-changing Bash. Your final reply MUST start with `VERDICT: PASS` or `VERDICT: FAIL`, followed by the evidence (one section per check).',
      )
      break
    case 'readonly-worker':
      bullets.push(
        'You are a **Read-only Worker**. Discovery / analysis only — do not Edit/Write or run state-changing commands. The parent reads your final assistant text as the deliverable.',
      )
      break
    case 'writing-worker':
      bullets.push(
        'You are a **Writing Worker**: you may Edit/Write and run state-changing tools when justified. You are NOT a coordinator — perform the work directly and report the result; do not delegate.',
      )
      break
  }

  if (input.coordinatorPhase) {
    bullets.push(
      `Pipeline phase: \`${input.coordinatorPhase}\`. Your output is consumed by downstream phases.`,
    )
  }

  // Tool-surface discipline. We only nudge when the surface contradicts
  // the role; matching surfaces stay silent (otherwise every coordinator
  // would carry a "yes you have Agent" line which adds no signal).
  if (role !== 'coordinator' && (hasSpawnTool || hasMessageTool)) {
    bullets.push(
      'Although you have access to spawn / messaging tools (Agent / SendMessage / TeamCreate), prefer doing the work directly. Use them only when the parent explicitly asks for delegation.',
    )
  } else if (role !== 'coordinator' && !hasSpawnTool && !hasMessageTool) {
    bullets.push(
      'Do NOT use `SendMessage` or `TeamCreate` — you are a worker, not a coordinator. The parent reads your normal assistant text; never try to "reply" via mailbox tools.',
    )
  }

  // Read-only enforcement (covers the case where role is writing-worker
  // but isReadOnly was set explicitly — honor the field).
  if (
    input.isReadOnly === true &&
    role !== 'readonly-worker' &&
    role !== 'verifier'
  ) {
    bullets.push(
      'Configured READ-ONLY: do not Edit/Write or run state-changing Bash. Discovery and analysis only.',
    )
  }

  // Iteration budget — surface only when meaningful (>0). The number is
  // already enforced by the runner; this just makes the model aware so
  // it can pace itself instead of getting cut off mid-search.
  if (typeof input.maxTurns === 'number' && input.maxTurns > 0) {
    // 2026-07 quality uplift: the budget is a ceiling, not a target. The
    // previous "compile your report well before that limit" wording made
    // models treat a fraction of the budget as the finish line and cut
    // coverage short on large tasks.
    bullets.push(
      `Iteration budget: max **${input.maxTurns}** turns. This is a hard ceiling, not a target — using most of it on a genuinely large task is normal. Do not cut coverage short to finish early; just track your remaining turns and reserve enough at the end to compile your final report instead of getting cut off mid-search.`,
    )
  }

  if (bullets.length === 0) return ''
  return `\n\n## Orchestration Contract\n\n${bullets.map((b) => `- ${b}`).join('\n')}`
}
