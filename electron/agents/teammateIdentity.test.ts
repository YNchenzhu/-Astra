import { describe, expect, it } from 'vitest'
import {
  buildTeammateRuntimeContext,
  isTeamLead,
  isTeammateAgentContext,
  parseTeammateAgentId,
} from './teammateIdentity'

describe('teammateIdentity', () => {
  it('parseTeammateAgentId splits name@team', () => {
    expect(parseTeammateAgentId('researcher@my-team')).toEqual({
      agentName: 'researcher',
      teamName: 'my-team',
    })
    expect(parseTeammateAgentId('no-at')).toBeNull()
  })

  it('buildTeammateRuntimeContext prefers id split over loose name', () => {
    const t = buildTeammateRuntimeContext({
      agentId: 'a@T',
      name: 'ignored',
      teamName: 'T',
    })
    expect(t.agentName).toBe('a')
    expect(t.teamName).toBe('T')
    expect(t.isInProcess).toBe(true)
  })

  it('buildTeammateRuntimeContext falls back to name when id has no @', () => {
    const t = buildTeammateRuntimeContext({
      agentId: 'uuid-1',
      name: 'worker',
      teamName: 'Alpha',
    })
    expect(t.agentName).toBe('worker')
    expect(t.teamName).toBe('Alpha')
  })

  it('isTeammateAgentContext', () => {
    expect(isTeammateAgentContext(null)).toBe(false)
    expect(
      isTeammateAgentContext({
        teammate: buildTeammateRuntimeContext({
          agentId: 'x',
          teamName: 'T',
        }),
      }),
    ).toBe(true)
  })

  it('isTeamLead', () => {
    expect(isTeamLead('lead-1', 'lead-1')).toBe(true)
    expect(isTeamLead('w', 'lead-1')).toBe(false)
  })
})
