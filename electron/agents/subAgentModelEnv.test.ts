import { describe, it, expect, afterEach } from 'vitest'
import { mergeEnvTaskBudgetIntoAgentDef, resolveSubAgentModelFromEnv } from './subAgentModelEnv'
import type { BuiltInAgentDefinition } from './types'
import { GENERAL_PURPOSE_AGENT } from './builtInAgents'

describe('subAgentModelEnv (§7.10–7.11)', () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    delete process.env.ASTRA_SUBAGENT_MODEL
    delete process.env.CLAUDE_CODE_TASK_BUDGET
    delete process.env.ASTRA_TASK_BUDGET_TOKENS
  })

  it('resolveSubAgentModelFromEnv prefers CLAUDE_CODE_SUBAGENT_MODEL', () => {
    process.env.ASTRA_SUBAGENT_MODEL = 'm1'
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'm2'
    expect(resolveSubAgentModelFromEnv()).toBe('m2')
  })

  it('mergeEnvTaskBudgetIntoAgentDef fills maxTokenBudget when unset', () => {
    process.env.CLAUDE_CODE_TASK_BUDGET = '500000'
    const def: BuiltInAgentDefinition = { ...GENERAL_PURPOSE_AGENT }
    const merged = mergeEnvTaskBudgetIntoAgentDef(def)
    expect(merged.maxTokenBudget).toBe(500000)
  })

  it('mergeEnvTaskBudgetIntoAgentDef keeps explicit agent maxTokenBudget', () => {
    process.env.CLAUDE_CODE_TASK_BUDGET = '999'
    const def: BuiltInAgentDefinition = { ...GENERAL_PURPOSE_AGENT, maxTokenBudget: 12 }
    const merged = mergeEnvTaskBudgetIntoAgentDef(def)
    expect(merged.maxTokenBudget).toBe(12)
  })
})
