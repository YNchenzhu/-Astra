/**
 * Inter-agent queue collector — drains pending team messages addressed
 * to the current sub-agent.
 *
 * Our multi-agent / team architecture (no upstream analog — upstream is
 * single-orchestrator) routes inter-agent protocol messages
 * (`SendMessage` payloads, team mailbox deliveries, plan-approval
 * responses, permission responses, shutdown requests) through
 * per-agent `pendingMessages` queues maintained by
 * `electron/agents/activeAgentRegistry.ts`. The agentic loop drains
 * the queue at iteration boundaries to feed those messages into the
 * model thread as side-channel user messages.
 *
 * ## Closest upstream analog
 *
 * `teammate_mailbox` / `agent_pending_messages` attachments in
 * `src/utils/attachments.ts#getAttachments` (allThreadAttachments
 * group, ~line 894 / 912). upstream pushes these into the
 * tool-results array at the post-tool point — that's the position
 * we adopt here.
 *
 * ## Important: two call sites in our loop
 *
 * Unlike upstream, we drain in TWO distinct loop positions:
 *
 *   1. `post_tool` (this collector) — the upstream-style "attach
 *      queued mailbox content after the just-finished tool batch"
 *      slot. Most common path. Fires every iteration where a
 *      sub-agent has pending messages.
 *   2. `no_tools_branch` (still inline in `noTools.ts`) — the
 *      multi-agent-specific "did anyone message me while I was
 *      thinking?" signal. When non-empty it feeds
 *      `decideIterationOutcome` (row 9, `interAgentInjected`) to force
 *      `continue` instead of terminating. Architecturally distinct:
 *      the collector returns pushed messages; the noTools call uses
 *      the return value as a continuation predicate.
 *
 * These two never conflict (each consumes the queue, so the second
 * call sees only messages that arrived after the first). Splitting
 * them by call site lets `runCollectors` own the upstream-aligned
 * post-tool path while `noTools.ts` keeps the continuation-signal
 * semantics.
 *
 * ## Skip behaviour
 *
 * The underlying `injectPendingInterAgentQueue` returns `false`
 * (and does nothing) for the main chat — only sub-agents have
 * a `pendingMessages` registry entry. The collector returns `null`
 * in that case so the orchestrator doesn't record a spurious
 * "action applied" outcome.
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import { getActiveAgent } from '../../../agents/activeAgentRegistry'
import { injectPendingInterAgentQueue } from '../../agenticLoopHelpers'

export const interAgentQueueCollector: Collector = {
  name: 'inter_agent_queue',
  callSites: ['post_tool'],

  async run(ctx) {
    const { state } = ctx
    const agentCtx = getAgentContext()
    // Main chat has no per-agent inbox to drain — short-circuit.
    if (!agentCtx?.agentId || agentCtx.agentId === 'main') return null
    const agent = getActiveAgent(agentCtx.agentId)
    if (!agent || agent.pendingMessages.length === 0) return null

    // `injectPendingInterAgentQueue` mutates `state.apiMessages` directly
    // (pushes via `makeSideChannelUserMessage`) and returns true on
    // injection. To keep the orchestrator's action-application model
    // intact we don't translate the mutation into a `CollectorAction`
    // — instead the helper already pushed, and we return `null` to
    // signal "no new action to apply" but the side effect already
    // landed. This matches the existing call-site contract and avoids
    // double-pushing the side-channel message.
    const injected = injectPendingInterAgentQueue(state.apiMessages)
    if (!injected) return null

    state.appendixReport('P2_Q_inter_agent_inject', {
      iteration: state.iteration,
      source: 'collector_post_tool',
    })
    return { requiresConversationSync: true }
  },
}
