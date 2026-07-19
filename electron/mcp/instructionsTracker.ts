/**
 * MCP server `instructions` field tracker.
 *
 * The MCP protocol's `InitializeResult` carries an optional `instructions`
 * string the server uses to nudge how clients should call its tools.
 * upstream surfaces changes to this field via a `mcp_instructions_delta`
 * attachment so the model sees freshly-connected servers' guidance
 * mid-conversation. This module is the data-source layer for that
 * collector.
 *
 * Two concerns split into two surfaces:
 *
 *   1. **Authoritative state** (`setMcpServerInstructions`,
 *      `clearMcpServerInstructions`, `getCurrentMcpInstructions`) —
 *      keyed by MCP server name, updated whenever a server (re)connects
 *      or disconnects. Module-level singleton because there's one MCP
 *      registry per process.
 *
 *   2. **Per-conversation snapshots** (`snapshotMcpInstructionsForConversation`,
 *      `diffMcpInstructionsForConversation`) — the collector calls
 *      `diff` at post-tool, which returns the {added, changed, removed}
 *      delta vs the conversation's last-seen snapshot AND updates the
 *      snapshot to "current" atomically. Per-conversation because each
 *      chat sees its own delta history.
 *
 * Storage: in-memory Maps. Survives across iterations of the agentic
 * loop (module-level). Lost on process restart — acceptable because
 * MCP servers reconnect on restart and re-emit instructions.
 */

export interface McpInstructionsDelta {
  /** Servers that newly published a non-empty instructions string. */
  readonly added: ReadonlyArray<{ name: string; instructions: string }>
  /** Servers whose instructions changed since the last snapshot. */
  readonly changed: ReadonlyArray<{
    name: string
    previous: string
    current: string
  }>
  /** Servers that disconnected (or cleared their instructions). */
  readonly removed: ReadonlyArray<{ name: string; previous: string }>
}

const currentInstructions = new Map<string, string>()
const lastSeenByConversation = new Map<string, Map<string, string>>()

/**
 * Update the authoritative current-instructions store for a server.
 * Empty / whitespace-only strings are normalised to "no instructions"
 * (cleared) so a server that explicitly publishes "" doesn't keep a
 * ghost entry around.
 *
 * Callers: `electron/mcp/client.ts#connect` (right after `client.connect`
 * resolves and the SDK has surfaced the InitializeResult's instructions).
 */
export function setMcpServerInstructions(
  serverName: string,
  instructions: string | undefined | null,
): void {
  if (!serverName) return
  const normalized = typeof instructions === 'string' ? instructions.trim() : ''
  if (normalized.length === 0) {
    currentInstructions.delete(serverName)
    return
  }
  currentInstructions.set(serverName, normalized)
}

/**
 * Drop the entry for a server (called on disconnect). Subsequent
 * `diff` calls will surface the server as `removed` in the delta.
 */
export function clearMcpServerInstructions(serverName: string): void {
  currentInstructions.delete(serverName)
}

/** Snapshot of all currently-connected servers' instructions. */
export function getCurrentMcpInstructions(): ReadonlyMap<string, string> {
  return new Map(currentInstructions)
}

/**
 * Compute the {added, changed, removed} delta vs the conversation's
 * last-seen snapshot, then update the snapshot to current. Atomic so
 * the next call returns only NEW news.
 *
 * First call for a conversation returns:
 *   - all currently-connected servers as `added`
 *   - empty `changed` / `removed`
 *
 * Most subsequent calls return three empty arrays — fast no-op when
 * nothing changed.
 */
export function diffMcpInstructionsForConversation(
  conversationId: string,
): McpInstructionsDelta {
  if (!conversationId) {
    return { added: [], changed: [], removed: [] }
  }
  const lastSeen =
    lastSeenByConversation.get(conversationId) ?? new Map<string, string>()

  const added: Array<{ name: string; instructions: string }> = []
  const changed: Array<{
    name: string
    previous: string
    current: string
  }> = []
  const removed: Array<{ name: string; previous: string }> = []

  for (const [name, current] of currentInstructions) {
    const previous = lastSeen.get(name)
    if (previous === undefined) {
      added.push({ name, instructions: current })
    } else if (previous !== current) {
      changed.push({ name, previous, current })
    }
  }
  for (const [name, previous] of lastSeen) {
    if (!currentInstructions.has(name)) {
      removed.push({ name, previous })
    }
  }

  // Update the snapshot to the new current.
  lastSeenByConversation.set(conversationId, new Map(currentInstructions))

  return { added, changed, removed }
}

/**
 * Force-reset the snapshot for a conversation. Used when the
 * conversation is recreated (e.g. /clear) so the next diff re-surfaces
 * all servers as `added`.
 */
export function resetMcpInstructionsSnapshotForConversation(
  conversationId: string,
): void {
  lastSeenByConversation.delete(conversationId)
}

/** Test seam — wipe both maps. */
export function __resetMcpInstructionsTrackerForTests(): void {
  currentInstructions.clear()
  lastSeenByConversation.clear()
}
