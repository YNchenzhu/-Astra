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
import { sendTaskAssignmentNotification } from './teamTaskAssignmentNotifier'

const TEAM_NAME = 'alpha'

let workspaceRoot: string

beforeAll(async () => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-assign-notifier-'))
  const team: Team = {
    teamName: TEAM_NAME,
    leadAgentId: 'team-lead@alpha',
    members: ['team-lead@alpha', 'researcher@alpha'],
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
  await readAndClearTeamMailbox(workspaceRoot, TEAM_NAME, 'researcher')
  await readAndClearTeamMailbox(workspaceRoot, TEAM_NAME, 'researcher@alpha')
  process.env.POLE_TEAM_ACTIVE_LOOP = '1'
})

afterEach(() => {
  clearAllLocks({ force: true })
  delete process.env.POLE_TEAM_ACTIVE_LOOP
})

describe('sendTaskAssignmentNotification', () => {
  it('skips when POLE_TEAM_ACTIVE_LOOP is explicitly disabled (S3: default ON)', async () => {
    process.env.POLE_TEAM_ACTIVE_LOOP = '0'
    const res = await sendTaskAssignmentNotification({
      toOwner: 'researcher',
      taskId: 'task-1',
      teamName: TEAM_NAME,
      workspaceRoot,
    })
    expect(res.delivered).toBe(false)
    expect(res.skipReason).toBe('flag_off')
  })

  it('skips when required fields are missing', async () => {
    const noOwner = await sendTaskAssignmentNotification({
      toOwner: '',
      taskId: 'task-1',
      teamName: TEAM_NAME,
      workspaceRoot,
    })
    expect(noOwner.delivered).toBe(false)
    expect(noOwner.skipReason).toBe('missing_fields')

    const noTaskId = await sendTaskAssignmentNotification({
      toOwner: 'researcher',
      taskId: '',
      teamName: TEAM_NAME,
      workspaceRoot,
    })
    expect(noTaskId.delivered).toBe(false)
    expect(noTaskId.skipReason).toBe('missing_fields')

    const noTeam = await sendTaskAssignmentNotification({
      toOwner: 'researcher',
      taskId: 'task-1',
      teamName: '   ',
      workspaceRoot,
    })
    expect(noTeam.delivered).toBe(false)
    expect(noTeam.skipReason).toBe('missing_fields')
  })

  it('skips when workspaceRoot resolves to null', async () => {
    const res = await sendTaskAssignmentNotification({
      toOwner: 'researcher',
      taskId: 'task-1',
      teamName: TEAM_NAME,
      workspaceRoot: null,
    })
    expect(res.delivered).toBe(false)
    expect(res.skipReason).toBe('no_workspace')
  })

  it('writes a schema-valid task_assignment envelope', async () => {
    const res = await sendTaskAssignmentNotification({
      toOwner: 'researcher',
      taskId: 'task-42',
      taskSubject: 'wire auth',
      assignedBy: 'team-lead@alpha',
      assignedByAgentType: 'team-lead',
      teamName: TEAM_NAME,
      workspaceRoot,
    })
    expect(res.delivered).toBe(true)

    const lines = await peekTeamMailbox(workspaceRoot, TEAM_NAME, 'researcher')
    expect(lines).toHaveLength(1)

    const parsed = parseTeamInterAgentLine(lines[0])
    expect(parsed?.schema).toBe(TEAM_INTER_AGENT_SCHEMA)
    expect(parsed?.kind).toBe('task_assignment')
    expect(parsed?.detail).toBe('task-42')
    expect(parsed?.from?.agentId).toBe('team-lead@alpha')
    expect(parsed?.from?.agentType).toBe('team-lead')

    // The inner protocol object should also pass the Zod schema for
    // task_assignment (taskId in metadata, detail non-empty).
    const stripped = lines[0].replace(/^\[[^\]]+]\s+/, '')
    const envelope = JSON.parse(stripped) as Record<string, unknown>
    const inner = JSON.parse(envelope.payload as string) as Record<string, unknown>
    const v = validateInterAgentMessage(inner, 'task_assignment')
    expect(v.ok).toBe(true)
  })

  it('passes taskSubject + assignedBy through envelope metadata', async () => {
    await sendTaskAssignmentNotification({
      toOwner: 'researcher',
      taskId: 'task-9',
      taskSubject: 'audit S3 perms',
      assignedBy: 'team-lead@alpha',
      teamName: TEAM_NAME,
      workspaceRoot,
    })
    const lines = await peekTeamMailbox(workspaceRoot, TEAM_NAME, 'researcher')
    const envelope = JSON.parse(lines[0].replace(/^\[[^\]]+]\s+/, '')) as Record<string, unknown>
    const metadata = envelope.metadata as Record<string, unknown> | undefined
    expect(metadata?.taskId).toBe('task-9')
    expect(metadata?.taskSubject).toBe('audit S3 perms')
    expect(metadata?.assignedBy).toBe('team-lead@alpha')
  })

  it('routes to the owner mailbox key verbatim (uses raw owner string)', async () => {
    await sendTaskAssignmentNotification({
      toOwner: 'researcher@alpha',
      taskId: 'task-2',
      teamName: TEAM_NAME,
      workspaceRoot,
    })
    const lines = await peekTeamMailbox(workspaceRoot, TEAM_NAME, 'researcher@alpha')
    expect(lines).toHaveLength(1)
    const lines2 = await peekTeamMailbox(workspaceRoot, TEAM_NAME, 'researcher')
    expect(lines2).toHaveLength(0)
  })
})
