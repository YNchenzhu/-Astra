/**
 * S5 — Lead-side `shutdown_response` consumption.
 *
 * upstream's `useInboxPoller` notices a worker's `shutdown_response`
 * (approve / reject), and on approve it actively kills the worker:
 * `abortController.abort()` for in-process teammates, `gracefulShutdown`
 * for pane-backed teammates, plus removing the member from the
 * TeamFile (`removeTeammateFromTeamFile`) and unassigning its tasks.
 * cursor-ui-clone previously parsed `shutdown_response` envelopes (the
 * Zod schema is registered in `teamInterAgentProtocol.ts`) but had no
 * consumer for them, so an approved shutdown left the worker still
 * "running" until wall-clock timeout — and SendMessage to the same
 * NAME continued to land in its mailbox after the lead believed the
 * member was gone.
 *
 * This module fills that gap. Given a batch of mailbox lines just
 * drained from the lead's inbox, it splits out approved shutdown
 * responses, fires the abort + roster cleanup, and returns the
 * remaining lines so the regular `<team-inbox>` digest renderer keeps
 * working unchanged for everything else.
 *
 * Failure isolation: best-effort. We swallow / warn on every error so
 * a partially-broken TeamFile or registry can't take down the lead's
 * post-tool collector path.
 */

import { getActiveAgent } from './activeAgentRegistry'
import { parseTeamInterAgentLineWithRecord } from './teamInterAgentProtocol'
import { removeTeamMember } from '../tools/TeamCreateTool'
import { asAgentId } from '../tools/ids'

export interface ShutdownConsumeArgs {
  /** Team name — used for {@link removeTeamMember}. */
  teamName: string
  /** All envelope lines just read from the lead's mailbox. */
  lines: ReadonlyArray<string>
}

export interface ShutdownConsumeResult {
  /** Lines that were NOT shutdown_response{approve:true} — pass to renderer. */
  remaining: string[]
  /** AgentIds we attempted to abort (for tests / diagnostics). */
  approvedAgentIds: string[]
  /** AgentIds whose roster row was actually deleted. */
  removedAgentIds: string[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Pull the sender's agentId out of a parsed mailbox envelope. Tries the
 * inner protocol's `from.agentId` first, then the outer envelope's
 * `from` field, then gives up. Returning undefined causes the line to
 * be left in `remaining` (we can't safely cleanup without an id).
 */
function extractSenderAgentId(line: string, message: { from?: { agentId?: string } }): string | undefined {
  const fromMsg = message.from?.agentId?.trim()
  if (fromMsg) return fromMsg
  // Try the outer envelope (`{from, to, teamName, type, payload, ...}`).
  const stripped = line.replace(/^\[[^\]]+]\s+/, '').trim()
  if (!stripped.startsWith('{')) return undefined
  try {
    const outer = JSON.parse(stripped) as unknown
    if (isRecord(outer) && typeof outer.from === 'string') {
      const f = outer.from.trim()
      if (f) return f
    }
  } catch {
    /* ignore */
  }
  return undefined
}

/**
 * Decode `approve` from a `shutdown_response` envelope. upstream encodes
 * approval directly on the protocol; cursor-ui-clone follows the same
 * shape (`approve: boolean` on `TeamInterAgentMessage`). Reject ambiguous
 * payloads (missing `approve`, non-boolean) by treating them as not
 * approved — the lead can still inspect the reject case via the
 * digest renderer (which we leave alone for `shutdown_response`).
 */
function parseApproved(message: { approve?: boolean }): boolean {
  return message.approve === true
}

/**
 * Identify and act on `shutdown_response{approve:true}` items in `lines`.
 * Side effects per item:
 *   1. abortController.abort() if an active-registry row for the sender exists
 *   2. removeTeamMember(teamName, senderAgentId) — best-effort
 *
 * Other shutdown_response items (reject, malformed, missing sender) are
 * dropped silently from the digest as well — they are an internal
 * protocol detail the lead model doesn't need to see surfaced verbatim.
 */
export async function consumeShutdownResponses(
  args: ShutdownConsumeArgs,
): Promise<ShutdownConsumeResult> {
  const teamName = args.teamName?.trim() ?? ''
  const out: ShutdownConsumeResult = {
    remaining: [],
    approvedAgentIds: [],
    removedAgentIds: [],
  }
  if (!teamName || !args.lines.length) {
    out.remaining = [...args.lines]
    return out
  }

  for (const line of args.lines) {
    const parsed = parseTeamInterAgentLineWithRecord(line)
    const message = parsed?.message
    if (!message || message.kind !== 'shutdown_response') {
      out.remaining.push(line)
      continue
    }

    if (!parseApproved(message)) {
      // Rejection / malformed — drop from digest (the lead can't act
      // on a rejection mailbox line beyond reading it; surface as a
      // log instead so an operator can see the decision).
      console.info(
        `[teamShutdownResponseHandler] non-approving shutdown_response on team "${teamName}" — dropping from digest. requestId=${message.requestId ?? '∅'}`,
      )
      continue
    }

    const senderAgentId = extractSenderAgentId(line, message)
    if (!senderAgentId) {
      console.warn(
        `[teamShutdownResponseHandler] approved shutdown_response with no resolvable sender on team "${teamName}"; cannot abort. line=${line.slice(0, 120)}`,
      )
      continue
    }
    out.approvedAgentIds.push(senderAgentId)

    // 1. Abort the live worker if still running. Mirrors upstream's
    //    in-process branch in `handleShutdownApproval`.
    try {
      const live = getActiveAgent(senderAgentId)
      if (live && live.status === 'running') {
        try {
          live.abortController.abort()
        } catch {
          /* ignore — abortController.abort() never throws under the
           * AbortController spec, but defensive against polyfills */
        }
      }
    } catch (err) {
      console.warn(
        `[teamShutdownResponseHandler] abort lookup failed for "${senderAgentId}":`,
        err instanceof Error ? err.message : err,
      )
    }

    // 2. Remove from TeamFile.members so future TeamStatus and lead
    //    iterations see an accurate roster. removeTeamMember is idempotent
    //    and never throws.
    try {
      const removed = await removeTeamMember(teamName, asAgentId(senderAgentId))
      if (removed) out.removedAgentIds.push(senderAgentId)
    } catch (err) {
      console.warn(
        `[teamShutdownResponseHandler] removeTeamMember failed for "${senderAgentId}" on "${teamName}":`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  return out
}
