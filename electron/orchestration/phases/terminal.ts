/**
 * Terminal phase — invariant: always runs at the end of a turn, even when
 * PrepareContext or CallModel threw.
 *
 * Responsibilities:
 *   1. Validate the AgentContext mirror against the last Kernel-accepted
 *      transcript and commit the authoritative Kernel snapshot.
 *   2. Fire `onTranscriptCommitted` session hook (errors swallowed + logged).
 *   3. Emit consolidated artifact manifest for the turn if any artifacts exist.
 *   4. Auto-snapshot post-terminal so callers can fork the "just-finished" state
 *      to run parallel follow-up attempts against the same committed transcript.
 *
 * Note: this function does NOT fire `onSessionEnd` — the kernel owns that
 * lifecycle hook because it needs to fire even when Terminal itself throws.
 */

import { getAgentContext } from '../../agents/agentContext'
import { withPhaseSpan } from '../observability'
import { cloneTranscript, fingerprintTranscript } from '../kernelTypes'
import {
  buildArtifactManifestPhase,
  buildTranscriptDriftPhase,
  emitPhaseEvent,
} from '../transport'
import type { KernelPhaseCtx } from './types'

/**
 * Errors thrown inside Terminal are caught + logged here so that the kernel's
 * outer `finally` can still fire `onSessionEnd` regardless. Returns void —
 * any preceding `callModelError` is the caller's to re-throw.
 */
export async function runTerminalPhase(ctx: KernelPhaseCtx): Promise<void> {
  try {
    ctx.setState({ ...ctx.state, phase: 'Terminal' })
    ctx.emitPhase('Terminal')

    await withPhaseSpan(ctx.observer, 'Terminal', ctx.state.iteration, async () => {
      const agentCtx = getAgentContext()
      // Compare the complete mirror shape. Projecting AgentContext down to
      // role/content used to drop runtime fields such as `_poleContextUsage`
      // while the Kernel retained them, producing a deterministic
      // same-length fingerprint mismatch on otherwise healthy turns.
      const fromCtx =
        agentCtx?.messages && agentCtx.messages.length > 0
          ? agentCtx.messages
          : null
      // Audit SA-6 + contract audit (2026-07) — dual-source drift telemetry:
      // when AgentContext.messages and the kernel transcript disagree on
      // content identity at commit time, the two sides have diverged mid-turn.
      // The divergence is also emitted as a typed `transcript_drift` phase event so the
      // renderer / dashboards see it — a console.warn alone was invisible to
      // anyone auditing rewind or failure-recovery correctness.
      const agentContextFingerprint = fromCtx ? fingerprintTranscript(fromCtx) : null
      const kernelFingerprint =
        ctx.state.transcriptFingerprint ?? fingerprintTranscript(ctx.state.transcript)
      if (
        fromCtx &&
        agentContextFingerprint &&
        agentContextFingerprint !== kernelFingerprint
      ) {
        console.warn(
          `[OrchestrationKernel] Terminal commit: AgentContext.messages (${fromCtx.length}) ` +
            `and kernel transcript (${ctx.state.transcript.length}) diverged; ` +
            'keeping the last version accepted by the kernel.',
        )
        emitPhaseEvent(
          ctx.ports.transport,
          buildTranscriptDriftPhase({
            iteration: ctx.state.iteration,
            innerIteration: ctx.state.innerIteration,
            conversationId: ctx.streamConversationId,
            transcriptDrift: {
              agentContextLength: fromCtx.length,
              kernelTranscriptLength: ctx.state.transcript.length,
              agentContextFingerprintPrefix: agentContextFingerprint.slice(0, 12),
              kernelFingerprintPrefix: kernelFingerprint.slice(0, 12),
              resolvedWith: 'kernel',
              checkpoint: 'terminal_commit',
            },
          }),
        )
      }
      // Terminal persists a deep copy of exactly the last snapshot that passed
      // the kernel's revision CAS. AgentContext is a diagnostic mirror, never
      // a last-value authority that can overwrite rewind/inbox commits.
      const snapshot = cloneTranscript(ctx.state.transcript)

      try {
        await ctx.ports.session.onTranscriptCommitted?.(snapshot)
      } catch (e) {
        console.warn('[OrchestrationKernel] onTranscriptCommitted failed:', e)
      }

      // Emit consolidated artifact manifest for this turn if the port is wired.
      const manifest = ctx.buildArtifactManifest()
      if (manifest && manifest.entries.length > 0) {
        // P2 §6.3 migration — strict builder.
        emitPhaseEvent(
          ctx.ports.transport,
          buildArtifactManifestPhase({
            iteration: ctx.state.iteration,
            innerIteration: ctx.state.innerIteration,
            conversationId: ctx.streamConversationId,
            artifactManifest: manifest,
          }),
        )
      }
    })
    // Auto snapshot after Terminal so callers can fork the "just-finished" state
    // to run parallel follow-up attempts against the same committed transcript.
    ctx.snapshot('post_terminal')
  } catch (e) {
    console.warn('[OrchestrationKernel] Terminal phase failed:', e)
  }
}
