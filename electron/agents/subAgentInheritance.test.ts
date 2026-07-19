import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentContext } from './agentContext'
import { resolveInheritedTaskBudgetMs } from './subAgentInheritance'
import * as registry from './activeAgentRegistry'

describe('resolveInheritedTaskBudgetMs (§7.5)', () => {
  beforeEach(() => {
    vi.spyOn(registry, 'getActiveAgent').mockReturnValue(undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns parent ALS taskBudgetMs when set', () => {
    const parent = { taskBudgetMs: 99_000 } as AgentContext
    expect(resolveInheritedTaskBudgetMs(parent)).toBe(99_000)
  })

  it('falls back to active parent agent timeout', () => {
    vi.spyOn(registry, 'getActiveAgent').mockReturnValue({
      agentDef: { timeout: 120_000 },
    } as ReturnType<typeof registry.getActiveAgent>)
    const parent = { agentId: 'agent-1' } as AgentContext
    expect(resolveInheritedTaskBudgetMs(parent)).toBe(120_000)
  })

  it('returns undefined for main / missing parent', () => {
    expect(resolveInheritedTaskBudgetMs({ agentId: 'main' } as AgentContext)).toBeUndefined()
    expect(resolveInheritedTaskBudgetMs(null)).toBeUndefined()
  })
})
