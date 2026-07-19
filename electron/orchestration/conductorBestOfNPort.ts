/**
 * 阶段 3 — production wiring of the Conductor's best-of-N action.
 *
 * The kernel Conductor (`conductor.ts`) decides WHETHER to fan out a best-of-N
 * exploration on an unaddressed verification FAIL, but executes it through an
 * injected {@link ConductorBestOfNPort} so the kernel never hard-depends on the
 * sub-agent / best-of-n machinery (which would create an import cycle through
 * `bestOfNSubAgent → subAgentRunner → runOrchestratedSubAgent → kernel`).
 *
 * This factory lives in a leaf module (imported by the main-chat entry
 * `runOrchestratedSession.ts`, NOT by the kernel) and binds the port to the
 * existing `runBestOfN` + `createSubAgentRunAttempt` (Cursor-3 `/best-of-n`
 * primitives). Worktree isolation REQUIRES the sub-agent worker, so the factory
 * returns `undefined` when the worker is unavailable — the Conductor then
 * gracefully degrades a best-of-N decision to a plain rewind re-dispatch.
 */

import type { ConductorBestOfNPort } from './conductor'
import { runBestOfN } from './bestOfN'
import { createSubAgentRunAttempt } from './bestOfNSubAgent'
import { subAgentWorkerAvailable } from '../agents/subAgentWorkerClient'

export function createConductorBestOfNPort(opts?: {
  /** Parallel attempts. Defaults to 3 (matching the BestOfN tool default). */
  n?: number
  /** Routing key for best-of-n telemetry. */
  conversationId?: string
}): ConductorBestOfNPort | undefined {
  // Without the worker, N parallel attempts would clobber the shared workspace
  // (no real worktree isolation) — refuse rather than risk corruption.
  if (!subAgentWorkerAvailable()) return undefined
  return {
    async run({ task, signal }) {
      const res = await runBestOfN({
        task,
        n: opts?.n ?? 3,
        runAttempt: createSubAgentRunAttempt(),
        integrateWinner: true,
        ...(opts?.conversationId ? { conversationId: opts.conversationId } : {}),
        ...(signal ? { signal } : {}),
      })
      return { integrated: res.integrated }
    },
  }
}
