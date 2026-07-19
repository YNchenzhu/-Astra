/**
 * Sandbox invariant for the `session-memory-internal` scribe (audit SA-3 fix 4).
 *
 * `gateSessionMemoryInternalAgentToolUse` (electron/tools/fileToolValidation.ts)
 * only runs in the MAIN process (`runAgenticToolUseBody`). A worker_threads
 * sub-agent executing tools LOCALLY (subAgentWorker.ts `execLocal`) never
 * passes through that gate, so routing the scribe through the worker path
 * would silently void its single-file sandbox.
 *
 * Two enforcement points share this predicate (belt and suspenders):
 *   1. `subAgentRunner.ts` — the worker/in-process route decision hard-pins
 *      this agent type to the in-process path, ignoring `POLE_AGENT_WORKER`
 *      and any other env/config.
 *   2. `subAgentWorker.ts` — if a (future, buggy) caller ever inits a worker
 *      session with this agent type anyway, local tool execution is refused
 *      outright; only the RPC route back to main (which has the full gate)
 *      would be permitted.
 *
 * Keep this module dependency-free — it is imported by the worker bundle.
 */

export const SESSION_MEMORY_INTERNAL_AGENT_TYPE = 'session-memory-internal'

/** True when `agentType` is the sandboxed session-memory scribe. */
export function isSessionMemoryInternalAgentType(
  agentType: string | null | undefined,
): boolean {
  return agentType === SESSION_MEMORY_INTERNAL_AGENT_TYPE
}
