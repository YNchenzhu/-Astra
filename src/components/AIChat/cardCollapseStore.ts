/**
 * cardCollapseStore — session-scoped persistence for tool-card expand/collapse.
 *
 * Why this exists:
 *   Tool cards (`ActivityRow`, `BaseCard`, `CommandChip`) keep their
 *   expand/collapse flag in component-local `useState`. That state is lost
 *   whenever the component unmounts — which happens routinely in the chat
 *   transcript because `VirtualMessageList` windows off-screen messages
 *   (and because tool batches can remount). The user-visible bug: collapse a
 *   Write/Edit card, scroll it out of view, scroll back, and it has
 *   re-expanded (its `defaultExpanded` for Write/Edit stays `true`).
 *
 *   This module holds the user's explicit expand choice OUTSIDE the React
 *   tree, keyed by a stable id (the tool_use id / group anchor id). On
 *   remount the card reads the saved value instead of resetting to
 *   `defaultExpanded`.
 *
 * Lifetime: a plain module-level Map. It persists for the renderer session
 * and is keyed by unique ids, so it never collides and its memory footprint
 * (one boolean per toggled card) is negligible. No cleanup needed.
 */
const expandedById = new Map<string, boolean>()

/** Returns the persisted expand state, or `undefined` if the user never toggled this card. */
export function getCardExpanded(id: string): boolean | undefined {
  return expandedById.get(id)
}

/** Records the user's explicit expand/collapse choice for `id`. */
export function setCardExpanded(id: string, expanded: boolean): void {
  expandedById.set(id, expanded)
}

/**
 * Resolves the initial expand state for an uncontrolled card: the persisted
 * user choice when present, otherwise the caller's `defaultExpanded`.
 */
export function resolveInitialExpanded(
  persistKey: string | undefined,
  defaultExpanded: boolean,
): boolean {
  if (persistKey !== undefined) {
    const saved = expandedById.get(persistKey)
    if (saved !== undefined) return saved
  }
  return defaultExpanded
}
