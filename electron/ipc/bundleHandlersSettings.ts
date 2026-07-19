/**
 * Settings key helpers for bundle persistence.
 */

import { readDiskSettings, writeDiskSettingsPartial } from '../settings/settingsAccess'

const SETTINGS_KEY_ROOT = 'bundles'
const SETTINGS_KEY_LAST_ACTIVE = 'lastActive'

/** Read the previously persisted active bundle id, or undefined. */
export function readPersistedLastActiveBundleId(): string | undefined {
  const settings = readDiskSettings()
  const bundlesSettings = settings[SETTINGS_KEY_ROOT]
  if (!bundlesSettings || typeof bundlesSettings !== 'object') return undefined
  const id = (bundlesSettings as Record<string, unknown>)[SETTINGS_KEY_LAST_ACTIVE]
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined
}

export async function persistLastActiveBundleId(id: string): Promise<void> {
  // Merge-partial so we don't clobber other `bundles.*` keys future code
  // may add (e.g. user-preferred starting agent per bundle).
  const current = readDiskSettings()[SETTINGS_KEY_ROOT]
  const merged =
    current && typeof current === 'object'
      ? { ...(current as Record<string, unknown>), [SETTINGS_KEY_LAST_ACTIVE]: id }
      : { [SETTINGS_KEY_LAST_ACTIVE]: id }
  await writeDiskSettingsPartial({ [SETTINGS_KEY_ROOT]: merged })
}
