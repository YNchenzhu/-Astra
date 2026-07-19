import { describe, expect, it } from 'vitest'
import { getLastPeerDmSummary } from './peerDmSummary'

describe('getLastPeerDmSummary', () => {
  it('returns null for empty transcript', () => {
    expect(getLastPeerDmSummary([])).toBeNull()
  })

  it('returns null when there is no SendMessage tool_use', () => {
    expect(
      getLastPeerDmSummary([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      ]),
    ).toBeNull()
  })

  it('extracts [to <name>] <summary> for a basic peer DM', () => {
    const summary = getLastPeerDmSummary([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'SendMessage',
            input: { to: 'coder', summary: 'need auth helper by 5pm' },
          },
        ],
      },
    ])
    expect(summary).toBe('[to coder] need auth helper by 5pm')
  })

  it('falls back to `message` then `payload` when `summary` is missing', () => {
    const viaMessage = getLastPeerDmSummary([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'SendMessage', input: { to: 'coder', message: 'ping' } },
        ],
      },
    ])
    expect(viaMessage).toBe('[to coder] ping')

    const viaPayload = getLastPeerDmSummary([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'SendMessage', input: { to: 'coder', payload: 'pong' } },
        ],
      },
    ])
    expect(viaPayload).toBe('[to coder] pong')
  })

  it('returns recipient-only string when body is empty', () => {
    const summary = getLastPeerDmSummary([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'coder' } }],
      },
    ])
    expect(summary).toBe('[to coder]')
  })

  it('skips broadcast (*) and lead recipients', () => {
    const summary = getLastPeerDmSummary([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'SendMessage', input: { to: '*', summary: 'broadcast' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'SendMessage',
            input: { to: 'team-lead', summary: 'reporting back' },
          },
        ],
      },
    ])
    expect(summary).toBeNull()
  })

  it('skips lead via case-insensitive name match', () => {
    const summary = getLastPeerDmSummary([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'SendMessage',
            input: { to: 'Team-Lead', summary: 'fyi' },
          },
        ],
      },
    ])
    expect(summary).toBeNull()
  })

  it('strips mailbox:/bridge:/uds:astra:/team: route prefixes', () => {
    const cases: Array<[string, string]> = [
      ['mailbox:researcher', '[to researcher] hi'],
      ['bridge:researcher', '[to researcher] hi'],
      ['uds:astra:researcher', '[to researcher] hi'],
      ['team:swarm-1', '[to swarm-1] hi'],
    ]
    for (const [to, expected] of cases) {
      const summary = getLastPeerDmSummary([
        {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'SendMessage', input: { to, summary: 'hi' } }],
        },
      ])
      expect(summary, `for to="${to}"`).toBe(expected)
    }
  })

  it('returns the most recent peer DM when multiple are present', () => {
    const summary = getLastPeerDmSummary([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'SendMessage', input: { to: 'a', summary: 'first' } },
        ],
      },
      { role: 'user', content: 'next' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'SendMessage', input: { to: 'b', summary: 'second' } },
        ],
      },
    ])
    expect(summary).toBe('[to b] second')
  })

  it('when a single assistant turn has multiple SendMessage blocks, returns the last one in that turn', () => {
    const summary = getLastPeerDmSummary([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'SendMessage', input: { to: 'a', summary: 'first' } },
          { type: 'tool_use', name: 'SendMessage', input: { to: 'b', summary: 'second' } },
        ],
      },
    ])
    expect(summary).toBe('[to b] second')
  })

  it('skips broadcasts and lead within the same turn but still picks a valid sibling', () => {
    const summary = getLastPeerDmSummary([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'SendMessage', input: { to: 'coder', summary: 'real' } },
          { type: 'tool_use', name: 'SendMessage', input: { to: '*', summary: 'noise' } },
          { type: 'tool_use', name: 'SendMessage', input: { to: 'team-lead', summary: 'fyi' } },
        ],
      },
    ])
    expect(summary).toBe('[to coder] real')
  })

  it('ignores non-assistant messages even when they carry a SendMessage shape', () => {
    const summary = getLastPeerDmSummary([
      {
        role: 'user',
        content: [
          { type: 'tool_use', name: 'SendMessage', input: { to: 'coder', summary: 'hi' } },
        ],
      },
    ])
    expect(summary).toBeNull()
  })

  it('ignores non-SendMessage tool_use blocks', () => {
    const summary = getLastPeerDmSummary([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'ls', to: 'coder' } },
        ],
      },
    ])
    expect(summary).toBeNull()
  })

  it('truncates very long bodies with an ellipsis', () => {
    const long = 'x'.repeat(500)
    const summary = getLastPeerDmSummary([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'SendMessage', input: { to: 'coder', summary: long } },
        ],
      },
    ])
    expect(summary).not.toBeNull()
    // 199 'x' + ellipsis = 200 visible chars after the "[to coder] " prefix
    expect(summary!.endsWith('…')).toBe(true)
    expect(summary!.length).toBeLessThanOrEqual('[to coder] '.length + 200)
  })

  it('tolerates malformed blocks without throwing', () => {
    expect(() =>
      getLastPeerDmSummary([
        { role: 'assistant', content: 'not an array' as unknown },
        { role: 'assistant', content: [null as unknown, { type: 'tool_use' }] },
      ]),
    ).not.toThrow()
  })

  it('also accepts the snake_case `send_message` tool name', () => {
    const summary = getLastPeerDmSummary([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'send_message', input: { to: 'coder', summary: 'hi' } },
        ],
      },
    ])
    expect(summary).toBe('[to coder] hi')
  })
})
