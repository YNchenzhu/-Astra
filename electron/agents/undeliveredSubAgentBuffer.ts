/**
 * Undelivered sub-agent output buffer (audit 2026-06).
 *
 * Closes the "5-second unregister window": background sub-agents are
 * dropped from `activeAgentRegistry` 5s after reaching a terminal state
 * (`agentTool.ts` → `unspawnAndUntrackAgent`), but the main agent's
 * context injection (`injectPendingSubAgentOutputsForMainTurn`) reads
 * ONLY live registry rows. If the main turn had already ended and the
 * next turn (user message or auto-resume wake) starts >5s after the
 * sub-agent finished, the result never reached the main agent's model
 * context — the model had to remember to call `TaskOutput` (10-minute
 * TTL) on its own.
 *
 * `unregisterActiveAgent` now parks the undelivered remainder here; the
 * injection collector drains it on the next main turn regardless of
 * registry state.
 *
 * Standalone module (no imports from the agents package) so both
 * `activeAgentRegistry` (writer) and `mainSubAgentContextInjection`
 * (reader) can depend on it without a cycle.
 */

export interface UndeliveredSubAgentEntry {
  agentId: string
  agentType: string
  name?: string
  /** Terminal status at unregister time ('completed' | 'failed' | 'killed'). */
  status: string
  terminalError?: string
  /** Text the parent never saw (delta past `mainContextDeliveryOffset`). */
  undeliveredText: string
  /** True when the terminal-state notice itself was never delivered. */
  terminalNoticePending: boolean
  bufferedAt: number
}

/** Bounded: a burst of finished agents must not grow this without limit. */
const MAX_ENTRIES = 30

const buffer: UndeliveredSubAgentEntry[] = []

export function bufferUndeliveredSubAgentOutput(
  entry: Omit<UndeliveredSubAgentEntry, 'bufferedAt'>,
): void {
  if (!entry.undeliveredText.trim() && !entry.terminalNoticePending) return
  buffer.push({ ...entry, bufferedAt: Date.now() })
  if (buffer.length > MAX_ENTRIES) buffer.shift()
}

/** Remove and return all pending entries (FIFO). */
export function drainUndeliveredSubAgentOutputs(): UndeliveredSubAgentEntry[] {
  return buffer.splice(0, buffer.length)
}

/**
 * Put entries back at the FRONT (oldest-first order preserved). Used by
 * the injection collector's rewind path (orphan tool_use deferral) and
 * by the render-cap overflow path.
 */
export function restoreUndeliveredSubAgentOutputs(
  entries: ReadonlyArray<UndeliveredSubAgentEntry>,
): void {
  if (entries.length === 0) return
  buffer.unshift(...entries)
  while (buffer.length > MAX_ENTRIES) buffer.shift()
}

/** @internal test helper. */
export function clearUndeliveredSubAgentOutputsForTests(): void {
  buffer.length = 0
}
