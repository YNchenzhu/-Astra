/**
 * P3.1 — Prompt / observable input stability helpers (upstream-style hooks).
 * Keeps tool-definition ordering stable via assembleToolPool + schema cache in schema.ts.
 */

/**
 * Clone tool input for logging or cache keys without mutating the live object.
 */
export function backfillObservableInput<T extends Record<string, unknown>>(input: T): T {
  try {
    return structuredClone(input)
  } catch {
    return JSON.parse(JSON.stringify(input)) as T
  }
}
