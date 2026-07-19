/**
 * upstream §7.10–7.11: global env overrides for sub-agent model and task budget.
 */

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const t = raw.trim()
  if (!t) return undefined
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}

/** Highest priority: dedicated sub-agent model env, then generic override. */
export function resolveSubAgentModelFromEnv(): string | undefined {
  const a = process.env.CLAUDE_CODE_SUBAGENT_MODEL?.trim()
  if (a) return a
  const b = process.env.ASTRA_SUBAGENT_MODEL?.trim()
  if (b) return b
  return undefined
}

/**
 * Merge env task budget into definition when `maxTokenBudget` is unset (upstream-style global default).
 */
export function mergeEnvTaskBudgetIntoAgentDef<T extends { maxTokenBudget?: number }>(def: T): T {
  const fromEnv =
    parsePositiveInt(process.env.CLAUDE_CODE_TASK_BUDGET) ??
    parsePositiveInt(process.env.ASTRA_TASK_BUDGET_TOKENS)
  if (fromEnv === undefined) return def
  if (def.maxTokenBudget !== undefined && def.maxTokenBudget > 0) return def
  return { ...def, maxTokenBudget: fromEnv }
}
