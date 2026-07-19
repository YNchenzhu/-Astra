/**
 * Host attachment collector for Kernel-owned inbox messages.
 *
 * The Kernel drains and commits the inbox atomically. The collector accepts
 * the returned authoritative snapshot; it never reconstructs the messages.
 */

import type { Collector } from '../hostAttachments'

export { KERNEL_USER_INPUT_MARKER } from '../../../constants/sideChannelKinds'

export const kernelInboxCollector: Collector = {
  name: 'kernel_inbox',
  callSites: ['post_tool', 'no_tools_continue'],

  async run(ctx) {
    const { state } = ctx
    if (!state.hostTranscript?.drainInbox) return null

    const drained = state.hostTranscript.drainInbox()
    if (!drained.injected) return null

    state.appendixReport('P2_Q_inter_agent_inject', {
      iteration: state.iteration,
      source: 'kernel_inbox',
      transcriptRevision: drained.snapshot.revision,
    })
    state.acceptHostTranscript(drained.snapshot.messages)
    return null
  },
}
