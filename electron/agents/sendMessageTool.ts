/**
 * SendMessage tool — inter-agent communication + TeamFile mailbox persistence.
 *
 * Phase 3: structured envelope (optional), `team:<name>` broadcast routing.
 */

import type { ToolResult } from '../tools/types'
import { buildTool } from '../tools/buildTool'
import { sendMessageInputZod } from '../tools/toolInputZod'
import {
  enqueueAgentMailboxMessage,
  getActiveAgent,
  getActiveAgents,
  lookupActiveAgent,
} from './activeAgentRegistry'
import { getAgentContext } from './agentContext'
import { appendTeamMailbox } from '../tools/teamMailbox'
import { asAgentId, type AgentId } from '../tools/ids'
import {
  broadcastTeamMessage,
  formatTeamMailboxEnvelopeLine,
  formatTeamMailboxLine,
  getAllTeams,
} from '../tools/TeamCreateTool'
import { tryResolveNameFallback } from './sendMessageNameFallback'
import { getWorkspacePath } from '../tools/workspaceState'
import { parseSendMessageTarget, sendMessageRouteDescription } from './sendMessageRouting'
import {
  getInterAgentSchema,
  listInterAgentSchemas,
  stringifyTeamInterAgentMessage,
  validateInterAgentMessage,
  type TeamInterAgentMessage,
} from './teamInterAgentProtocol'

export type SendMessageEnvelopeType = 'task' | 'result' | 'query' | 'broadcast'

/** Build JSON body for upstream-style §7.7 structured team messages (store in `message`). */
export function formatTeamInterAgentProtocolMessage(msg: TeamInterAgentMessage): string {
  return stringifyTeamInterAgentMessage(msg)
}

/**
 * P1-13: persist a mailbox line to the durable TeamFile. Returns whether the
 * write actually happened so callers can surface "in-memory only" deliveries
 * to the user instead of falsely claiming persistence.
 *
 * The previous implementation silently returned when `workspaceRoot` or
 * `teamName` was missing; in broadcast and post-resume code paths that
 * bubbled up as success messages while the line was lost on the next
 * restart. We now warn loudly on those paths and report the skip back.
 */
async function persistMailboxLine(
  agentId: AgentId,
  teamName: string | undefined,
  line: string,
): Promise<{ persisted: boolean; reason?: 'no_workspace' | 'no_team' | 'error' }> {
  const ws = getWorkspacePath()
  if (!ws) {
    console.warn(
      `[SendMessage] persist skipped — workspace path unavailable (agent=${agentId}, team=${teamName ?? '∅'})`,
    )
    return { persisted: false, reason: 'no_workspace' }
  }
  const team = teamName?.trim()
  if (!team) {
    console.warn(
      `[SendMessage] persist skipped — no teamName supplied (agent=${agentId}); ` +
        `message stays in-memory only and will be lost on restart.`,
    )
    return { persisted: false, reason: 'no_team' }
  }
  try {
    await appendTeamMailbox(ws, team, agentId, line)
    return { persisted: true }
  } catch (err) {
    console.warn(
      `[SendMessage] persist failed for agent=${agentId} team=${team}:`,
      err instanceof Error ? err.message : String(err),
    )
    return { persisted: false, reason: 'error' }
  }
}

function buildLine(params: {
  from: string
  to: string
  teamName?: string
  type: SendMessageEnvelopeType
  payload: string
  legacyPlain?: boolean
}): string {
  if (params.legacyPlain) {
    return formatTeamMailboxLine(params.payload)
  }
  return formatTeamMailboxEnvelopeLine({
    from: params.from,
    to: params.to,
    teamName: params.teamName,
    type: params.type,
    payload: params.payload,
  })
}

export const sendMessageTool = buildTool({
  name: 'SendMessage',
  zInputSchema: sendMessageInputZod,
  description:
    'Inter-agent messaging + TeamFile durability. ' +
    'Address members by their NAME (e.g. "researcher"), the same name used when the Agent tool spawned them. ' +
    'Do NOT send to the team `lead_agent_id` returned by TeamCreate — the lead is the calling agent itself. ' +
    sendMessageRouteDescription() +
    ' Optional `type` / `payload` envelope; otherwise `message` is the body. ' +
    'Live agents also receive an in-memory queue before the next model turn. ' +
    'If a direct target is completed/failed but still registered, SendMessage may **resume** it when this run has provider `config` + `model` (§7.7). ' +
    'If there is **no** registry row but a **disk sidechain** exists under `.claude/subagent-sidechains/`, a new run is started from that snapshot (same `agentId` when on disk). ' +
    'Structured team protocol: JSON with `schema":"openclaude.team.v1"` and `kind` (e.g. `shutdown_request`); see `formatTeamInterAgentProtocolMessage`. ' +
    'Set `schema:"<name>"` (e.g. `plan_approval_request`) to validate the JSON message body against a registered Zod schema BEFORE delivery — invalid handoffs are rejected at send time so receivers never see malformed structured fields.',
  inputSchema: [
    {
      name: 'to',
      type: 'string',
      description:
        'Recipient: member NAME (preferred), agent id, `*`, `team:<name>`, `mailbox:<agentId>`, `bridge:<id>` (in-process). The team `lead_agent_id` from TeamCreate is the calling agent itself and is not a valid SendMessage target.',
      required: true,
    },
    { name: 'message', type: 'string', description: 'Message body (or default payload when using structured fields)', required: true },
    { name: 'type', type: 'string', description: 'Optional: task | result | query | broadcast' },
    { name: 'payload', type: 'string', description: 'Optional body; defaults to message when omitted' },
    { name: 'team_name', type: 'string', description: 'Override team for mailbox persistence (else from agent context)' },
    { name: 'plain', type: 'boolean', description: 'If true, persist a plain timestamped line (no JSON envelope)' },
    {
      name: 'schema',
      type: 'string',
      description:
        'Optional registered inter-agent schema name. When set, the message body is parsed as JSON and validated against the schema; invalid bodies are rejected with the field-level errors so the model can self-correct. Use one of the registered names (defaults include each TeamInterAgentKind, e.g. `plan_approval_request`, `permission_response`, `mode_set_request`).',
    },
  ],
  isReadOnly: true,
  isConcurrencySafe: false,
  async call({ to, message, type, payload, team_name, plain, schema }, _ctx): Promise<ToolResult> {
    const ctx = getAgentContext()
    const fromId = ctx?.agentId ?? 'unknown'
    const teamFromCtx =
      (typeof team_name === 'string' && team_name.trim()) || ctx?.teamId || undefined

    const rawPayload =
      typeof payload === 'string' && payload.trim() ? payload.trim() : (message || '').trim()
    if (!rawPayload && (to || '').trim() !== '*') {
      return { success: false, error: 'message (or payload) is required' }
    }

    // Typed inter-agent handoff — when the caller named a schema, validate the
    // body against it BEFORE delivery so malformed structured handoffs are
    // rejected at the source instead of being mis-parsed downstream. The
    // legacy free-form path (no `schema`) is unchanged.
    const schemaName = typeof schema === 'string' ? schema.trim() : ''
    if (schemaName) {
      const registered = getInterAgentSchema(schemaName)
      if (!registered) {
        return {
          success: false,
          error:
            `Unknown inter-agent schema "${schemaName}". ` +
            `Registered: ${listInterAgentSchemas().join(', ')}.`,
        }
      }
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(rawPayload)
      } catch (err) {
        return {
          success: false,
          error:
            `schema="${schemaName}" requires a JSON message body but JSON.parse failed: ` +
            (err instanceof Error ? err.message : String(err)),
        }
      }
      const v = validateInterAgentMessage(parsedJson, schemaName)
      if (!v.ok) {
        return {
          success: false,
          error:
            `Schema validation failed for "${schemaName}": ${v.errors.join('; ')}. ` +
            `Fix the message body and retry, or omit the schema parameter to send a free-form message.`,
        }
      }
    }

    const allowed: SendMessageEnvelopeType[] = ['task', 'result', 'query', 'broadcast']
    const envType: SendMessageEnvelopeType =
      typeof type === 'string' && allowed.includes(type as SendMessageEnvelopeType)
        ? (type as SendMessageEnvelopeType)
        : 'task'

    const legacyPlain = plain === true

    const normalizedTo = (to || '').trim()
    const parsed = parseSendMessageTarget(normalizedTo)

    if (parsed.kind === 'unsupported_uds') {
      return {
        success: false,
        error:
          'SendMessage: only `uds:astra:<id|name>` is supported (in-process; same as `bridge:`). ' +
          'Other `uds:` filesystem sockets are not available in this host. ' +
          'Use agent id/name, `*`, `team:<name>`, `mailbox:<agentId>`, or `bridge:<id>`.',
      }
    }

    if (parsed.kind === 'team_broadcast') {
      const teamTarget = parsed.teamName
      const ws = getWorkspacePath()
      if (!ws) {
        return { success: false, error: 'team broadcast requires an open workspace.' }
      }
      if (!teamTarget) {
        return { success: false, error: 'team:<name> requires a team name after the prefix.' }
      }
      const { delivered, recipientIds } = await broadcastTeamMessage(
        ws,
        teamTarget,
        fromId,
        rawPayload,
        { type: envType },
      )
      return {
        success: delivered > 0,
        output:
          delivered > 0
            ? `Team broadcast to ${delivered} recipient(s): ${recipientIds.join(', ') || '(see TeamFile)'}`
            : `No recipients for team "${teamTarget}" (create the team and spawn agents with team_name).`,
        error: delivered > 0 ? undefined : `No recipients for team "${teamTarget}".`,
      }
    }

    if (parsed.kind === 'broadcast_all') {
      let sentCount = 0
      let skippedSelf = false
      let droppedCount = 0
      for (const [, agent] of getActiveAgents()) {
        if (agent.status !== 'running') continue
        if (String(agent.agentId) === String(fromId)) {
          skippedSelf = true
          continue
        }
        const line = buildLine({
          from: fromId,
          to: '*',
          teamName: agent.teamName || teamFromCtx,
          type: envType,
          payload: rawPayload,
          legacyPlain,
        })
        const enq = enqueueAgentMailboxMessage(agent, line)
        if (enq.droppedOldest) droppedCount++
        await persistMailboxLine(agent.agentId, agent.teamName || teamFromCtx, line)
        sentCount++
      }
      return {
        success: sentCount > 0,
        output: sentCount > 0
          ? `Message broadcast to ${sentCount} running agent(s).` +
            (skippedSelf ? ' Sender was skipped to avoid self-broadcast loops.' : '') +
            (droppedCount > 0 ? ` ${droppedCount} recipient queue(s) dropped their oldest unread message due to mailbox limits.` : '')
          : skippedSelf
            ? 'No other running agents to send the message to (sender skipped to avoid self-broadcast loops).'
            : 'No running agents to send the message to.',
      }
    }

    if (parsed.kind === 'mailbox_durable') {
      const ws = getWorkspacePath()
      if (!ws) {
        return { success: false, error: 'mailbox: routing requires an open workspace.' }
      }
      const team = teamFromCtx?.trim()
      if (!team) {
        return {
          success: false,
          error:
            'mailbox:<agentId> requires `team_name` or agent context `teamId` so the TeamFile is known.',
        }
      }
      const key = parsed.agentKey.trim()
      if (!key) {
        return { success: false, error: 'mailbox:<agentId> needs a non-empty agent id.' }
      }
      const line = buildLine({
        from: fromId,
        to: `mailbox:${key}`,
        teamName: team,
        type: envType,
        payload: rawPayload,
        legacyPlain,
      })
      await appendTeamMailbox(ws, team, key, line)
      const live = getActiveAgent(key)
      if (live?.status === 'running') {
        enqueueAgentMailboxMessage(live, line)
      }
      return {
        success: true,
        output: `Durable mailbox write for "${key}" on team "${team}"` +
          (live?.status === 'running' ? ' (running agent also queued).' : ' (recipient not running; file only).'),
      }
    }

    const lookupId =
      parsed.kind === 'bridge_in_process' ? parsed.targetId.trim() : parsed.raw

    if (parsed.kind === 'bridge_in_process' && (!lookupId || lookupId === '*')) {
      return {
        success: false,
        error: 'bridge:<id> requires a concrete agent id or name after the prefix.',
      }
    }

    // P1-7: distinguish ambiguous-name from not-found — previously both
    // collapsed to `undefined`, falling through to disk recovery and
    // returning a misleading "no active agent" error.
    const lookup = lookupActiveAgent(lookupId)
    if (lookup.kind === 'ambiguous') {
      const ids = lookup.candidates.map((c) => c.agentId).slice(0, 5).join(', ')
      const more = lookup.candidates.length > 5 ? ` (+${lookup.candidates.length - 5} more)` : ''
      return {
        success: false,
        error:
          `Ambiguous agent name "${lookupId}": ${lookup.count} running instances ` +
          `[${ids}${more}]. Use the exact agentId, team:<name>, or mailbox:<id>.`,
      }
    }
    const target = lookup.kind === 'found' ? lookup.agent : undefined
    if (!target) {
      const ws = getWorkspacePath()?.trim()
      if (ws && ctx?.config && typeof ctx.model === 'string' && ctx.model.trim()) {
        const { tryResumeFromDiskTranscript } = await import('./sendMessageDiskRecovery')
        const disk = await tryResumeFromDiskTranscript({
          workspaceRoot: ws,
          lookupId,
          inboundBody: rawPayload,
          config: ctx.config,
          model: ctx.model,
          signal: ctx.signal,
        })
        if (disk) {
          const teamForLine = teamFromCtx || disk.teamName
          const line = buildLine({
            from: fromId,
            to: lookupId,
            teamName: teamForLine,
            type: envType,
            payload: rawPayload,
            legacyPlain,
          })
          await persistMailboxLine(disk.agentId, teamForLine, line)
          return {
            success: true,
            output:
              `No live agent "${lookupId}"; started **disk sidechain recovery** (agentId=${disk.agentId}).`,
          }
        }
      }

      // S2: NAME-first mailbox fallback. When the caller has a team
      // scope (explicit `team_name` or ALS `ctx.teamId`), accept lead
      // aliases ("lead" / "team-lead") and any registered member name —
      // even if the target is not currently `running`. Mirrors
      // upstream's "address by NAME, mailbox does the rest" semantics.
      const fallback = tryResolveNameFallback({
        lookupId,
        callerAgentId: String(fromId),
        callerIsTeammate: !!ctx?.teammate,
        teamHint: teamFromCtx,
      })
      if (fallback.kind === 'self_lead') {
        return {
          success: false,
          error:
            `"${lookupId}" resolves to the lead of team "${fallback.teamName}" — and you ARE that lead. ` +
            'You cannot SendMessage to yourself. Spawn members with the Agent tool (`team_name` + `name`) and SendMessage them by NAME, ' +
            `or use \`to: "team:${fallback.teamName}"\` to broadcast.`,
        }
      }
      if (fallback.kind === 'ambiguous') {
        const ids = fallback.candidates.map((c) => c.agentId).slice(0, 5).join(', ')
        const more =
          fallback.candidates.length > 5 ? ` (+${fallback.candidates.length - 5} more)` : ''
        return {
          success: false,
          error:
            `Ambiguous member name "${fallback.agentName}" in team "${fallback.teamName}": ` +
            `${fallback.candidates.length} matching members [${ids}${more}]. ` +
            'Use the exact agentId or `mailbox:<agentId>`.',
        }
      }
      if (fallback.kind === 'lead') {
        const line = buildLine({
          from: fromId,
          to: lookupId,
          teamName: fallback.teamName,
          type: envType,
          payload: rawPayload,
          legacyPlain,
        })
        const persisted = await persistMailboxLine(
          asAgentId(fallback.leadAgentId),
          fallback.teamName,
          line,
        )
        if (!persisted.persisted) {
          return {
            success: false,
            error:
              `Resolved "${lookupId}" to team "${fallback.teamName}" lead but mailbox persistence failed (${persisted.reason ?? 'unknown'}).`,
          }
        }
        return {
          success: true,
          output:
            `Delivered to team "${fallback.teamName}" lead via mailbox (agentId=${fallback.leadAgentId}). ` +
            'The lead reads it through the next `<team-inbox>` digest.',
        }
      }
      if (fallback.kind === 'member') {
        const line = buildLine({
          from: fromId,
          to: lookupId,
          teamName: fallback.teamName,
          type: envType,
          payload: rawPayload,
          legacyPlain,
        })

        if (fallback.agent.status === 'running') {
          // Live queue + persist (running matches the unmodified
          // direct_active path).
          enqueueAgentMailboxMessage(fallback.agent, line)
          await persistMailboxLine(
            fallback.agent.agentId,
            fallback.teamName,
            line,
          )
          return {
            success: true,
            output:
              `Delivered to member "${lookupId}" (agentId=${fallback.agent.agentId}) in team "${fallback.teamName}" (running; live-queued).`,
          }
        }

        // Audit fix A1 — non-running member: a disk-only mailbox write
        // would never reach the worker (subAgentRunner reads
        // `pendingMessages`, not disk). Mirror the existing
        // `target.status !== 'running'` resume path so the inbound
        // body is actually delivered as a fresh prompt to a resumed
        // run. Falls back to mailbox-only when the caller can't
        // resume (no provider config / no model in ALS).
        const cfg = ctx?.config
        const mdl = ctx?.model
        if (cfg && typeof mdl === 'string' && mdl.trim()) {
          const parentForResume =
            ctx.agentId && ctx.agentId !== 'main' ? ctx.agentId : fallback.agent.parentAgentId
          const { resumeAgentBackground } = await import('./resumeAgent')
          const resumedId = await resumeAgentBackground(
            fallback.agent.agentId,
            `[SendMessage — inbound while status=${fallback.agent.status}]\n\n${rawPayload}`,
            cfg,
            mdl,
            parentForResume,
          )
          if (resumedId) {
            await persistMailboxLine(
              fallback.agent.agentId,
              fallback.teamName,
              line,
            )
            return {
              success: true,
              output:
                `Member "${lookupId}" was ${fallback.agent.status}; resumed with inbound message (agentId=${resumedId}).`,
            }
          }
        }

        // Last-resort: persist to mailbox only. Better than dropping
        // the message — a future SendMessage retry (with provider
        // config) or an external resume can replay this from disk.
        const persisted = await persistMailboxLine(
          fallback.agent.agentId,
          fallback.teamName,
          line,
        )
        if (!persisted.persisted) {
          return {
            success: false,
            error:
              `Member "${lookupId}" (agentId=${fallback.agent.agentId}) is ${fallback.agent.status}, ` +
              `cannot resume from this run (missing provider config / model), ` +
              `and mailbox persistence failed (${persisted.reason ?? 'unknown'}). Message lost.`,
          }
        }
        return {
          success: true,
          output:
            `Member "${lookupId}" is ${fallback.agent.status} and this run lacks provider config to resume; ` +
            `wrote to disk mailbox only — replay needed before the recipient reads it.`,
        }
      }

      // S1: when the unresolved target is a team's lead id (or looks
      // like the synthetic `lead-*` form generated by TeamCreate), the
      // caller is almost certainly trying to message itself. Return a
      // tailored error that explains the mental model and points at the
      // correct primitives, instead of the generic "use *, team:, or
      // mailbox:" hint which doesn't actually unblock this case.
      const matchingTeam = getAllTeams().find((t) => t.leadAgentId === lookupId)
      const looksLikeSyntheticLeadId = /^lead-\d+-\d+$/.test(lookupId)
      if (matchingTeam || looksLikeSyntheticLeadId) {
        const teamHint = matchingTeam
          ? `team "${matchingTeam.teamName}"`
          : 'a team'
        return {
          success: false,
          error:
            `"${lookupId}" is the lead_agent_id of ${teamHint}. The lead is the calling agent itself — you cannot SendMessage to yourself. ` +
            'To delegate work, spawn members with the Agent tool (`team_name` + `name`), then SendMessage by the member NAME. ' +
            (matchingTeam
              ? `To broadcast to the whole team, use \`to: "team:${matchingTeam.teamName}"\`.`
              : 'To broadcast to the whole team, use `to: "team:<team_name>"`.'),
        }
      }
      return {
        success: false,
        error:
          `No active agent found with ID or name "${lookupId}". ` +
          'Spawn the recipient first with the Agent tool (passing `team_name` + `name`), then send by NAME. ' +
          'Other recipients: `*` (broadcast all running agents), `team:<name>`, `mailbox:<agentId>`.',
      }
    }

    // Audit 2026-06 — self-send guard for the direct-active path. The
    // NAME-fallback path already rejects `self_lead`, but a direct id /
    // name hit on the caller's own registry row slipped through: the
    // message would land in the caller's OWN `pendingMessages`, wake its
    // own mailbox wait, and re-enter the loop as fresh input — a token-
    // burning livelock a confused model can trigger indefinitely.
    if (String(target.agentId) === String(fromId)) {
      return {
        success: false,
        error:
          `SendMessage target "${lookupId}" resolves to the calling agent itself (${fromId}). ` +
          'Self-messaging is rejected. To reach the team, use `team:<name>` to broadcast or ' +
          'address another member by NAME.',
      }
    }

    if (target.status !== 'running') {
      const cfg = ctx?.config
      const mdl = ctx?.model
      if (cfg && typeof mdl === 'string' && mdl.trim()) {
        const parentForResume =
          ctx.agentId && ctx.agentId !== 'main' ? ctx.agentId : target.parentAgentId
        const { resumeAgentBackground } = await import('./resumeAgent')
        const resumedId = await resumeAgentBackground(
          target.agentId,
          `[SendMessage — inbound while status=${target.status}]\n\n${rawPayload}`,
          cfg,
          mdl,
          parentForResume,
        )
        if (resumedId) {
          const teamForLine = target.teamName || teamFromCtx
          const line = buildLine({
            from: fromId,
            to: lookupId,
            teamName: teamForLine,
            type: envType,
            payload: rawPayload,
            legacyPlain,
          })
          await persistMailboxLine(target.agentId, teamForLine, line)
          return {
            success: true,
            output:
              `Agent "${lookupId}" was ${target.status}; resumed with inbound message (agentId=${resumedId}).`,
          }
        }
      }
      return {
        success: false,
        error: `Agent "${lookupId}" is not running (status: ${target.status}).`,
      }
    }

    const teamForLine = target.teamName || teamFromCtx
    const line = buildLine({
      from: fromId,
      to: lookupId,
      teamName: teamForLine,
      type: envType,
      payload: rawPayload,
      legacyPlain,
    })

    const enq = enqueueAgentMailboxMessage(target, line)
    await persistMailboxLine(target.agentId, teamForLine, line)
    return {
      success: true,
      output: `Message sent to agent "${normalizedTo}" (${target.agentType}).` +
        (enq.droppedOldest
          ? ' The recipient mailbox was full, so its oldest unread message was dropped.'
          : ''),
    }
  },
})
