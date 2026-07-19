/**
 * upstream report §7.9 — in-process teammate: tool permission "ask" is forwarded to the team
 * leader via durable mailbox + leader pending queue; the leader UI (or mailbox protocol) resolves
 * the worker's Promise.
 */

import type { DiffPreview, PermissionDecision } from '../ai/interactionState'
import { emitStreamEventForConversation, getPermissionMode } from '../ai/interactionState'
import { getAgentContext } from './agentContext'
import { getActiveAgent } from './activeAgentRegistry'
import { getWorkspacePath } from '../tools/workspaceState'
import { loadTeamFile, sendTeamMessage } from '../tools/TeamCreateTool'
import {
  stringifyTeamInterAgentMessage,
  TEAM_INTER_AGENT_SCHEMA,
  type TeamInterAgentMessage,
} from './teamInterAgentProtocol'

const pendingTeamLeaderPermission = new Map<
  string,
  {
    resolve: (d: PermissionDecision) => void
    timer: ReturnType<typeof setTimeout>
  }
>()

let teamPermSeq = 0

function nextTeamPermissionRequestId(): string {
  teamPermSeq += 1
  return `tperm-${Date.now()}-${teamPermSeq}`
}

const DEFAULT_LEADER_PERMISSION_MS = 120_000

/**
 * Default: any sub-agent run with a `teamId` and a resolvable TeamFile **delegates** `requiresAsk`
 * tool permission to the team leader (not {@link Team.leadAgentId}) — upstream §7.9.
 * Set `ASTRA_TEAM_LEADER_PERMISSION_MAILBOX=0` to force-disable (leader and teammates use normal `requestPermission`).
 */
export function isWorkerToolPermissionDelegatedToTeamLeader(): boolean {
  if (process.env.ASTRA_TEAM_LEADER_PERMISSION_MAILBOX?.trim() === '0') return false
  const ctx = getAgentContext()
  if (!ctx) return false
  const teamName = ctx.teamId?.trim()
  if (!teamName || ctx.agentId === 'main') return false
  const ws = getWorkspacePath()?.trim()
  if (!ws) return false
  const team = loadTeamFile(ws, teamName)
  const lead = team?.leadAgentId?.trim()
  if (!lead) return false
  if (ctx.agentId.trim() === lead) return false
  return true
}

function truncateJson(obj: unknown, maxChars: number): string {
  try {
    const s = JSON.stringify(obj)
    if (s.length <= maxChars) return s
    return `${s.slice(0, maxChars)}\n…[truncated]`
  } catch {
    return '{}'
  }
}

function buildPermissionForwardPayload(params: {
  teamRequestId: string
  workerAgentId: string
  workerConversationId?: string
  toolName: string
  description: string
  input: Record<string, unknown>
  isDestructive: boolean
}): string {
  return truncateJson(
    {
      teamRequestId: params.teamRequestId,
      workerAgentId: params.workerAgentId,
      workerConversationId: params.workerConversationId,
      toolName: params.toolName,
      description: params.description,
      input: params.input,
      isDestructive: params.isDestructive,
    },
    24_000,
  )
}

async function deliverPermissionRequestToLeader(params: {
  workspaceRoot: string
  teamName: string
  leaderAgentId: string
  workerAgentId: string
  teamRequestId: string
  protocolInner: string
}): Promise<void> {
  const innerPayload = stringifyTeamInterAgentMessage({
    schema: TEAM_INTER_AGENT_SCHEMA,
    kind: 'permission_forward',
    requestId: params.teamRequestId,
    detail: params.protocolInner,
  })
  const r = await sendTeamMessage(
    params.workspaceRoot,
    params.teamName,
    params.workerAgentId,
    params.leaderAgentId,
    innerPayload,
    { type: 'task' },
  )
  if (!r.ok) throw new Error(r.error || 'sendTeamMessage failed')
}

/**
 * Resolve a pending worker wait (IPC from leader UI, or mailbox `permission_response`).
 */
export function resolveTeamLeaderPermissionResponse(params: {
  teamRequestId: string
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  reason?: 'cancelled' | 'denied'
}): boolean {
  const entry = pendingTeamLeaderPermission.get(params.teamRequestId)
  if (!entry) return false
  try {
    clearTimeout(entry.timer)
  } catch {
    /* ignore */
  }
  pendingTeamLeaderPermission.delete(params.teamRequestId)
  entry.resolve({
    behavior: params.behavior,
    ...(params.behavior === 'deny' && { reason: params.reason ?? 'denied' }),
    ...(params.updatedInput && { updatedInput: params.updatedInput }),
  })
  return true
}

/** Mailbox line parser — leader (or tests) sends structured `permission_response`. */
export function tryResolveTeamPermissionFromProtocolMessage(msg: TeamInterAgentMessage): boolean {
  if (msg.kind !== 'permission_response' || !msg.requestId?.trim()) return false
  let updatedInput: Record<string, unknown> | undefined
  if (typeof msg.detail === 'string' && msg.detail.trim()) {
    try {
      const j = JSON.parse(msg.detail) as { updatedInput?: Record<string, unknown> }
      if (j?.updatedInput && typeof j.updatedInput === 'object') updatedInput = j.updatedInput
    } catch {
      /* ignore */
    }
  }
  return resolveTeamLeaderPermissionResponse({
    teamRequestId: msg.requestId.trim(),
    behavior: msg.approve === true ? 'allow' : 'deny',
    updatedInput,
    reason: msg.approve === true ? undefined : 'denied',
  })
}

export async function awaitTeamLeaderToolPermission(params: {
  toolName: string
  description: string
  input: Record<string, unknown>
  isDestructive?: boolean
  signal?: AbortSignal
  diffPreview?: DiffPreview
}): Promise<PermissionDecision> {
  const { requestPermission } = await import('../ai/interactionState')
  const ctx = getAgentContext()
  const teamName = ctx?.teamId?.trim()
  const ws = getWorkspacePath()?.trim()
  if (!teamName || !ws || !ctx || ctx.agentId === 'main') {
    return requestPermission(params)
  }
  const team = loadTeamFile(ws, teamName)
  if (!team?.leadAgentId || team.leadAgentId === ctx.agentId) {
    return requestPermission(params)
  }

  const teamRequestId = nextTeamPermissionRequestId()
  const leader = getActiveAgent(team.leadAgentId)
  const leaderConversationId =
    typeof leader?.streamConversationId === 'string' && leader.streamConversationId.trim()
      ? leader.streamConversationId.trim()
      : undefined

  return new Promise(resolve => {
    if (params.signal?.aborted) {
      resolve({ behavior: 'deny', reason: 'cancelled' })
      return
    }

    const ms = Number(process.env.ASTRA_TEAM_PERMISSION_TIMEOUT_MS)
    const timeoutMs =
      Number.isFinite(ms) && ms > 5_000 ? ms : DEFAULT_LEADER_PERMISSION_MS

    const onAbort = () => {
      resolveTeamLeaderPermissionResponse({
        teamRequestId,
        behavior: 'deny',
        reason: 'cancelled',
      })
    }
    if (params.signal) {
      params.signal.addEventListener('abort', onAbort, { once: true })
    }

    const timer = setTimeout(() => {
      resolveTeamLeaderPermissionResponse({
        teamRequestId,
        behavior: 'deny',
        reason: 'denied',
      })
    }, timeoutMs)

    pendingTeamLeaderPermission.set(teamRequestId, {
      resolve: (d: PermissionDecision) => {
        try {
          clearTimeout(timer)
        } catch {
          /* ignore */
        }
        if (params.signal) params.signal.removeEventListener('abort', onAbort)
        resolve(d)
      },
      timer,
    })

    const inner = buildPermissionForwardPayload({
      teamRequestId,
      workerAgentId: ctx.agentId,
      workerConversationId: ctx.streamConversationId,
      toolName: params.toolName,
      description: params.description,
      input: params.input,
      isDestructive: params.isDestructive ?? false,
    })

    void deliverPermissionRequestToLeader({
      workspaceRoot: ws,
      teamName,
      leaderAgentId: team.leadAgentId,
      workerAgentId: ctx.agentId,
      teamRequestId,
      protocolInner: inner,
    }).catch((e) => {
      console.warn('[TeamPermission] deliver to leader failed:', e)
      resolveTeamLeaderPermissionResponse({ teamRequestId, behavior: 'deny', reason: 'denied' })
    })

    emitStreamEventForConversation(leaderConversationId, {
      type: 'team_permission_request',
      teamRequestId,
      workerAgentId: ctx.agentId,
      teamName,
      toolName: params.toolName,
      description: `[Teammate ${ctx.agentId}] ${params.description}`,
      input: params.input,
      isDestructive: params.isDestructive,
      mode: getPermissionMode(),
      diffPreview: params.diffPreview,
      requestId: teamRequestId,
    })
  })
}

/** Leader / automation: body for `SendMessage` `message` to unblock worker (§7.9 mailbox path). */
export function buildTeamPermissionResponsePayload(params: {
  teamRequestId: string
  approve: boolean
  updatedInput?: Record<string, unknown>
}): string {
  return stringifyTeamInterAgentMessage({
    schema: TEAM_INTER_AGENT_SCHEMA,
    kind: 'permission_response',
    requestId: params.teamRequestId.trim(),
    approve: params.approve,
    ...(params.updatedInput && {
      detail: JSON.stringify({ updatedInput: params.updatedInput }),
    }),
  })
}
