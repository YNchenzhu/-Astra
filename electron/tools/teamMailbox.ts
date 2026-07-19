/**
 * Durable team mailbox in TeamFile JSON (`mailbox` field).
 * Writes are serialized with {@link withFileLock} for parallel sub-agents.
 */

import fs from 'node:fs'
import { getTeamFilePath, type Team, type TeamFilePayload, TEAM_FILE_VERSION } from './teamFileShared'
import { withFileLock } from './fileLock'
import { mirrorTeamMailboxToInboxFiles } from './teamInboxFiles'
import { writeJsonFileAtomic } from '../fs/atomicWrite'

function readPayloadSync(fp: string): TeamFilePayload | null {
  try {
    if (!fs.existsSync(fp)) return null
    return JSON.parse(fs.readFileSync(fp, 'utf-8')) as TeamFilePayload
  } catch {
    return null
  }
}

// P0-4: write via tmp+rename so a crash or power loss mid-write can never
// leave the team mailbox file truncated/torn (silent message loss).
function writePayloadSync(fp: string, payload: TeamFilePayload): void {
  writeJsonFileAtomic(fp, payload, 2)
}

/** Append a line to `mailbox[agentKey]` and persist TeamFile (locked). */
export async function appendTeamMailbox(
  workspaceRoot: string,
  teamName: string,
  agentKey: string,
  line: string,
): Promise<void> {
  const fp = getTeamFilePath(workspaceRoot, teamName)
  await withFileLock(fp, async () => {
    const raw = readPayloadSync(fp)
    if (!raw?.teamName) return
    const mailbox = { ...(raw.mailbox || {}) }
    const list = [...(mailbox[agentKey] || [])]
    list.push(line)
    mailbox[agentKey] = list
    const { version: _v, ...rest } = raw
    const next: TeamFilePayload = {
      version: TEAM_FILE_VERSION,
      ...(rest as Team),
      mailbox,
    }
    writePayloadSync(fp, next)
    await mirrorTeamMailboxToInboxFiles(workspaceRoot, next)
  })
}

/**
 * Read and clear `mailbox[agentKey]` (consumptive), persisting empty queue.
 * Returns the lines that were removed.
 */
/**
 * Read mailbox lines without consuming (upstream report §7.8 `readMailbox` analogue).
 * Returns a shallow copy of the current queue.
 */
export async function peekTeamMailbox(
  workspaceRoot: string,
  teamName: string,
  agentKey: string,
): Promise<string[]> {
  const fp = getTeamFilePath(workspaceRoot, teamName)
  return withFileLock(fp, async () => {
    const raw = readPayloadSync(fp)
    if (!raw?.teamName) return []
    const mailbox = raw.mailbox || {}
    return [...(mailbox[agentKey] || [])]
  })
}

export async function readAndClearTeamMailbox(
  workspaceRoot: string,
  teamName: string,
  agentKey: string,
): Promise<string[]> {
  const fp = getTeamFilePath(workspaceRoot, teamName)
  return withFileLock(fp, async () => {
    const raw = readPayloadSync(fp)
    if (!raw?.teamName) return []
    const mailbox = { ...(raw.mailbox || {}) }
    const prev = [...(mailbox[agentKey] || [])]
    mailbox[agentKey] = []
    const { version: _v, ...rest } = raw
    const next: TeamFilePayload = {
      version: TEAM_FILE_VERSION,
      ...(rest as Team),
      mailbox,
    }
    writePayloadSync(fp, next)
    await mirrorTeamMailboxToInboxFiles(workspaceRoot, next)
    return prev
  })
}
