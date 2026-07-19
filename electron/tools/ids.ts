/**
 * Branded types for session and agent IDs.
 * Re-exports canonical types from src/types/ids.ts.
 */

export type { SessionId, AgentId } from '../../src/types/ids'
export { asSessionId, asAgentId, toAgentId } from '../../src/types/ids'

/**
 * Check if a string is a valid SessionId (non-empty).
 * SessionId format is opaque — any non-empty string is valid.
 */
export function isValidSessionId(s: string): boolean {
  return s.length > 0
}
