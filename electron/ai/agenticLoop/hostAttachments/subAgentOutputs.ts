/**
 * Sub-agent output collector — splices new streamed text from
 * background sub-agents into the main chat's message thread.
 *
 * ## What it does
 *
 * Background sub-agents (Explore, Plan, etc. spawned via the `Agent`
 * tool) stream their assistant output into per-agent state. The main
 * chat needs to see those updates without polling — historically this
 * was done by `injectPendingSubAgentOutputsForMainTurn` called at
 * the top of every iteration's pre-model pipeline.
 *
 * Phase B moves the call to the `post_tool` orchestrator slot so the
 * model perceives sub-agent updates as "system observations attached
 * to the prior tool batch" — same semantics as upstream's
 * `getAttachmentMessages` post-tool injections.
 *
 * ## Why a wrapper rather than a CollectorAction
 *
 * The underlying helper mutates `apiMessages` in-place with non-trivial
 * splicing logic: orphan-tool_use guard, offset rewind on defer, and
 * conditional placement (splice-before-last-user vs append). Reproducing
 * that machinery as a list of `CollectorAction` values would add risk
 * for no benefit; the existing tests
 * (`mainSubAgentContextInjection.test.ts` + the terminal-state variant)
 * pin the splicing behaviour byte-for-byte. We delegate and return an
 * explicit sync signal so the orchestrator commits the direct mutation.
 *
 * ## Where the legacy call still lives
 *
 * `streamHandler.ts` invokes the same helper on each fresh user-turn
 * entry (before the agentic loop's first iteration). That call is
 * INTENTIONALLY kept — it's the moment the user typed something and
 * the model needs to see any pending sub-agent deltas BEFORE its
 * first thought. The Phase B migration only retires the
 * `preModel.ts` per-iteration call site (the redundant in-loop refresh).
 *
 * ## Main-chat gate
 *
 * Sub-agents themselves don't have child sub-agents in this contract;
 * the injection only makes sense on the main chat. Gated on
 * `agentId === 'main'` (matches the existing `preModel.ts` guard).
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import {
  injectPendingSubAgentOutputsForMainTurn,
  type MainLoopChatMessage,
} from '../../../agents/mainSubAgentContextInjection'

export const subAgentOutputsCollector: Collector = {
  name: 'sub_agent_outputs',
  callSites: ['post_tool', 'no_tools_continue'],

  async run(ctx) {
    const { state } = ctx
    const agentCtx = getAgentContext()
    const isMainChat = !agentCtx?.agentId || agentCtx.agentId === 'main'
    if (!isMainChat) return null

    const before = state.apiMessages.length
    // The helper splices the synthetic sub-agent update into a NEW
    // array and returns it. We swap the LoopState's apiMessages
    // reference if anything changed (length-based check is sufficient:
    // the helper either inserts ≥1 message or returns the input
    // verbatim).
    const next = injectPendingSubAgentOutputsForMainTurn(
      state.apiMessages as MainLoopChatMessage[],
    ) as Array<Record<string, unknown>>
    if (next === state.apiMessages || next.length === before) return null

    state.apiMessages = next
    state.appendixReport('P2_Q_inter_agent_inject', {
      iteration: state.iteration,
      source: 'sub_agent_outputs',
    })
    return { requiresConversationSync: true }
  },
}
