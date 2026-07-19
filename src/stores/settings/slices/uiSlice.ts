/**
 * Dialog / lifecycle UI state slice.
 *
 *   - `isLoaded`            guards renderer code that must wait for the
 *                           first disk-hydration pass before mounting.
 *   - `showSettings`        whether the Settings dialog is mounted.
 *   - `settingsEntryPanel`  one-shot hint so callers can open the dialog
 *                           pinned to a specific category; consumed by
 *                           `SettingsDialog` on mount.
 *   - `loadSettings`        hydrate every field from disk at startup.
 *                           Lives in the UI slice (not a dedicated
 *                           module) because it's logically "a boot step
 *                           that eventually flips isLoaded=true".
 */
import type { StateCreator } from 'zustand'
import { getSettings } from '../../../services/electronAPI'
import { parsePersistedSettings } from '../loadSettings'
import type { PersistedSettingsShape, SettingsState } from '../types'

export type UiSlice = Pick<SettingsState,
  | 'isLoaded' | 'showSettings' | 'settingsEntryPanel'
  | 'loadSettings' | 'setShowSettings' | 'consumeSettingsEntryPanel'
>

export const createUiSlice: StateCreator<
  SettingsState, [], [], UiSlice
> = (set, get) => ({
  isLoaded: false,
  showSettings: false,
  settingsEntryPanel: null,

  loadSettings: async () => {
    try {
      const raw = (await getSettings()) as PersistedSettingsShape
      const parsed = parsePersistedSettings(raw)
      set({ ...parsed, isLoaded: true })
    } catch {
      set({ isLoaded: true })
    }
  },

  setShowSettings: (show, entryPanel) => set({
    showSettings: show,
    settingsEntryPanel: show
      ? (entryPanel !== undefined && entryPanel !== null ? entryPanel : null)
      : null,
  }),

  consumeSettingsEntryPanel: () => {
    const panel = get().settingsEntryPanel
    if (panel != null) set({ settingsEntryPanel: null })
    return panel
  },
})
