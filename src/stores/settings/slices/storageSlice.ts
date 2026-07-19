/**
 * Data / agent storage-path slice.
 *
 * Initial values are empty strings; the main process seeds them on first
 * `loadSettings()` call (defaults = `userData` / `userData/.agents`). A
 * non-empty patch persisted here causes the main process to move the
 * corresponding services' disk root at the next `settings:set` broadcast.
 */
import type { StateCreator } from 'zustand'
import { persistFromState } from '../persistSnapshot'
import type { SettingsState } from '../types'

export type StorageSlice = Pick<SettingsState,
  | 'dataStoragePath' | 'agentStoragePath'
  | 'setDataStoragePath' | 'setAgentStoragePath'
>

export const createStorageSlice: StateCreator<
  SettingsState, [], [], StorageSlice
> = (set, get) => ({
  dataStoragePath: '',
  agentStoragePath: '',

  setDataStoragePath: (dataStoragePath) => {
    const update = { dataStoragePath }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setAgentStoragePath: (agentStoragePath) => {
    const update = { agentStoragePath }
    set(update)
    persistFromState({ ...get(), ...update })
  },
})
