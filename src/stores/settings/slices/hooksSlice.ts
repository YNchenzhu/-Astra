/**
 * Hooks slice — user-defined + built-in `PreToolUse` / `PostToolUse` /
 * `FileChanged` / etc. lifecycle commands.
 *
 * `toggleBuiltInHook` is the only non-trivial action: the built-in preset
 * registry in `../builtinHooks.ts` owns the defaults (matcher / async /
 * command); this slice just mints a new `HookConfig` stub bound to the
 * preset's `id` so `isBuiltInHookEnabled` can round-trip.
 */
import type { StateCreator } from 'zustand'
import { BUILTIN_HOOKS } from '../builtinHooks'
import { generateId } from '../defaults'
import { persistFromState } from '../persistSnapshot'
import type { HookConfig, SettingsState } from '../types'

export type HooksSlice = Pick<SettingsState,
  | 'hooks' | 'disableAllHooks'
  | 'addHook' | 'removeHook' | 'updateHook'
  | 'setDisableAllHooks' | 'toggleBuiltInHook' | 'isBuiltInHookEnabled'
>

export const createHooksSlice: StateCreator<
  SettingsState, [], [], HooksSlice
> = (set, get) => ({
  hooks: [],
  disableAllHooks: false,

  addHook: (hook) => {
    const hooks = [...get().hooks, { ...hook, id: generateId() }]
    const update = { hooks }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  removeHook: (id) => {
    const hooks = get().hooks.filter((h) => h.id !== id)
    const update = { hooks }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  updateHook: (id, partial) => {
    const hooks = get().hooks.map((h) => (h.id === id ? { ...h, ...partial } : h))
    const update = { hooks }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setDisableAllHooks: (disableAllHooks) => {
    const update = { disableAllHooks }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  toggleBuiltInHook: (builtInId) => {
    const state = get()
    const existing = state.hooks.find((h) => h.builtInId === builtInId)
    if (existing) {
      const hooks = state.hooks.filter((h) => h.builtInId !== builtInId)
      const update = { hooks }
      set(update)
      persistFromState({ ...state, ...update })
    } else {
      const preset = BUILTIN_HOOKS.find((p) => p.id === builtInId)
      if (!preset) return
      const newHook: HookConfig = {
        id: generateId(),
        event: preset.event,
        command: preset.command,
        enabled: true,
        matcher: preset.matcher,
        async: preset.async,
        asyncRewake: preset.asyncRewake,
        builtInId: preset.id,
      }
      const hooks = [...state.hooks, newHook]
      const update = { hooks }
      set(update)
      persistFromState({ ...state, ...update })
    }
  },

  isBuiltInHookEnabled: (builtInId) => {
    return get().hooks.some((h) => h.builtInId === builtInId && h.enabled)
  },
})
