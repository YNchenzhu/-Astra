import { describe, expect, it } from 'vitest'
import { groupMessagesByApiRound } from './groupMessagesByApiRound'

describe('groupMessagesByApiRound', () => {
  it('starts a new group when assistant id changes', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'one' }] },
      { role: 'user', content: 'tool results' },
      { role: 'assistant', id: 'a2', content: [{ type: 'text', text: 'two' }] },
    ]
    const g = groupMessagesByApiRound(messages)
    expect(g.length).toBe(2)
    expect(g[0]!.map((m) => m.role).join(',')).toBe('user,assistant,user')
    expect(g[1]!.map((m) => m.role).join(',')).toBe('assistant')
  })
})
