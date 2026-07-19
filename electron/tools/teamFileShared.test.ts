import { describe, expect, it } from 'vitest'
import {
  appendTeamMemberSlot,
  teamHasMember,
  teamMemberIds,
  type TeamMemberSlot,
} from './teamFileShared'

describe('teamFileShared member slots (§7.4)', () => {
  it('teamMemberIds flattens strings and profiles', () => {
    const slots: TeamMemberSlot[] = [
      'a',
      { agentId: 'b', name: 'bee' },
      '  ',
      { agentId: 'c', joinedAt: 1 },
    ]
    expect(teamMemberIds(slots)).toEqual(['a', 'b', 'c'])
  })

  it('teamHasMember and appendTeamMemberSlot', () => {
    const base: TeamMemberSlot[] = [{ agentId: 'lead', name: 'lead', backendType: 'in-process' }]
    expect(teamHasMember(base, 'lead')).toBe(true)
    expect(teamHasMember(base, 'x')).toBe(false)
    const next = appendTeamMemberSlot(base, 'w1')
    expect(teamMemberIds(next)).toEqual(['lead', 'w1'])
    expect(appendTeamMemberSlot(next, 'w1')).toBe(next)
  })
})
