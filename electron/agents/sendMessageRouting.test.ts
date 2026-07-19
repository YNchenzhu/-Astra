import { describe, it, expect } from 'vitest'
import { parseSendMessageTarget, sendMessageRouteDescription } from './sendMessageRouting'

describe('parseSendMessageTarget', () => {
  it('parses broadcast *', () => {
    expect(parseSendMessageTarget('*')).toEqual({ kind: 'broadcast_all', raw: '*' })
  })

  it('parses team:<name> case-insensitively on prefix', () => {
    expect(parseSendMessageTarget('team:Alpha')).toEqual({
      kind: 'team_broadcast',
      teamName: 'Alpha',
      raw: 'team:Alpha',
    })
    expect(parseSendMessageTarget('TEAM:beta')).toEqual({
      kind: 'team_broadcast',
      teamName: 'beta',
      raw: 'TEAM:beta',
    })
  })

  it('marks filesystem uds: as unsupported', () => {
    expect(parseSendMessageTarget('uds:/tmp/sock')).toEqual({
      kind: 'unsupported_uds',
      raw: 'uds:/tmp/sock',
    })
  })

  it('maps uds:astra: to in-process bridge', () => {
    expect(parseSendMessageTarget('uds:astra:agent-9')).toEqual({
      kind: 'bridge_in_process',
      targetId: 'agent-9',
      raw: 'uds:astra:agent-9',
    })
  })

  it('parses mailbox:<id>', () => {
    expect(parseSendMessageTarget('mailbox:agent-1')).toEqual({
      kind: 'mailbox_durable',
      agentKey: 'agent-1',
      raw: 'mailbox:agent-1',
    })
  })

  it('parses bridge:<id>', () => {
    expect(parseSendMessageTarget('bridge:sub-42')).toEqual({
      kind: 'bridge_in_process',
      targetId: 'sub-42',
      raw: 'bridge:sub-42',
    })
  })

  it('bridge with empty suffix is rejected (no implicit broadcast)', () => {
    // P1-8: an empty `bridge:` is no longer rewritten to a global broadcast;
    // the caller must use `*` explicitly if they meant fan-out. We surface
    // the malformed target as `unsupported_uds` so the upstream tool
    // produces an actionable error string for the model.
    expect(parseSendMessageTarget('bridge:')).toEqual({
      kind: 'unsupported_uds',
      raw: 'bridge:',
    })
  })

  it('direct active for plain id', () => {
    expect(parseSendMessageTarget('general-purpose')).toEqual({
      kind: 'direct_active',
      raw: 'general-purpose',
    })
  })
})

describe('sendMessageRouteDescription', () => {
  it('mentions key route kinds', () => {
    const d = sendMessageRouteDescription()
    expect(d).toContain('team:')
    expect(d).toContain('mailbox:')
    expect(d).toContain('bridge:')
    expect(d).toContain('uds:astra')
  })
})
