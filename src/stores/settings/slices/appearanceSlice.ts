/**
 * Appearance slice — `theme` / `outputStyle` / `language`.
 *
 * All three fields mirror directly to disk so the main process can seed
 * the `document.documentElement.dataset.theme` attribute before React mounts
 * (see `src/main.tsx`).
 */
import type { StateCreator } from 'zustand'
import { DEFAULT_UI_LOCALE } from '../../../i18n/locale'
import { persistFromState } from '../persistSnapshot'
import type { SettingsState } from '../types'

export type AppearanceSlice = Pick<SettingsState,
  | 'theme' | 'outputStyle' | 'language' | 'uiLocale'
  | 'setTheme' | 'setOutputStyle' | 'setLanguage' | 'setUiLocale'
>

export const createAppearanceSlice: StateCreator<
  SettingsState, [], [], AppearanceSlice
> = (set, get) => ({
  theme: 'dark',
  outputStyle: 'default',
  language: '',
  uiLocale: DEFAULT_UI_LOCALE,

  setTheme: (theme) => {
    const update = { theme }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setOutputStyle: (outputStyle) => {
    const update = { outputStyle }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setLanguage: (language) => {
    const update = { language }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setUiLocale: (uiLocale) => {
    const update = { uiLocale }
    set(update)
    persistFromState({ ...get(), ...update })
  },
})
