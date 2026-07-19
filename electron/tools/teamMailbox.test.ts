import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { appendTeamMailbox, peekTeamMailbox, readAndClearTeamMailbox } from './teamMailbox'
import { persistTeamFile, type Team } from './TeamCreateTool'
import { clearAllLocks } from './fileLock'
import { getTeamInboxFilePath } from './teamInboxFiles'

let workspaceRoot: string

beforeAll(async () => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-team-'))
  const team: Team = {
    teamName: 'alpha',
    leadAgentId: 'lead-1',
    members: ['lead-1', 'worker-2'],
    createdAt: Date.now(),
    mailbox: {},
  }
  await persistTeamFile(workspaceRoot, team)
})

afterAll(() => {
  try {
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

afterEach(() => {
  clearAllLocks({ force: true })
})

describe('teamMailbox', () => {
  it('appends and read-clears durable lines', async () => {
    await appendTeamMailbox(workspaceRoot, 'alpha', 'worker-2', '[t] one')
    await appendTeamMailbox(workspaceRoot, 'alpha', 'worker-2', '[t] two')
    const peeked = await peekTeamMailbox(workspaceRoot, 'alpha', 'worker-2')
    expect(peeked).toEqual(['[t] one', '[t] two'])
    const first = await readAndClearTeamMailbox(workspaceRoot, 'alpha', 'worker-2')
    expect(first).toEqual(['[t] one', '[t] two'])
    const second = await readAndClearTeamMailbox(workspaceRoot, 'alpha', 'worker-2')
    expect(second).toEqual([])

    const inboxPath = getTeamInboxFilePath(workspaceRoot, 'alpha', 'worker-2')
    const inboxRaw = fs.readFileSync(inboxPath, 'utf8')
    const inbox = JSON.parse(inboxRaw) as { messages: string[]; teamName: string }
    expect(inbox.teamName).toBe('alpha')
    expect(inbox.messages).toEqual([])
  })
})
