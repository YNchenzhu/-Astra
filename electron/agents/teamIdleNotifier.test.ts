import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sendTeammateIdleNotification } from './teamIdleNotifier'
import {
  peekTeamMailbox,
  readAndClearTeamMailbox,
} from '../tools/teamMailbox'
import { persistTeamFile, type Team } from '../tools/TeamCreateTool'
import { clearAllLocks } from '../tools/fileLock'
import {
  parseTeamInterAgentLine,
  TEAM_INTER_AGENT_SCHEMA,
} from './teamInterAgentProtocol'

const TEAM_NAME = 'alpha'

let workspaceRoot: string

beforeAll(async () => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-idle-notifier-'))
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
  // Drain any leftover lines from the prior test so assertions on
  // mailbox length are reliable.
  await readAndClearTeamMailbox(workspaceRoot, TEAM_NAME, 'team-lead@alpha')
  process.env.POLE_TEAM_ACTIVE_LOOP = '1'
})

afterEach(() => {
  clearAllLocks({ force: true })
  delete process.env.POLE_TEAM_ACTIVE_LOOP
})

describe('sendTeammateIdleNotification', () => {
  it('skips and returns flag_off when POLE_TEAM_ACTIVE_LOOP is explicitly disabled (S3: default ON)', async () => {
    process.env.POLE_TEAM_ACTIVE_LOOP = '0'
    const res = await sendTeammateIdleNotification({
      teammateAgentId: 'researcher@alpha',
      leadAgentId: 'team-lead@alpha',
      teamName: TEAM_NAME,
      reason: 'turn_complete',
      workspaceRoot,
    })
    expect(res.delivered).toBe(false)
    expect(res.skipReason).toBe('flag_off')
    const lines = await peekTeamMailbox(workspaceRoot, TEAM_NAME, 'team-lead@alpha')
    expect(lines).toEqual([])
  })

  it('skips and returns missing_fields when required identity is empty', async () => {
    const res = await sendTeammateIdleNotification({
      teammateAgentId: '',
      leadAgentId: 'team-lead@alpha',
      teamName: TEAM_NAME,
      reason: 'turn_complete',
      workspaceRoot,
    })
    expect(res.delivered).toBe(false)
    expect(res.skipReason).toBe('missing_fields')
  })

  it('skips and returns no_workspace when workspaceRoot resolves to null', async () => {
    const res = await sendTeammateIdleNotification({
      teammateAgentId: 'researcher@alpha',
      leadAgentId: 'team-lead@alpha',
      teamName: TEAM_NAME,
      reason: 'turn_complete',
      workspaceRoot: null,
    })
    expect(res.delivered).toBe(false)
    expect(res.skipReason).toBe('no_workspace')
  })

  it('writes a parseable idle_notification envelope into the lead mailbox', async () => {
    const res = await sendTeammateIdleNotification({
      teammateAgentId: 'researcher@alpha',
      teammateName: 'researcher',
      teammateAgentType: 'researcher',
      leadAgentId: 'team-lead@alpha',
      teamName: TEAM_NAME,
      reason: 'turn_complete',
      workspaceRoot,
    })
    expect(res.delivered).toBe(true)
    expect(res.envelopeLine).toBeDefined()

    const lines = await peekTeamMailbox(workspaceRoot, TEAM_NAME, 'team-lead@alpha')
    expect(lines).toHaveLength(1)

    const parsed = parseTeamInterAgentLine(lines[0])
    expect(parsed?.schema).toBe(TEAM_INTER_AGENT_SCHEMA)
    expect(parsed?.kind).toBe('idle_notification')
    expect(parsed?.detail).toBe('turn_complete')
    expect(parsed?.from?.agentId).toBe('researcher@alpha')
    expect(parsed?.from?.agentType).toBe('researcher')
  })

  it('embeds peerDmSummary into the outer envelope metadata when available', async () => {
    const res = await sendTeammateIdleNotification({
      teammateAgentId: 'researcher@alpha',
      leadAgentId: 'team-lead@alpha',
      teamName: TEAM_NAME,
      reason: 'turn_complete',
      recentMessages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'SendMessage',
              input: { to: 'coder', summary: 'need auth helper by 5pm' },
            },
          ],
        },
      ],
      workspaceRoot,
    })
    expect(res.delivered).toBe(true)
    const lines = await peekTeamMailbox(workspaceRoot, TEAM_NAME, 'team-lead@alpha')
    expect(lines).toHaveLength(1)
    // Strip the `[ts] ` prefix and parse the outer envelope to inspect metadata.
    const stripped = lines[0].replace(/^\[[^\]]+]\s+/, '')
    const envelope = JSON.parse(stripped) as Record<string, unknown>
    const metadata = envelope.metadata as Record<string, unknown> | undefined
    expect(metadata?.peerDmSummary).toBe('[to coder] need auth helper by 5pm')
  })

  it('embeds claimedTaskIds into envelope metadata when provided', async () => {
    await sendTeammateIdleNotification({
      teammateAgentId: 'researcher@alpha',
      leadAgentId: 'team-lead@alpha',
      teamName: TEAM_NAME,
      reason: 'no_more_tasks',
      claimedTaskIds: ['t1', 't3'],
      workspaceRoot,
    })
    const lines = await peekTeamMailbox(workspaceRoot, TEAM_NAME, 'team-lead@alpha')
    const envelope = JSON.parse(lines[0].replace(/^\[[^\]]+]\s+/, '')) as Record<string, unknown>
    const metadata = envelope.metadata as Record<string, unknown> | undefined
    expect(metadata?.claimedTaskIds).toEqual(['t1', 't3'])
    // Audit fix F-01: legacy field name must NOT be emitted any more —
    // it would still parse on the receive side, but emitting it would
    // re-introduce the "claimed-but-not-completed misreport" defect.
    expect(metadata?.completedTaskIds).toBeUndefined()
  })

  it('skips empty / blank entries in claimedTaskIds', async () => {
    await sendTeammateIdleNotification({
      teammateAgentId: 'researcher@alpha',
      leadAgentId: 'team-lead@alpha',
      teamName: TEAM_NAME,
      reason: 'no_more_tasks',
      claimedTaskIds: ['', '  ', 't1'],
      workspaceRoot,
    })
    const lines = await peekTeamMailbox(workspaceRoot, TEAM_NAME, 'team-lead@alpha')
    const envelope = JSON.parse(lines[0].replace(/^\[[^\]]+]\s+/, '')) as Record<string, unknown>
    const metadata = envelope.metadata as Record<string, unknown> | undefined
    expect(metadata?.claimedTaskIds).toEqual(['t1'])
  })
})
