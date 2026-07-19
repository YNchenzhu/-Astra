import { describe, expect, it } from 'vitest'
import {
  foldInboxItems,
  parseInboxLines,
  renderTeamInboxXml,
} from './teamInboxAttachments'
import {
  stringifyTeamInterAgentMessage,
  TEAM_INTER_AGENT_SCHEMA,
} from './teamInterAgentProtocol'
import { formatTeamMailboxEnvelopeLine } from '../tools/TeamCreateTool'

function makeLine(args: {
  from: string
  to: string
  teamName: string
  type: string
  kind: Parameters<typeof stringifyTeamInterAgentMessage>[0]['kind']
  detail?: string
  innerMetadata?: Record<string, unknown>
  envelopeMetadata?: Record<string, unknown>
  fromAgentType?: string
}): string {
  const proto = stringifyTeamInterAgentMessage({
    schema: TEAM_INTER_AGENT_SCHEMA,
    kind: args.kind,
    ...(args.detail ? { detail: args.detail } : {}),
    from: {
      agentId: args.from,
      ...(args.fromAgentType ? { agentType: args.fromAgentType } : {}),
    },
    ...(args.innerMetadata ? ({ metadata: args.innerMetadata } as never) : {}),
  })
  return formatTeamMailboxEnvelopeLine({
    from: args.from,
    to: args.to,
    teamName: args.teamName,
    type: args.type,
    payload: proto,
    ...(args.envelopeMetadata ? { metadata: args.envelopeMetadata } : {}),
  })
}

describe('parseInboxLines', () => {
  it('returns [] for empty / whitespace input', () => {
    expect(parseInboxLines([])).toEqual([])
    expect(parseInboxLines(['', '   '])).toEqual([])
  })

  it('parses idle_notification with envelope metadata', () => {
    const line = makeLine({
      from: 'researcher',
      to: 'team-lead',
      teamName: 'alpha',
      type: 'idle_notification',
      kind: 'idle_notification',
      detail: 'turn_complete',
      envelopeMetadata: { peerDmSummary: '[to coder] hi', completedTaskIds: ['t1'] },
    })
    const items = parseInboxLines([line])
    expect(items).toHaveLength(1)
    expect(items[0].message.kind).toBe('idle_notification')
    expect(items[0].envelopeFrom).toBe('researcher')
    expect(items[0].envelopeMetadata?.peerDmSummary).toBe('[to coder] hi')
    expect(items[0].envelopeMetadata?.completedTaskIds).toEqual(['t1'])
  })

  it('parses task_assignment with inner metadata block', () => {
    const line = makeLine({
      from: 'team-lead',
      to: 'researcher',
      teamName: 'alpha',
      type: 'task_assignment',
      kind: 'task_assignment',
      detail: 'task-9',
      innerMetadata: { taskId: 'task-9', taskSubject: 'audit S3', assignedBy: 'team-lead' },
    })
    const items = parseInboxLines([line])
    expect(items).toHaveLength(1)
    expect(items[0].message.kind).toBe('task_assignment')
    expect(items[0].innerMetadata?.taskId).toBe('task-9')
    expect(items[0].innerMetadata?.taskSubject).toBe('audit S3')
  })

  it('parses task_completion with status', () => {
    const line = makeLine({
      from: 'coder',
      to: 'team-lead',
      teamName: 'alpha',
      type: 'task_completion',
      kind: 'task_completion',
      detail: 'task-7',
      innerMetadata: { taskId: 'task-7', status: 'completed', finalSummary: 'shipped' },
    })
    const items = parseInboxLines([line])
    expect(items[0].message.kind).toBe('task_completion')
    expect(items[0].innerMetadata?.status).toBe('completed')
  })

  it('drops unsupported kinds (e.g. shutdown_request) silently', () => {
    const line = makeLine({
      from: 'lead',
      to: 'researcher',
      teamName: 'alpha',
      type: 'shutdown_request',
      kind: 'shutdown_request',
      detail: 'r1',
    })
    expect(parseInboxLines([line])).toEqual([])
  })

  it('extracts the leading ISO timestamp into receivedAt', () => {
    const line = `[2026-05-25T12:00:00.000Z] {"from":"x","to":"lead","teamName":"a","type":"idle_notification","payload":"{\\"schema\\":\\"openclaude.team.v1\\",\\"kind\\":\\"idle_notification\\",\\"detail\\":\\"turn_complete\\"}"}`
    const items = parseInboxLines([line])
    expect(items[0].receivedAt).toBe(Date.parse('2026-05-25T12:00:00.000Z'))
  })

  it('tolerates garbage lines without throwing', () => {
    expect(() => parseInboxLines(['not json', '[bad] also not json'])).not.toThrow()
    expect(parseInboxLines(['not json'])).toEqual([])
  })
})

describe('foldInboxItems', () => {
  function mk(kind: 'idle_notification' | 'task_assignment' | 'task_completion', from: string) {
    return {
      message: {
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind,
        from: { agentId: from },
      } as Parameters<typeof foldInboxItems>[0][number]['message'],
      envelopeFrom: from,
    }
  }

  it('keeps task_assignment / task_completion as-is', () => {
    const out = foldInboxItems([mk('task_assignment', 'a'), mk('task_completion', 'b')])
    expect(out).toHaveLength(2)
  })

  it('collapses same-sender idle notifications down to the latest', () => {
    const a1 = { ...mk('idle_notification', 'researcher'), receivedAt: 1 }
    const a2 = { ...mk('idle_notification', 'researcher'), receivedAt: 2 }
    const b = { ...mk('idle_notification', 'coder'), receivedAt: 3 }
    const out = foldInboxItems([a1, a2, b])
    // a1 should be folded away; a2 + b remain
    expect(out).toHaveLength(2)
    const senders = out.map((i) => i.envelopeFrom)
    expect(senders).toContain('researcher')
    expect(senders).toContain('coder')
    // the surviving researcher entry must be the LATER one
    const researcherItem = out.find((i) => i.envelopeFrom === 'researcher')!
    expect(researcherItem.receivedAt).toBe(2)
  })

  it('does NOT fold non-idle kinds even from the same sender', () => {
    const t1 = mk('task_completion', 'coder')
    const t2 = mk('task_completion', 'coder')
    expect(foldInboxItems([t1, t2])).toHaveLength(2)
  })
})

describe('renderTeamInboxXml', () => {
  it('returns null for empty input', () => {
    expect(renderTeamInboxXml([])).toBeNull()
  })

  it('renders a single idle_notification with peer-dm-summary + claimed-tasks (audit F-01)', () => {
    const line = makeLine({
      from: 'researcher',
      to: 'team-lead',
      teamName: 'alpha',
      type: 'idle_notification',
      kind: 'idle_notification',
      detail: 'turn_complete',
      envelopeMetadata: { peerDmSummary: '[to coder] hi', claimedTaskIds: ['t3', 't5'] },
    })
    const items = parseInboxLines([line])
    const xml = renderTeamInboxXml(items)
    expect(xml).not.toBeNull()
    expect(xml).toContain('<team-inbox>')
    expect(xml).toContain('</team-inbox>')
    expect(xml).toContain('from="researcher"')
    expect(xml).toContain('kind="idle_notification"')
    expect(xml).toContain('<reason>turn_complete</reason>')
    expect(xml).toContain('<peer-dm-summary>[to coder] hi</peer-dm-summary>')
    expect(xml).toContain('<claimed-tasks>t3,t5</claimed-tasks>')
    // The XML element name MUST NOT be the legacy `<completed-tasks>` —
    // we renamed because the values are claims, not completions.
    expect(xml).not.toContain('<completed-tasks>')
  })

  it('reads legacy completedTaskIds envelopes for back-compat (audit F-01)', () => {
    // Envelopes already in mailbox files (from a previous binary that
    // emitted `completedTaskIds`) must still parse + render, just under
    // the new `<claimed-tasks>` element. No migration needed; on next
    // teammate turn end the new emitter writes `claimedTaskIds`.
    const line = makeLine({
      from: 'researcher',
      to: 'team-lead',
      teamName: 'alpha',
      type: 'idle_notification',
      kind: 'idle_notification',
      detail: 'turn_complete',
      envelopeMetadata: { completedTaskIds: ['legacy-t1'] },
    })
    const xml = renderTeamInboxXml(parseInboxLines([line])) ?? ''
    expect(xml).toContain('<claimed-tasks>legacy-t1</claimed-tasks>')
  })

  it('renders a task_assignment with subject + assigned-by', () => {
    const line = makeLine({
      from: 'team-lead',
      to: 'researcher',
      teamName: 'alpha',
      type: 'task_assignment',
      kind: 'task_assignment',
      detail: 'task-9',
      innerMetadata: { taskId: 'task-9', taskSubject: 'audit S3', assignedBy: 'team-lead' },
    })
    const xml = renderTeamInboxXml(parseInboxLines([line]))
    expect(xml).toContain('kind="task_assignment"')
    expect(xml).toContain('<task-id>task-9</task-id>')
    expect(xml).toContain('<subject>audit S3</subject>')
    expect(xml).toContain('<assigned-by>team-lead</assigned-by>')
  })

  it('renders a task_completion with status + summary', () => {
    const line = makeLine({
      from: 'coder',
      to: 'team-lead',
      teamName: 'alpha',
      type: 'task_completion',
      kind: 'task_completion',
      detail: 'task-7',
      innerMetadata: { taskId: 'task-7', status: 'completed', finalSummary: 'shipped JWT' },
    })
    const xml = renderTeamInboxXml(parseInboxLines([line]))
    expect(xml).toContain('kind="task_completion"')
    expect(xml).toContain('<task-id>task-7</task-id>')
    expect(xml).toContain('<status>completed</status>')
    expect(xml).toContain('<summary>shipped JWT</summary>')
  })

  it('escapes XML special characters in dynamic content', () => {
    const line = makeLine({
      from: 'researcher <main>',
      to: 'team-lead',
      teamName: 'alpha',
      type: 'idle_notification',
      kind: 'idle_notification',
      detail: 'turn_complete',
      envelopeMetadata: { peerDmSummary: 'A & B "talked" <urgently>' },
    })
    const xml = renderTeamInboxXml(parseInboxLines([line])) ?? ''
    expect(xml).toContain('researcher &lt;main&gt;')
    expect(xml).toContain('A &amp; B &quot;talked&quot; &lt;urgently&gt;')
  })

  it('caps the rendered list and emits <dropped count="N"/> when over the limit', () => {
    const lines: string[] = []
    for (let i = 0; i < 25; i++) {
      lines.push(
        makeLine({
          from: `agent-${i}`,
          to: 'team-lead',
          teamName: 'alpha',
          type: 'task_completion',
          kind: 'task_completion',
          detail: `task-${i}`,
          innerMetadata: { taskId: `task-${i}`, status: 'completed' },
        }),
      )
    }
    const xml = renderTeamInboxXml(parseInboxLines(lines)) ?? ''
    expect(xml).toMatch(/<dropped count="5"\/>/)
    // The 20 most-recent (highest index) should be present.
    expect(xml).toContain('task-24')
    expect(xml).not.toContain('<task-id>task-0</task-id>')
  })

  it('returns null when all items get filtered out', () => {
    const line = makeLine({
      from: 'lead',
      to: 'r',
      teamName: 'alpha',
      type: 'shutdown_request',
      kind: 'shutdown_request',
      detail: 'r1',
    })
    expect(renderTeamInboxXml(parseInboxLines([line]))).toBeNull()
  })

  it('mixes kinds in one block, idle notifications folded to one per sender', () => {
    const lines = [
      makeLine({
        from: 'researcher',
        to: 'team-lead',
        teamName: 'alpha',
        type: 'idle_notification',
        kind: 'idle_notification',
        detail: 'turn_complete',
      }),
      makeLine({
        from: 'researcher',
        to: 'team-lead',
        teamName: 'alpha',
        type: 'idle_notification',
        kind: 'idle_notification',
        detail: 'no_more_tasks',
      }),
      makeLine({
        from: 'coder',
        to: 'team-lead',
        teamName: 'alpha',
        type: 'task_completion',
        kind: 'task_completion',
        detail: 'task-7',
        innerMetadata: { taskId: 'task-7', status: 'completed' },
      }),
    ]
    const xml = renderTeamInboxXml(parseInboxLines(lines)) ?? ''
    const idleCount = (xml.match(/kind="idle_notification"/g) ?? []).length
    expect(idleCount).toBe(1)
    expect(xml).toContain('no_more_tasks') // surviving researcher idle is the later one
    expect(xml).toContain('task-7')
  })
})
