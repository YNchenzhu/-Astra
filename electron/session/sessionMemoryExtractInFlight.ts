/** Prevents overlapping session-memory extract runs for the same conversation id. */

const inFlight = new Set<string>()

export function tryBeginSessionMemoryExtract(conversationId: string): boolean {
  const id = conversationId.trim()
  if (!id || inFlight.has(id)) return false
  inFlight.add(id)
  return true
}

export function endSessionMemoryExtract(conversationId: string): void {
  inFlight.delete(conversationId.trim())
}

/** Test helper */
export function resetSessionMemoryExtractInFlightForTests(): void {
  inFlight.clear()
}
