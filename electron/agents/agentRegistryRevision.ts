/**
 * Agent definition registry revision counter.
 *
 * Tracks "the agent set surfaced by `getBuiltInAgents()` + any future
 * runtime-extended agents (plugins, MCP-discovered, workspace `.md`
 * overrides) has changed". A monotonically increasing integer mirrors
 * the pattern in `electron/tools/registry.ts#getToolsetRevision`.
 *
 * ## Why a revision counter
 *
 * The `agent_listing_delta` host attachment needs to surface "what
 * agent types are newly available / removed" to the model mid-loop.
 * Rather than diffing the full agent definition list every iteration
 * (expensive for richer agent definitions with markdown body etc.),
 * the collector first checks the revision. If it matches the
 * conversation's last-seen revision, the collector short-circuits.
 *
 * ## When to bump
 *
 * Call `bumpAgentDefinitionRevision()` when:
 *
 *   - A plugin registers / unregisters an agent type
 *   - A workspace `.cursor/agents/<type>.md` file is added / removed
 *   - An MCP server exposes / withdraws an agent (when this becomes
 *     a supported integration)
 *
 * Currently the only callers are reserved for future use — the
 * built-in list returned by `getBuiltInAgents()` is compile-time
 * static. Revision starts at 1 and stays there until something
 * actually changes the surface.
 *
 * ## Storage
 *
 * Module-level singleton. Process-scoped. Resets to 1 on restart
 * (matches `getToolsetRevision` semantics).
 */

let revision = 1
const listeners = new Set<() => void>()

/** Current revision number. Starts at 1, monotonic. */
export function getAgentDefinitionRevision(): number {
  return revision
}

/**
 * Bump the revision counter and notify listeners. Call after ANY
 * mutation to the agent definition surface. Idempotent at the
 * caller's discretion — back-to-back calls produce two revision
 * jumps even when nothing actually changed; collectors observing
 * "revision differs" will still see at most a single delta because
 * the diff is computed against `getBuiltInAgents()` not against the
 * revision number itself.
 */
export function bumpAgentDefinitionRevision(): void {
  revision++
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (e) {
      // Listener throw must not block other listeners or future bumps.
      console.warn('[agentRegistryRevision] listener threw:', e)
    }
  }
}

/**
 * Subscribe to revision bumps. Returns an unsubscribe function.
 * Listeners fire AFTER the revision integer has incremented, so
 * `getAgentDefinitionRevision()` inside the listener reads the new
 * value.
 */
export function subscribeAgentDefinitionRevision(
  listener: () => void,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam — reset to 1 and drop all listeners. */
export function __resetAgentDefinitionRevisionForTests(): void {
  revision = 1
  listeners.clear()
}
