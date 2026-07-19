import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ToolDefinition } from '../tools/types'
import {
  patchToolDefinitionsForSendMessageRecipients,
  collectSendMessageRecipientEnum,
  buildSendMessageOpenAIStrictParameters,
} from './sendMessageToolSchema'

vi.mock('./activeAgentRegistry', () => ({
  getActiveAgents: vi.fn(() => new Map()),
}))

import { getActiveAgents } from './activeAgentRegistry'

describe('sendMessageToolSchema', () => {
  beforeEach(() => {
    vi.mocked(getActiveAgents).mockReturnValue(new Map())
  })
  it('returns the same references for tools other than SendMessage', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'Read',
        description: 'x',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
    ]
    const out = patchToolDefinitionsForSendMessageRecipients(defs)
    expect(out[0]).toBe(defs[0])
  })

  it('leaves definitions stable unless recipient enum patching is requested', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'SendMessage',
        description: 'd',
        input_schema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'to' },
            message: { type: 'string', description: 'm' },
          },
          required: ['to', 'message'],
        },
      },
    ]
    const out = patchToolDefinitionsForSendMessageRecipients(defs)
    expect(out).toBe(defs)
  })

  it('clones SendMessage and sets to.enum including broadcast', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'SendMessage',
        description: 'd',
        input_schema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'to' },
            message: { type: 'string', description: 'm' },
          },
          required: ['to', 'message'],
        },
      },
    ]
    const out = patchToolDefinitionsForSendMessageRecipients(defs, { includeRecipientEnum: true })
    expect(out[0]).not.toBe(defs[0])
    const to = out[0].input_schema.properties.to as { enum?: string[] }
    expect(Array.isArray(to.enum)).toBe(true)
    expect(to.enum).toContain('*')
  })

  it('collectSendMessageRecipientEnum adds mailbox: and bridge: for each running agent', () => {
    vi.mocked(getActiveAgents).mockReturnValue(
      new Map([
        [
          'sub-1',
          {
            status: 'running',
            agentId: 'sub-1',
            name: 'Worker',
            teamName: 'Alpha',
          } as import('./types').ActiveAgent,
        ],
      ]),
    )
    const e = collectSendMessageRecipientEnum()
    expect(e).toContain('mailbox:sub-1')
    expect(e).toContain('bridge:sub-1')
    expect(e).toContain('mailbox:Worker')
    expect(e).toContain('bridge:Worker')
    expect(e).toContain('team:Alpha')
    expect(e).toContain('sub-1')
    expect(e).toContain('Worker')
    expect(e).toContain('*')
  })

  it('does not duplicate mailbox/bridge when name equals agentId', () => {
    vi.mocked(getActiveAgents).mockReturnValue(
      new Map([
        [
          'same',
          {
            status: 'running',
            agentId: 'same',
            name: 'same',
          } as import('./types').ActiveAgent,
        ],
      ]),
    )
    const e = collectSendMessageRecipientEnum()
    expect(e.filter((x) => x === 'mailbox:same').length).toBe(1)
    expect(e.filter((x) => x === 'bridge:same').length).toBe(1)
  })

  it('buildSendMessageOpenAIStrictParameters to.enum includes mailbox/bridge strings', () => {
    const params = buildSendMessageOpenAIStrictParameters([
      '*',
      'mailbox:a',
      'bridge:a',
    ])
    const to = params.properties as { to: { enum: string[] } }
    expect(to.to.enum).toEqual(expect.arrayContaining(['mailbox:a', 'bridge:a']))
  })
})
