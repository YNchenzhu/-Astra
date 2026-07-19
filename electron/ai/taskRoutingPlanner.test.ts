import { describe, expect, it } from 'vitest'
import { analyzeTaskRouting, formatTaskRoutingSystemBlock } from './taskRoutingPlanner'

describe('analyzeTaskRouting', () => {
  it('detects trivial Q&A and discourages Agent', () => {
    const p = analyzeTaskRouting('What is a closure?', {
      sessionAgentType: 'general-purpose',
      enableTools: true,
    })
    expect(p.taskKind).toBe('trivial_qa')
    expect(p.discourageNestedAgent).toBe(true)
  })

  it('detects implementation and requires verification', () => {
    const p = analyzeTaskRouting('Implement user login with JWT in src/auth/', {
      sessionAgentType: 'general-purpose',
      enableTools: true,
    })
    expect(p.taskKind).toBe('implement')
    expect(p.requireVerificationBeforeDone).toBe(true)
    expect(p.suggestedSubagentSequence.some((s) => s.type === 'Verification')).toBe(true)
  })

  it('suggests Coordinator for multi-item work', () => {
    const p = analyzeTaskRouting(
      '- fix login\n- add tests\n- update docs',
      { sessionAgentType: 'general-purpose', enableTools: true },
    )
    expect(p.taskKind).toBe('multi_stream')
    expect(p.recommendedSessionAgent).toBe('Coordinator')
  })

  it('returns empty guidance when tools disabled', () => {
    const p = analyzeTaskRouting('anything', { sessionAgentType: 'general-purpose', enableTools: false })
    const block = formatTaskRoutingSystemBlock(p, 'general-purpose')
    expect(block).toBe('')
  })

  it('does not recommend switching session when already Coordinator', () => {
    const p = analyzeTaskRouting('- a\n- b', { sessionAgentType: 'Coordinator', enableTools: true })
    expect(p.recommendedSessionAgent).toBeNull()
  })
})

describe('formatTaskRoutingSystemBlock', () => {
  it('includes delivery gate when verification required', () => {
    const p = analyzeTaskRouting('fix the bug in parser', {
      sessionAgentType: 'general-purpose',
      enableTools: true,
    })
    const block = formatTaskRoutingSystemBlock(p, 'general-purpose')
    expect(block).toContain('Delivery gate')
    expect(block).toContain('Verification')
  })
})
