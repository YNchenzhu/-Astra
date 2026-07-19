/**
 * Disk setting `workspaceTrustMode`: legacy vs strict empty-store behavior.
 */

export type WorkspaceTrustModeSetting = 'legacy' | 'strict'

export function parseWorkspaceTrustMode(raw: unknown): WorkspaceTrustModeSetting {
  return raw === 'strict' ? 'strict' : 'legacy'
}
