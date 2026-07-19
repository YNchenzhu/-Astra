import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BUILTIN_INTER_AGENT_SCHEMA_NAMES,
  TEAM_INTER_AGENT_SCHEMA,
  clearInterAgentSchemasForTests,
  getInterAgentSchema,
  listInterAgentSchemas,
  parseTeamInterAgentLine,
  parseTeamInterAgentLineWithRecord,
  registerInterAgentSchema,
  stringifyTeamInterAgentMessage,
  stripMailboxLineTimestamp,
  validateInterAgentMessage,
} from './teamInterAgentProtocol'
import { formatTeamMailboxEnvelopeLine } from '../tools/TeamCreateTool'

describe('teamInterAgentProtocol', () => {
  afterEach(() => {
    clearInterAgentSchemasForTests()
  })

  it('stripMailboxLineTimestamp removes ISO prefix', () => {
    const line = `[2026-04-14T12:00:00.000Z] {"a":1}`
    expect(stripMailboxLineTimestamp(line)).toBe('{"a":1}')
  })

  it('parses top-level protocol JSON', () => {
    const raw = stringifyTeamInterAgentMessage({
      schema: TEAM_INTER_AGENT_SCHEMA,
      kind: 'shutdown_request',
      requestId: 'r1',
    })
    const p = parseTeamInterAgentLine(raw)
    expect(p?.kind).toBe('shutdown_request')
    expect(p?.requestId).toBe('r1')
  })

  it('parses protocol nested in SendMessage envelope payload', () => {
    const proto = stringifyTeamInterAgentMessage({
      schema: TEAM_INTER_AGENT_SCHEMA,
      kind: 'plan_approval_response',
      requestId: 'p9',
      approve: true,
    })
    const line = formatTeamMailboxEnvelopeLine({
      from: 'lead',
      to: 'worker',
      teamName: 'T',
      type: 'task',
      payload: proto,
    })
    const p = parseTeamInterAgentLine(line)
    expect(p?.kind).toBe('plan_approval_response')
    expect(p?.approve).toBe(true)
    expect(p?.requestId).toBe('p9')
  })

  describe('parseTeamInterAgentLineWithRecord', () => {
    it('returns both the parsed message and the inner JSON record', () => {
      const proto = stringifyTeamInterAgentMessage({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'shutdown_request',
        requestId: 'r1',
      })
      const result = parseTeamInterAgentLineWithRecord(`[2026-01-01T00:00:00Z] ${proto}`)
      expect(result).not.toBeNull()
      expect(result?.message.kind).toBe('shutdown_request')
      expect(result?.record).toMatchObject({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'shutdown_request',
        requestId: 'r1',
      })
    })

    it('unwraps nested envelope payload and returns the inner record', () => {
      const proto = stringifyTeamInterAgentMessage({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'plan_approval_response',
        requestId: 'p9',
        approve: false,
      })
      const line = formatTeamMailboxEnvelopeLine({
        from: 'lead',
        to: 'worker',
        teamName: 'T',
        type: 'task',
        payload: proto,
      })
      const result = parseTeamInterAgentLineWithRecord(line)
      expect(result?.record).toMatchObject({ kind: 'plan_approval_response', approve: false })
    })

    it('returns null for non-JSON lines', () => {
      expect(parseTeamInterAgentLineWithRecord('hello world')).toBeNull()
    })
  })

  describe('schema registry', () => {
    it('seeds every built-in TeamInterAgentKind by default', () => {
      const names = listInterAgentSchemas()
      for (const k of BUILTIN_INTER_AGENT_SCHEMA_NAMES) {
        expect(names).toContain(k)
      }
    })

    it('registerInterAgentSchema adds a custom entry; the unregister fn restores it', () => {
      const customSchema = z.object({
        schema: z.literal(TEAM_INTER_AGENT_SCHEMA),
        kind: z.literal('idle_notification'),
        customField: z.string(),
      })

      const before = getInterAgentSchema('custom_handoff')
      expect(before).toBeUndefined()

      const unregister = registerInterAgentSchema('custom_handoff', customSchema)
      expect(getInterAgentSchema('custom_handoff')).toBeDefined()

      unregister()
      expect(getInterAgentSchema('custom_handoff')).toBeUndefined()
    })

    it('registerInterAgentSchema overrides + unregister restores a built-in', () => {
      const stricter = z.object({
        schema: z.literal(TEAM_INTER_AGENT_SCHEMA),
        kind: z.literal('idle_notification'),
        detail: z.string().min(10), // stricter than the built-in (string optional)
      })
      const unregister = registerInterAgentSchema('idle_notification', stricter)

      const v1 = validateInterAgentMessage(
        { schema: TEAM_INTER_AGENT_SCHEMA, kind: 'idle_notification', detail: 'short' },
        'idle_notification',
      )
      expect(v1.ok).toBe(false)

      unregister()

      const v2 = validateInterAgentMessage(
        { schema: TEAM_INTER_AGENT_SCHEMA, kind: 'idle_notification', detail: 'short' },
        'idle_notification',
      )
      expect(v2.ok).toBe(true)
    })
  })

  describe('validateInterAgentMessage', () => {
    it('passes for a valid plan_approval_response', () => {
      const r = validateInterAgentMessage(
        {
          schema: TEAM_INTER_AGENT_SCHEMA,
          kind: 'plan_approval_response',
          requestId: 'p1',
          approve: true,
        },
        'plan_approval_response',
      )
      expect(r.ok).toBe(true)
      expect(r.name).toBe('plan_approval_response')
    })

    it('fails when required field is missing', () => {
      const r = validateInterAgentMessage(
        {
          schema: TEAM_INTER_AGENT_SCHEMA,
          kind: 'plan_approval_response',
          // requestId missing
          approve: true,
        },
        'plan_approval_response',
      )
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.errors.some((e) => e.includes('requestId'))).toBe(true)
      }
    })

    it('fails when kind discriminator does not match the schema literal', () => {
      const r = validateInterAgentMessage(
        {
          schema: TEAM_INTER_AGENT_SCHEMA,
          kind: 'shutdown_request', // wrong kind for plan_approval_response schema
          requestId: 'p1',
        },
        'plan_approval_response',
      )
      expect(r.ok).toBe(false)
    })

    it('fails when the protocol schema literal is wrong', () => {
      const r = validateInterAgentMessage(
        {
          schema: 'not-the-real-schema',
          kind: 'plan_approval_response',
          requestId: 'p1',
          approve: true,
        },
        'plan_approval_response',
      )
      expect(r.ok).toBe(false)
    })

    it('mode_set_request restricts detail to a known set', () => {
      const ok = validateInterAgentMessage(
        { schema: TEAM_INTER_AGENT_SCHEMA, kind: 'mode_set_request', detail: 'plan' },
        'mode_set_request',
      )
      expect(ok.ok).toBe(true)

      const bad = validateInterAgentMessage(
        { schema: TEAM_INTER_AGENT_SCHEMA, kind: 'mode_set_request', detail: 'rocket' },
        'mode_set_request',
      )
      expect(bad.ok).toBe(false)
    })

    it('plan_approval_request requires non-empty `detail`', () => {
      const bad = validateInterAgentMessage(
        {
          schema: TEAM_INTER_AGENT_SCHEMA,
          kind: 'plan_approval_request',
          requestId: 'p1',
          // detail missing
        },
        'plan_approval_request',
      )
      expect(bad.ok).toBe(false)

      const good = validateInterAgentMessage(
        {
          schema: TEAM_INTER_AGENT_SCHEMA,
          kind: 'plan_approval_request',
          requestId: 'p1',
          detail: 'Step 1: foo. Step 2: bar.',
        },
        'plan_approval_request',
      )
      expect(good.ok).toBe(true)
    })

    it('passthrough lets unknown extra fields pass without breaking validation', () => {
      const r = validateInterAgentMessage(
        {
          schema: TEAM_INTER_AGENT_SCHEMA,
          kind: 'shutdown_request',
          requestId: 'r1',
          futureField: { nested: true },
        },
        'shutdown_request',
      )
      expect(r.ok).toBe(true)
    })

    it('returns ok:false with helpful error when schema name is unknown', () => {
      const r = validateInterAgentMessage(
        { schema: TEAM_INTER_AGENT_SCHEMA, kind: 'idle_notification' },
        'totally_made_up',
      )
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.errors[0]).toContain('unknown schema')
      }
    })

    it('task_assignment requires taskId in detail and metadata.taskId', () => {
      const good = validateInterAgentMessage(
        {
          schema: TEAM_INTER_AGENT_SCHEMA,
          kind: 'task_assignment',
          detail: 'task-7',
          metadata: { taskId: 'task-7', taskSubject: 'wire auth', assignedBy: 'team-lead' },
        },
        'task_assignment',
      )
      expect(good.ok).toBe(true)

      const missingMetadata = validateInterAgentMessage(
        { schema: TEAM_INTER_AGENT_SCHEMA, kind: 'task_assignment', detail: 'task-7' },
        'task_assignment',
      )
      expect(missingMetadata.ok).toBe(false)

      const emptyDetail = validateInterAgentMessage(
        {
          schema: TEAM_INTER_AGENT_SCHEMA,
          kind: 'task_assignment',
          detail: '',
          metadata: { taskId: 'task-7' },
        },
        'task_assignment',
      )
      expect(emptyDetail.ok).toBe(false)
    })

    it('task_assignment accepts unknown extra metadata fields via passthrough', () => {
      const r = validateInterAgentMessage(
        {
          schema: TEAM_INTER_AGENT_SCHEMA,
          kind: 'task_assignment',
          detail: 'task-7',
          metadata: { taskId: 'task-7', futureField: 42 },
        },
        'task_assignment',
      )
      expect(r.ok).toBe(true)
    })

    it('task_completion restricts metadata.status to completed|failed', () => {
      const good = validateInterAgentMessage(
        {
          schema: TEAM_INTER_AGENT_SCHEMA,
          kind: 'task_completion',
          detail: 'task-7',
          metadata: { taskId: 'task-7', status: 'completed', finalSummary: 'merged PR #42' },
        },
        'task_completion',
      )
      expect(good.ok).toBe(true)

      const bad = validateInterAgentMessage(
        {
          schema: TEAM_INTER_AGENT_SCHEMA,
          kind: 'task_completion',
          detail: 'task-7',
          metadata: { taskId: 'task-7', status: 'in_progress' },
        },
        'task_completion',
      )
      expect(bad.ok).toBe(false)
    })

    it('task_completion fails when taskId is missing', () => {
      const r = validateInterAgentMessage(
        {
          schema: TEAM_INTER_AGENT_SCHEMA,
          kind: 'task_completion',
          detail: 'task-7',
          metadata: { status: 'completed' },
        },
        'task_completion',
      )
      expect(r.ok).toBe(false)
    })
  })

  describe('new active-loop kinds in registry', () => {
    it('seeds task_assignment and task_completion by default', () => {
      const names = listInterAgentSchemas()
      expect(names).toContain('task_assignment')
      expect(names).toContain('task_completion')
    })

    it('round-trips task_assignment through parseTeamInterAgentLine', () => {
      const raw = stringifyTeamInterAgentMessage({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'task_assignment',
        detail: 'task-12',
      })
      const parsed = parseTeamInterAgentLine(raw)
      expect(parsed?.kind).toBe('task_assignment')
      expect(parsed?.detail).toBe('task-12')
    })

    it('round-trips task_completion through parseTeamInterAgentLine', () => {
      const raw = stringifyTeamInterAgentMessage({
        schema: TEAM_INTER_AGENT_SCHEMA,
        kind: 'task_completion',
        detail: 'task-12',
      })
      const parsed = parseTeamInterAgentLine(raw)
      expect(parsed?.kind).toBe('task_completion')
    })
  })
})
