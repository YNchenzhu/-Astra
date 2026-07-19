/**
 * Provider/model catalogue for the settings store.
 *
 * Re-exports data from `src/data/providerRegistry.ts` so downstream consumers
 * (`SettingsDialog`, `ChatInput`, …) do not need to change their imports.
 *
 * The actual provider tables live in the registry to avoid duplication with
 * the main-process `electron/ai/client.ts`.
 */

import {
  type ProviderId,
  PROVIDER_ENTRIES,
  getDefaultModel as registryGetDefaultModel,
} from '../../data/providerRegistry'

export type { ProviderId }

export interface ProviderOption {
  id: ProviderId
  name: string
}

export interface ModelOption {
  id: string
  name: string
  providerId: ProviderId
}

export const PROVIDERS: ProviderOption[] = PROVIDER_ENTRIES.map((e) => ({
  id: e.id,
  name: e.name,
}))

export const PROTOCOL_HINTS: Record<ProviderId, string> = PROVIDER_ENTRIES.reduce(
  (acc, entry) => {
    acc[entry.id] = entry.protocolHint
    return acc
  },
  {} as Record<ProviderId, string>,
)

export const MODELS_BY_PROVIDER: Record<ProviderId, ModelOption[]> = PROVIDER_ENTRIES.reduce(
  (acc, entry) => {
    acc[entry.id] = entry.models.map((m) => ({
      id: m.id,
      name: m.name,
      providerId: entry.id,
    }))
    return acc
  },
  {} as Record<ProviderId, ModelOption[]>,
)

export { registryGetDefaultModel as getDefaultModel }
