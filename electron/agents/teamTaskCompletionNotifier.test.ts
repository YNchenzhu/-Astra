import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  peekTeamMailbox,
  readAndClearTeamMailbox,
} from '../tools/teamMailbox'
import { persistTeamFile, type Team } from '../tools/TeamCreateTool'
import { clearAllLocks } from '../tools/fileLock'
import {
  parseTeamInterAgentLine,
  TEAM_INTER_AGENT_SCHEMA,
  validateInterAgentMessage,
} from './teamInterAgentProtocol'
import { sendTaskCompletionNotification } from './teamTaskCompletionNotifier'

const TEAM_NAME = 'alpha'
const LEAD_ID = 'team-lead@alpha'

let workspaceRoot: string

beforeAll(async () => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-completion-notifier-'))
  const team: Team = {
    teamName: TEAM_NAME,
    leadAgentId: LEAD_ID,
    members: [LEAD_ID, 'researcher@alpha'],
    createdAt: Date.now(),
    mailbox: {},
  }
  await persistTeamFile(workspaceRoot, team)
})

afterAll(() => {
  try {
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

beforeEach(async () => {
  await readAndClearTeamMailbox(workspaceRoot, TEAM_NAME, LEAD_ID)
  process.env.POLE_TEAM_ACTIVE_LOOP = '1'
})

afterEach(() => {
  clearAllLocks({ force: true })
  delete process.env.POLE_TEAM_ACTIVE_LOOP
})

describe('sendTaskCompletionNotification', () => {
  it('skips with flag_off when POLE_TEAM_ACTIVE_LOOP is explicitly disabled', async () => {
    process.env.POLE_TEAM_ACTIVE_LOOP = '0'
    const res = await sendTaskCompletionNotification({
      toLeadAgentId: LEAD_ID,
      taskId: 't-1',
      status: 'completed',
      teamName: TEAM_NAME,
      workspaceRoot,
    })
    expect(res.delivered).toBe(false)
    expect(res.skipReason).toBe('flag_off')
  })

  it('skips with missing_fields when required identity is empty', async () => {
    const noLead = await sendTaskCompletionNotification({
      toLeadAgentId: '',
      taskId: 't-1',
      status: 'completed',
      teamName: TEAM_NAME,
      workspaceRoot,
    })
    expect(noLead.delivered).toBe(false)
    expect(noLead.skipReason).toBe('missing_fields')

    const noTaskId = await sendTaskCompletionNotification({
      toLeadAgentId: LEAD_ID,
      taskId: '',
      status: 'completed',
      teamName: TEAM_NAME,
      workspaceRoot,
    })
    expect(noTaskId.delivered).toBe(false)
    expect(noTaskId.skipReason).toBe('missing_fields')
  })

  it('rejects unrecognised status as missing_fields (only completed/failed allowed)', async () => {
    const r = await sendTaskCompletionNotification({
      toLeadAgentId: LEAD_ID,
      taskId: 't-1',
      // @ts-expect-error — testing the runtime guard
      status: 'in_progress',
      teamName: TEAM_NAME,
      workspaceRoot,
    })
    expect(r.delivered).toBe(false)
    expect(r.skipReason).toBe('missing_fields')
  })

  it('skips with no_workspace when workspaceRoot resolves to null', async () => {
    const r = await sendTaskCompletionNotification({
      toLeadAgentId: LEAD_ID,
      taskId: 't-1',
      status: 'completed',
      teamName: TEAM_NAME,
      workspaceRoot: null,
    })
    expect(r.delivered).toBe(false)
    expect(r.skipReason).toBe('no_workspace')
  })

  it('writes a parseable task_completion envelope into the lead mailbox', async () => {
    const res = await sendTaskCompletionNotification({
      toLeadAgentId: LEAD_ID,
      taskId: 'task-42',
      taskSubject: 'Refactor cache layer',
      status: 'completed',
      completedBy: 'researcher@alpha',
      completedByAgentType: 'researcher',
      teamName: TEAM_NAME,
      workspaceRoot,
    })
    expect(res.delivered).toBe(true)
    expect(res.envelopeLine).toBeDefined()

    const lines = await peekTeamMailbox(workspaceRoot, TEAM_NAME, LEAD_ID)
    expect(lines).toHaveLength(1)

    const parsed = parseTeamInterAgentLine(lines[0])
    expect(parsed?.schema).toBe(TEAM_INTER_AGENT_SCHEMA)
    expect(parsed?.kind).toBe('task_completion')
    expect(parsed?.detail).toBe('task-42')
    expect(parsed?.from?.agentId).toBe('researcher@alpha')
    expect(parsed?.from?.agentType).toBe('researcher')
  })

  it('emits a failed status when the task did not succeed', async () => {
    const res = await sendTaskCompletionNotification({
      toLeadAgentId: LEAD_ID,
      taskId: 'task-bad',
      status: 'failed',
      teamName: TEAM_NAME,
      workspaceRoot,
    })
    expect(res.delivered).toBe(true)

    const lines = await peekTeamMailbox(workspaceRoot, TEAM_NAME, LEAD_ID)
    expect(lines).toHaveLength(1)
    // Status is on the outer envelope metadata; the inner protocol object
    // also passes through metadata.status thanks to `passthrough()`.
    expect(lines[0]).toContain('"status":"failed"')

    // Validate against the registered Zod schema (taskId required).
    const parsed = parseTeamInterAgentLine(lines[0])
    expect(parsed?.kind).toBe('task_completion')
    const v = validateInterAgentMessage(
      // Re-build the protocol object as the registry validator expects it.
      { ...parsed, metadata: { taskId: 'task-bad', status: 'failed' } },
      'task_completion',
    )
    expect(v.ok).toBe(true)
  })
})
