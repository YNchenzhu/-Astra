/**
 * Integration checks aligned with purrfect-tumbling-lerdorf.md § 验证计划:
 * - Bash security gate on registry tool (no spawn on deny)
 * - Team durable mailbox + live pending queue
 * - Token budget: see activeAgentRegistry.test.ts + subAgentRunner (recordAgentTokenUsage)
 */

import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { toolRegistry } from '../tools/registry'
import { setWorkspacePath } from '../tools/workspaceState'
import {
  clearTeams,
  persistTeamFile,
  sendTeamMessage,
  getTeamStatus,
  type Team,
} from '../tools/TeamCreateTool'
import { registerActiveAgent, unregisterActiveAgent } from '../agents/activeAgentRegistry'
import type { ActiveAgent } from '../agents/types'
import type { BuiltInAgentDefinition } from '../agents/types'
import { resolveToolPermissionMode } from '../ai/permissionRuleMatch'

const stubDef: BuiltInAgentDefinition = {
  source: 'built-in',
  agentType: 'Explore',
  whenToUse: '',
  getSystemPrompt: () => '',
}

afterEach(() => {
  setWorkspacePath(null)
  clearTeams()
})

describe('verification plan (integration)', () => {
  it('INT-PERM: deny rule resolves before hook layer (same contract as PHI-* in permissionRuleMatch.test)', () => {
    const r = resolveToolPermissionMode('write_file', 'ask', [
      { id: 'block-writes', pattern: 'write_file', mode: 'deny' },
    ])
    expect(r.effectiveMode).toBe('deny')
    expect(r.matchedRule).toBe(true)
  })

  it('Bash tool returns failure without executing denied commands', async () => {
    const bash = toolRegistry.get('bash')
    expect(bash?.execute).toBeTypeOf('function')

    const rm = await bash!.execute!({
      command: 'rm -f /tmp/nonexistent-astra-test',
    } as Record<string, unknown>)
    expect(rm.success).toBe(false)
    expect(rm.error).toBeTruthy()

    const inject = await bash!.execute!({
      command: 'echo `id`',
    } as Record<string, unknown>)
    expect(inject.success).toBe(false)
  })

  it('Team + sendTeamMessage delivers to running agent pending queue and TeamFile', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-verify-team-'))
    setWorkspacePath(ws)

    const team: Team = {
      teamName: 'verify-team',
      leadAgentId: 'lead-v',
      members: ['lead-v', 'worker-v'],
      createdAt: Date.now(),
      mailbox: {},
    }
    await persistTeamFile(ws, team)

    const worker: ActiveAgent = {
      agentId: 'worker-v',
      agentType: 'Explore',
      agentDef: stubDef,
      description: 'worker',
      teamName: 'verify-team',
      messages: [],
      pendingMessages: [],
      abortController: new AbortController(),
      startTime: Date.now(),
      status: 'running',
      resolve: () => {},
    }
    registerActiveAgent(worker)

    try {
      const sent = await sendTeamMessage(ws, 'verify-team', 'lead-v', 'worker-v', 'do the thing')
      expect(sent.ok).toBe(true)
      expect(worker.pendingMessages.length).toBeGreaterThanOrEqual(1)

      const status = getTeamStatus('verify-team')
      expect(status).not.toBeNull()
      expect(status!.members.some((m) => m.agentId === 'worker-v')).toBe(true)
    } finally {
      unregisterActiveAgent('worker-v')
      try {
        fs.rmSync(ws, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })
})
