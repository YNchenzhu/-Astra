/**
 * Composed settings store entry.
 *
 * The actual state + actions live in per-domain slices under
 * `./settings/slices/*.ts`. This file only:
 *   1. composes the slices into the final Zustand store
 *   2. re-exports the public type surface + constant registries expected
 *      by consumers (SettingsDialog, ChatInput, useResolvedEditorTheme, …)
 *
 * Keep new settings fields out of this file — add them to the relevant
 * slice and `SettingsState` in `./settings/types.ts`.
 */
import { create } from 'zustand'

import {
  BUILTIN_HOOKS,
  type BuiltInHookPreset,
} from './settings/builtinHooks'
import {
  MODELS_BY_PROVIDER,
  PROTOCOL_HINTS,
  PROVIDERS,
  type ModelOption,
  type ProviderId,
  type ProviderOption,
} from './settings/providers'
import type {
  ApiConfig,
  AnthropicThinkingCapability,
  CustomAgentScopeSetting,
  DefaultShell,
  DesktopNotificationMode,
  DiffPrecisionMode,
  EffortLevel,
  EnvVar,
  ExternalDiskChangeRefreshMode,
  HookConfig,
  OutputStyleSetting,
  PermissionMode,
  PermissionRule,
  SandboxSettings,
  SettingsCategoryId,
  SettingsState,
  UIThemeSetting,
  WorkspaceTrustModeSetting,
} from './settings/types'

import { createApiConfigsSlice } from './settings/slices/apiConfigsSlice'
import { createAppearanceSlice } from './settings/slices/appearanceSlice'
import { createBehaviorSlice } from './settings/slices/behaviorSlice'
import { createEnvVarsSlice } from './settings/slices/envVarsSlice'
import { createHooksSlice } from './settings/slices/hooksSlice'
import { createMemorySlice } from './settings/slices/memorySlice'
import { createSecuritySlice } from './settings/slices/securitySlice'
import { createStorageSlice } from './settings/slices/storageSlice'
import { createToolsSlice } from './settings/slices/toolsSlice'
import { createUiSlice } from './settings/slices/uiSlice'

// ─── Public re-exports ────────────────────────────────────────────────
// Downstream consumers (SettingsDialog, ChatInput, useResolvedEditorTheme,
// …) keep importing from `../../stores/useSettingsStore`; the split behind
// this file is an internal implementation detail.
export { BUILTIN_HOOKS, MODELS_BY_PROVIDER, PROTOCOL_HINTS, PROVIDERS }
export type { BuiltInHookPreset, ModelOption, ProviderId, ProviderOption }
export type {
  ApiConfig,
  AnthropicThinkingCapability,
  CustomAgentScopeSetting,
  DefaultShell,
  DesktopNotificationMode,
  DiffPrecisionMode,
  EffortLevel,
  EnvVar,
  ExternalDiskChangeRefreshMode,
  HookConfig,
  OutputStyleSetting,
  PermissionMode,
  PermissionRule,
  SandboxSettings,
  SettingsCategoryId,
  SettingsState,
  UIThemeSetting,
  WorkspaceTrustModeSetting,
}

export const useSettingsStore = create<SettingsState>()((...a) => ({
  ...createApiConfigsSlice(...a),
  ...createAppearanceSlice(...a),
  ...createBehaviorSlice(...a),
  ...createSecuritySlice(...a),
  ...createHooksSlice(...a),
  ...createEnvVarsSlice(...a),
  ...createMemorySlice(...a),
  ...createToolsSlice(...a),
  ...createStorageSlice(...a),
  ...createUiSlice(...a),
}))
