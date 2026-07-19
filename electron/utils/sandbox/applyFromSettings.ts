/**
 * Sync renderer-persisted `settings.sandbox` into main-process {@link setSandboxConfig}.
 * upstream §1.3 / §10 — enabling "启用沙盒" must affect Bash execution (see registry + runSandboxedCommand).
 */

import { setSandboxConfig, type SandboxFilesystemConfig } from './sandbox-config'

export type RendererSandboxSettings = {
  enabled?: boolean
  failIfUnavailable?: boolean
  allowNetwork?: boolean
  allowFilesystem?: boolean
  allowedDirectories?: string[]
}

function asSandboxRecord(raw: unknown): RendererSandboxSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as RendererSandboxSettings
}

/**
 * Apply disk/UI sandbox settings. Safe to call on startup and after every `settings:set`.
 */
export function applySandboxFromSettingsRecord(sandboxRaw: unknown): void {
  const s = asSandboxRecord(sandboxRaw)
  if (!s) {
    setSandboxConfig({
      enabled: false,
      failIfUnavailable: false,
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: false,
        allowUnixSockets: false,
      },
      filesystem: {
        allowRead: [],
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
    })
    return
  }

  const enabled = Boolean(s.enabled)
  const failIfUnavailable = Boolean(s.failIfUnavailable)
  const allowNetwork = s.allowNetwork !== false
  const allowFilesystem = s.allowFilesystem !== false
  const allowedDirectories = Array.isArray(s.allowedDirectories)
    ? s.allowedDirectories.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : []

  const filesystem: SandboxFilesystemConfig =
    allowFilesystem && allowedDirectories.length > 0
      ? {
          allowRead: [...allowedDirectories],
          denyRead: [],
          allowWrite: [...allowedDirectories],
          denyWrite: [],
        }
      : {
          allowRead: [],
          denyRead: [],
          allowWrite: [],
          denyWrite: [],
        }

  setSandboxConfig({
    enabled,
    failIfUnavailable,
    network: {
      allowLocalBinding: allowNetwork,
      allowUnixSockets: allowNetwork,
      allowedDomains: allowNetwork ? ['*'] : [],
      deniedDomains: [],
    },
    filesystem,
  })
}
