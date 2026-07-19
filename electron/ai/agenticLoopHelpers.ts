/**
 * Agentic loop — small helper functions that don't depend on loop closure state.
 */

import { getActivePlanStatus } from '../planning/planRuntime'
import { getAgentContext } from '../agents/agentContext'
import { getActiveAgent } from '../agents/activeAgentRegistry'
import {
  parseTeamInterAgentLineWithRecord,
  validateInterAgentMessage,
} from '../agents/teamInterAgentProtocol'
import { tryResolveTeamPermissionFromProtocolMessage } from '../agents/teamPermissionLeaderBridge'
import { tryResolveTeamPlanApprovalFromProtocolMessage } from '../agents/teamPlanApprovalLeaderBridge'
import { SIDE_CHANNEL_KIND, makeSideChannelUserMessage } from '../constants/sideChannelKinds'

/**
 * Collect the `conversationId` / `agentId` / `planFilePath` fields that
 * `generatePostCompactAttachments` ({@link ../context/postCompactAttachments})
 * uses to rehydrate session-memory + active-plan + invoked-skill snippets
 * after an auto-compact. Previously these were dropped when we built
 * `compactOptions` inline at the two call sites — causing the reinjection
 * to silently no-op for every main-chat / sub-agent turn (audit Bug 3).
 */
export function buildCompactSideAttachmentIds(): {
  conversationId?: string
  agentId?: string
  planFilePath?: string
} {
  const ctx = getAgentContext()
  const conversationId = ctx?.streamConversationId?.trim() || undefined
  const agentId = ctx?.agentId?.trim() || undefined
  // Plan file is a process-wide singleton owned by the main chat. Sub-agents
  // (including background and async agents) MUST NOT pull the main thread's
  // plan into their post-compact attachments — it would leak plan content into
  // unrelated sub-agent sessions and confuse the model about whose plan it is
  // working on. Restrict attachment to the main agent only.
  let planFilePath: string | undefined
  if (!agentId || agentId === 'main') {
    try {
      const plan = getActivePlanStatus()
      planFilePath = plan?.planFilePath?.trim() || undefined
    } catch (e) {
      // Surface the failure so a broken plan-runtime dependency doesn't
      // silently look like "no active plan" to post-compact attachment code.
      console.warn('[Agentic Loop] getActivePlanStatus failed:', e)
      planFilePath = undefined
    }
  }
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(planFilePath ? { planFilePath } : {}),
  }
}

/**
 * Deliver SendMessage / team queue into the model thread (background + foreground sub-agents).
 *
 * For each queued line we:
 *   1. Try to parse the upstream inter-agent protocol envelope.
 *   2. If the parsed `kind` has a registered Zod schema, run it against the
 *      raw record and surface the validation result inline (`✓` or
 *      `⚠ FAILED: ...`). Receivers see invalid handoffs explicitly rather
 *      than silently consuming malformed structured fields.
 *   3. Handle stateful kinds (`permission_response`, `shutdown_request`) as
 *      before.
 *
 * @returns true if at least one queued message was injected as a synthetic user turn.
 */
export function injectPendingInterAgentQueue(apiMessages: Array<Record<string, unknown>>): boolean {
  const ctx = getAgentContext()
  const agent = ctx?.agentId && ctx.agentId !== 'main' ? getActiveAgent(ctx.agentId) : undefined
  if (!ctx?.agentId || ctx.agentId === 'main') return false
  if (!agent || agent.pendingMessages.length === 0) return false
  const batch = agent.pendingMessages.splice(0, agent.pendingMessages.length)
  const protocolNotes: string[] = []
  const messageBlocks: string[] = []
  let blockIndex = 0
  for (const line of batch) {
    const parsed = parseTeamInterAgentLineWithRecord(line)
    const p = parsed?.message
    if (p?.kind === 'permission_response') {
      tryResolveTeamPermissionFromProtocolMessage(p)
      continue
    }
    // P0-2 (upstream §6.2): consume the leader's reply to a worker's
    // ExitPlanMode `plan_approval_request`. Like `permission_response`,
    // we silently swallow it here (no synthetic user turn) — the
    // worker's awaiting Promise resolves and the ExitPlanMode tool
    // completes, which is the user-visible signal.
    if (p?.kind === 'plan_approval_response') {
      tryResolveTeamPlanApprovalFromProtocolMessage(p)
      continue
    }

    // Validate the raw record against the registered schema for this kind
    // (when one exists). Schemas live in teamInterAgentProtocol.ts.
    let validationTag = ''
    if (parsed && p?.kind) {
      const v = validateInterAgentMessage(parsed.record, p.kind)
      validationTag = v.ok
        ? ` (schema:${p.kind} ✓)`
        : ` (schema:${p.kind} ⚠ FAILED — ${v.errors.join('; ')})`
    }

    // Audit fix R2-M5 — render sender attribution when the message
    // carries a `from` field. Lets the recipient agent see "this
    // shutdown_request came from agent <type> (<id>)" instead of
    // having to guess from context. Senders that pre-date the field
    // get an empty `fromTag` and behave as before.
    const fromTag = p?.from
      ? ` from ${p.from.agentType ?? '?'} (${p.from.agentId})`
      : ''
    if (p?.kind === 'shutdown_request') {
      agent.pendingTeamShutdown = {
        requestId: (p.requestId && p.requestId.trim()) || 'default',
        receivedAt: Date.now(),
      }
      protocolNotes.push(
        `- shutdown_request${fromTag} (requestId=${agent.pendingTeamShutdown.requestId})${validationTag}`,
      )
    } else if (p?.kind) {
      // Non-stateful kind — surface the parse + validation summary in the header
      // so the model sees structured context alongside the raw line.
      protocolNotes.push(`- ${p.kind}${fromTag}${validationTag}`)
    }
    blockIndex++
    const blockHeader = fromTag
      ? `### Message ${blockIndex}${fromTag}${validationTag}`
      : `### Message ${blockIndex}${validationTag}`
    messageBlocks.push(`${blockHeader}\n${line}`)
  }
  const protocolHeader =
    protocolNotes.length > 0
      ? `**Team protocol (parsed)**\n${protocolNotes.join('\n')}\n\n`
      : ''
  if (messageBlocks.length === 0 && !protocolHeader) return false
  const body = protocolHeader + messageBlocks.join('\n\n')
  // P1-13 — wrap inter-agent injection with `<system-reminder>` and tag with
  // `_convertedFromSystem` so:
  //   1. The model treats this as side-channel system context, not a fresh
  //      user instruction (system prompt explicitly defines this tag).
  //   2. `smooshSystemReminderSiblings` can fold it with adjacent injected
  //      reminders.
  apiMessages.push(
    makeSideChannelUserMessage(
      SIDE_CHANNEL_KIND.sendMessageMailbox,
      `[SendMessage / team mailbox]\nNew messages for this agent:\n\n${body}`,
    ),
  )
  return true
}

/**
 * Audit P2-2 — clone outcome reported via {@link CloneApiMessagesOptions.onCloneError}.
 *
 *   - `'json'` — `structuredClone` threw (e.g. BigInt / Symbol / function in
 *     the transcript) and the JSON-stringify fallback succeeded. Caller
 *     still gets a fresh deep copy but with the JSON-incompatible fields
 *     dropped.
 *   - `'frozen-shared'` — BOTH clone strategies threw. Caller gets a
 *     `Object.freeze`-d shared reference: kernel + AgentContext + loop all
 *     read the same array. Freezing is best-effort; nested arrays /
 *     objects are also frozen one level deep so the model's structured
 *     content blocks can't be silently mutated by either side.
 */
export type CloneFallbackMode = 'json' | 'frozen-shared'

export interface CloneApiMessagesOptions {
  /**
   * Audit P2-2 — fires when a fallback layer kicks in.
   *
   * The helper continues to return a valid value regardless of whether
   * this callback is set; the callback exists so callers (e.g.
   * `setupAgenticLoopForRun`'s `syncConversation`) can route the event to
   * the kernel transport for a typed `transcript_clone_degraded` phase
   * event, instead of just `console.warn`-ing into the void.
   *
   * `primaryError` is the error from the FIRST strategy that failed
   * (structuredClone when available, else JSON). `secondaryError` is set
   * only when `mode === 'frozen-shared'` (i.e. JSON also threw).
   *
   * Audit SA-6 — `occurrenceCount` is the process-lifetime running count
   * of degradations in this `mode` (including this one), so consumers can
   * distinguish a one-off unclonable transcript from a persistent
   * dual-source drift risk.
   */
  onCloneError?: (info: {
    mode: CloneFallbackMode
    primaryError: unknown
    secondaryError?: unknown
    messageCount: number
    occurrenceCount: number
  }) => void
}

// Audit SA-6 — cumulative degradation counters. The typed phase event is
// deduped to once-per-run by its consumer, which previously left no
// occurrence count anywhere: a transcript that failed to clone on EVERY
// `syncConversation` call looked identical to one that failed once. Every
// fallback occurrence now increments these counters and emits a counted
// console warning, so the frequency is observable even when the typed
// event is suppressed.
const cloneDegradationCounts: Record<CloneFallbackMode, number> = {
  json: 0,
  'frozen-shared': 0,
}

/** Audit SA-6 — test seam: reset the process-lifetime degradation counters. */
export function __resetCloneDegradationCountsForTests(): void {
  cloneDegradationCounts.json = 0
  cloneDegradationCounts['frozen-shared'] = 0
}

/** Audit SA-6 — count + warn on EVERY degradation, then notify the caller. */
function reportCloneDegradation(
  info: {
    mode: CloneFallbackMode
    primaryError: unknown
    secondaryError?: unknown
    messageCount: number
  },
  options?: CloneApiMessagesOptions,
): void {
  cloneDegradationCounts[info.mode]++
  const occurrenceCount = cloneDegradationCounts[info.mode]
  console.warn(
    `[Agentic Loop] transcript clone degraded to '${info.mode}' ` +
      `(occurrence #${occurrenceCount} of this mode this process, ` +
      `messages=${info.messageCount}): ` +
      (info.primaryError instanceof Error
        ? info.primaryError.message
        : String(info.primaryError)),
  )
  options?.onCloneError?.({ ...info, occurrenceCount })
}

/**
 * Deep-clone apiMessages for orchestration kernel snapshot with a defensive
 * fallback ladder.
 *
 *   1. Try `structuredClone` (preferred — handles nested arrays, ArrayBuffer
 *      copies, Map/Set, …).
 *   2. On failure, try `JSON.parse(JSON.stringify(...))` (drops Bigint /
 *      Symbol / function fields but is still a real copy).
 *   3. On both failing, deep-freeze the original and share it. The kernel +
 *      AgentContext now read the same array, but the recursive
 *      `Object.freeze` blocks accidental in-place mutation by either side at
 *      every level (including nested `content` blocks and `tool_use.input`).
 *      Drift is impossible while the freeze holds; the caller can react to
 *      the typed event and request the user re-send the message to fully
 *      rebuild state.
 */
export function cloneApiMessagesForOrchestration(
  apiMessages: Array<Record<string, unknown>>,
  options?: CloneApiMessagesOptions,
): Array<Record<string, unknown>> {
  // Layer 1 — structuredClone (preferred).
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(apiMessages)
    } catch (primaryErr) {
      // Layer 2 — JSON fallback.
      try {
        const cloned = JSON.parse(JSON.stringify(apiMessages)) as Array<
          Record<string, unknown>
        >
        reportCloneDegradation(
          {
            mode: 'json',
            primaryError: primaryErr,
            messageCount: apiMessages.length,
          },
          options,
        )
        return cloned
      } catch (secondaryErr) {
        reportCloneDegradation(
          {
            mode: 'frozen-shared',
            primaryError: primaryErr,
            secondaryError: secondaryErr,
            messageCount: apiMessages.length,
          },
          options,
        )
        return deepFreezeShared(apiMessages)
      }
    }
  }
  // Environments without structuredClone (very rare; old Node, some test
  // shims). JSON fallback is the only option.
  try {
    return JSON.parse(JSON.stringify(apiMessages)) as Array<Record<string, unknown>>
  } catch (err) {
    reportCloneDegradation(
      {
        mode: 'frozen-shared',
        primaryError: err,
        messageCount: apiMessages.length,
      },
      options,
    )
    return deepFreezeShared(apiMessages)
  }
}

/**
 * Recursively freeze a SHARED apiMessages reference.
 *
 * Only reached on the degraded fallback path of
 * `cloneApiMessagesForOrchestration` where BOTH `structuredClone` and the
 * JSON round-trip failed, so the kernel and AgentContext end up reading the
 * *same* array. A shallow freeze (outer array + top-level message objects)
 * would leave `messages[i].content` blocks and nested `tool_use.input`
 * payloads writable — either consumer could then mutate the other's view and
 * cause silent drift. We deep-freeze the whole graph instead.
 *
 * Cost is a non-issue here: this is a rare, already-degraded path, the freeze
 * is one-shot (not per-mutation), and the `WeakSet` guards against the cyclic
 * structures that most likely made the JSON round-trip throw in the first
 * place (a naive recursion would otherwise stack-overflow on a cycle).
 */
function deepFreezeShared(
  msgs: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new WeakSet<object>()
  const freeze = (val: unknown): void => {
    if (val === null || typeof val !== 'object') return
    if (seen.has(val)) return
    seen.add(val)
    // Freeze the container ITSELF first — `Object.freeze` never invokes
    // accessors, so it can't throw on a poisoned (throwing-getter)
    // property. The very input that lands us on this fallback path can
    // contain such getters (that's often why structuredClone + JSON both
    // threw), so reading children to recurse MUST be isolated: a throwing
    // getter on one property must not stop this object — or its siblings —
    // from being frozen.
    try { Object.freeze(val) } catch { /* best-effort */ }
    if (Array.isArray(val)) {
      for (const item of val) {
        try { freeze(item) } catch { /* skip poisoned element */ }
      }
    } else {
      for (const key of Object.keys(val as Record<string, unknown>)) {
        try {
          freeze((val as Record<string, unknown>)[key])
        } catch {
          /* skip poisoned getter */
        }
      }
    }
  }
  try {
    freeze(msgs)
  } catch {
    /* best-effort — never let freezing crash the degraded fallback */
  }
  return msgs
}
