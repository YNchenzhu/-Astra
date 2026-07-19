/**
 * Environment variables slice. Each `EnvVar` gets injected into tool
 * execution contexts by the main process when `enabled` is true.
 */
import type { StateCreator } from 'zustand'
import { generateId } from '../defaults'
import { persistFromState } from '../persistSnapshot'
import type { SettingsState } from '../types'

export type EnvVarsSlice = Pick<SettingsState,
  | 'envVars' | 'addEnvVar' | 'removeEnvVar' | 'updateEnvVar'
>

export const createEnvVarsSlice: StateCreator<
  SettingsState, [], [], EnvVarsSlice
> = (set, get) => ({
  envVars: [],

  addEnvVar: (envVar) => {
    const envVars = [...get().envVars, { ...envVar, id: generateId() }]
    const update = { envVars }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  removeEnvVar: (id) => {
    const envVars = get().envVars.filter((e) => e.id !== id)
    const update = { envVars }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  updateEnvVar: (id, partial) => {
    const envVars = get().envVars.map((e) => (e.id === id ? { ...e, ...partial } : e))
    const update = { envVars }
    set(update)
    persistFromState({ ...get(), ...update })
  },
})
