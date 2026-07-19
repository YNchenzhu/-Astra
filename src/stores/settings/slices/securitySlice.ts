/**
 * Security / permissions slice.
 *
 * Groups every knob the user can use to gate *what* the agent can touch or
 * execute:
 *   - permission mode + rule list + dangerous-mode prompt
 *   - workspace-trust mode (legacy vs strict missing-trust-file semantics)
 *   - diff approval precision (legacy vs DiffTransaction-authoritative)
 *   - custom-agent scope directories + default save destination
 *   - sandbox execution profile (bwrap / sandbox-exec)
 */
import type { StateCreator } from 'zustand'
import { DEFAULT_SANDBOX_SETTINGS, generateId } from '../defaults'
import { persistFromState } from '../persistSnapshot'
import type { SettingsState } from '../types'

export type SecuritySlice = Pick<SettingsState,
  | 'permissionDefaultMode' | 'permissionRules'
  | 'skipDangerousModePermissionPrompt' | 'workspaceTrustMode'
  | 'diffPrecisionMode'
  | 'customAgentsExtraDirs' | 'defaultNewAgentScope'
  | 'sandbox'
  | 'setPermissionDefaultMode' | 'addPermissionRule'
  | 'removePermissionRule' | 'updatePermissionRule'
  | 'setSkipDangerousModePermissionPrompt' | 'setWorkspaceTrustMode'
  | 'setDiffPrecisionMode'
  | 'setCustomAgentsExtraDirs' | 'setDefaultNewAgentScope'
  | 'setSandboxSettings'
>

export const createSecuritySlice: StateCreator<
  SettingsState, [], [], SecuritySlice
> = (set, get) => ({
  permissionDefaultMode: 'ask',
  permissionRules: [],
  skipDangerousModePermissionPrompt: false,
  workspaceTrustMode: 'legacy',
  diffPrecisionMode: 'legacy',
  customAgentsExtraDirs: [],
  defaultNewAgentScope: 'user-global',
  sandbox: { ...DEFAULT_SANDBOX_SETTINGS },

  // --- Permissions ---
  setPermissionDefaultMode: (permissionDefaultMode) => {
    const update = { permissionDefaultMode }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  addPermissionRule: (rule) => {
    const permissionRules = [...get().permissionRules, { ...rule, id: generateId() }]
    const update = { permissionRules }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  removePermissionRule: (id) => {
    const permissionRules = get().permissionRules.filter((r) => r.id !== id)
    const update = { permissionRules }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  updatePermissionRule: (id, partial) => {
    const permissionRules = get().permissionRules.map((r) => (r.id === id ? { ...r, ...partial } : r))
    const update = { permissionRules }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setSkipDangerousModePermissionPrompt: (skipDangerousModePermissionPrompt) => {
    const update = { skipDangerousModePermissionPrompt }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setWorkspaceTrustMode: (workspaceTrustMode) => {
    const update = { workspaceTrustMode }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  // --- Diff approval precision ---
  setDiffPrecisionMode: (mode) => {
    const update = { diffPrecisionMode: mode }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  // --- Custom agents scope prefs ---
  setCustomAgentsExtraDirs: (dirs) => {
    // Normalise: drop blanks and de-dupe while preserving order.
    const seen = new Set<string>()
    const normalised: string[] = []
    for (const d of dirs) {
      if (typeof d !== 'string') continue
      const trimmed = d.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      normalised.push(trimmed)
    }
    const update = { customAgentsExtraDirs: normalised }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  setDefaultNewAgentScope: (scope) => {
    const update = { defaultNewAgentScope: scope }
    set(update)
    persistFromState({ ...get(), ...update })
  },

  // --- Sandbox ---
  setSandboxSettings: (partial) => {
    const sandbox = { ...get().sandbox, ...partial }
    const update = { sandbox }
    set(update)
    persistFromState({ ...get(), ...update })
  },
})
