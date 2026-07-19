/**
 * Report §5.10 / AC-5.7: upstream checks Statsig gates before queries to remotely disable
 * high-privilege permission modes. We use env-backed switches plus optional JSON file / inline JSON
 * (`permissionRemoteKillConfig.ts`) for admin-controlled rollout without Statsig.
 */

import type { PermissionMode } from './interactionState'
import { readPermissionRemoteKillPayload } from './permissionRemoteKillConfig'

function envTruthy(name: string): boolean {
  const v = process.env[name]
  if (v === undefined || v === '') return false
  const t = v.trim().toLowerCase()
  return t === '1' || t === 'true' || t === 'yes' || t === 'on'
}

/** When set, chat `bypassPermissions` behaves as `default` for tool policy (and diff bypass is cleared). */
export function isBypassPermissionsKillswitchActive(): boolean {
  if (envTruthy('ASTRA_KILL_BYPASS_PERMISSIONS')) return true
  return readPermissionRemoteKillPayload().killBypassPermissions === true
}

/**
 * When set, modes that skip prompts for broad classes (`acceptEdits`, `dontAsk`) behave as `default`.
 * Aligns with report wording: "auto mode" style remote disable (not identical to upstream internal `auto`).
 */
export function isAutoStylePermissionKillswitchActive(): boolean {
  if (envTruthy('ASTRA_KILL_AUTO_PERMISSION_MODES')) return true
  return readPermissionRemoteKillPayload().killAutoPermissionModes === true
}

export function applyChatPermissionKillswitches(mode: PermissionMode): PermissionMode {
  let m = mode
  if (isBypassPermissionsKillswitchActive() && m === 'bypassPermissions') {
    m = 'default'
  }
  if (
    isAutoStylePermissionKillswitchActive() &&
    (m === 'acceptEdits' || m === 'dontAsk' || m === 'auto')
  ) {
    m = 'default'
  }
  return m
}

export function applyDiffPermissionKillswitch(
  mode: 'default' | 'bypassPermissions',
): 'default' | 'bypassPermissions' {
  if (isBypassPermissionsKillswitchActive() && mode === 'bypassPermissions') {
    return 'default'
  }
  return mode
}
