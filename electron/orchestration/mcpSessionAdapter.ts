/**
 * MCP / Bridge-equivalent transcript persistence stays **outside** the kernel decision graph.
 *
 * Implement {@link SessionStorePort} here (e.g. call `conversation:save` IPC or MCP metadata flush).
 * The kernel invokes `onTranscriptCommitted` directly from `phases/terminal.ts#runTerminalPhase`
 * once per turn after the transcript snapshot is finalised — it is NOT driven by the
 * `SessionCommand` reducer or `applySessionCommands` effects.
 *
 * Main-chat currently uses the no-op default (transcript persistence is owned by the
 * legacy `conversation/service.ts` flush invoked from `streamHandler` rather than the
 * kernel port). The port survives so MCP / Bridge adapters can opt in later without
 * reshaping the kernel construction site.
 */

import type { SessionStorePort } from './ports'

/** No-op default; replace with real adapter when transcript persistence should follow Terminal phase. */
export function createNoopMcpSessionAdapter(): SessionStorePort {
  return {}
}
