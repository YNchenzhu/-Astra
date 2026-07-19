/**
 * User settings bridge (`星构Astra-settings.json`).
 *
 * Thin pass-through to the main-process serialized writer chain — any
 * merge / hook-fire semantics live in `electron/ipc/handlers/settingsHandlers.ts`.
 */
import { ipcRenderer } from 'electron'

export interface SettingsApi {
  get: () => Promise<Record<string, unknown>>
  set: (settings: Record<string, unknown>) => Promise<void>
}

export function buildSettingsApi(): SettingsApi {
  return {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (settings) => ipcRenderer.invoke('settings:set', settings),
  }
}
