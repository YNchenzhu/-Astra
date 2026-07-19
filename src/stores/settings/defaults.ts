/**
 * Default (initial) values for the settings store.
 *
 * Each slice file pulls its own defaults from here so the main store entry
 * can stay free of magic constants. Also hosts the tiny `generateId` helper
 * used by slices that append records with client-minted IDs.
 */
import type {
  DefaultShell,
  ManualConfig,
  SandboxSettings,
} from './types'

export const DEFAULT_SHELL: DefaultShell = (
  typeof navigator !== 'undefined' && /win/i.test(navigator.platform)
)
  ? 'powershell'
  : 'bash'

export const DEFAULT_MANUAL_CONFIG: ManualConfig = {
  apiKey: '',
  baseUrl: '',
  awsRegion: '',
  projectId: '',
  anthropicThinkingCapability: 'auto',
}

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  enabled: false,
  failIfUnavailable: false,
  allowNetwork: true,
  allowFilesystem: true,
  allowedDirectories: [],
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
