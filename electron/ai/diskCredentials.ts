/**
 * Resolve API credentials from on-disk settings.
 * Renderer persists `manualConfig.apiKey` / `apiConfigs[]`; legacy flat `apiKey` may still exist.
 * Main-process fallbacks must mirror `useSettingsStore` loadSettings() semantics.
 */

import { resolveProviderBaseUrl } from '../../src/utils/resolveProviderBaseUrl'

/** Strip zero-width / BOM copy-paste artifacts that break gateway auth (智谱等会报 401). */
export function normalizeApiKeyInput(raw: unknown): string {
  if (raw == null) return ''
  const s = typeof raw === 'string' ? raw : String(raw)
  return s
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^\uFEFF/, '')
    .trim()
}

function trimmed(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export type ResolvedDiskAiCredentials = {
  apiKey: string
  providerId: string
  baseUrl: string
  awsRegion: string
  projectId: string
  model: string
  maxTokens: number
}

export function resolveAiCredentialsFromDisk(settings: Record<string, unknown>): ResolvedDiskAiCredentials {
  const manual = (settings.manualConfig ?? {}) as Record<string, unknown>
  const activeId = settings.activeConfigId as string | undefined
  const apiConfigs = (settings.apiConfigs ?? []) as Array<Record<string, unknown>>
  const active = typeof activeId === 'string' && activeId ? apiConfigs.find((c) => c.id === activeId) : undefined

  if (active) {
    const providerId = trimmed(active.providerId) || trimmed(settings.providerId) || 'anthropic'
    const storedUrl =
      trimmed(active.baseUrl) || trimmed(manual.baseUrl) || trimmed(settings.baseUrl)
    return {
      apiKey:
        normalizeApiKeyInput(active.apiKey) ||
        normalizeApiKeyInput(settings.apiKey),
      providerId,
      baseUrl: resolveProviderBaseUrl(providerId, storedUrl),
      awsRegion: trimmed(active.awsRegion) || trimmed(manual.awsRegion) || trimmed(settings.awsRegion),
      projectId: trimmed(active.projectId) || trimmed(manual.projectId) || trimmed(settings.projectId),
      model: trimmed(active.model) || trimmed(settings.model) || '',
      maxTokens:
        typeof active.maxTokens === 'number' && Number.isFinite(active.maxTokens)
          ? active.maxTokens
          : typeof settings.maxTokens === 'number'
            ? settings.maxTokens
            : 8192,
    }
  }

  const providerId =
    trimmed(settings.manualProviderId) || trimmed(settings.providerId) || 'anthropic'
  const storedUrl = trimmed(manual.baseUrl) || trimmed(settings.baseUrl)
  return {
    apiKey: normalizeApiKeyInput(manual.apiKey) || normalizeApiKeyInput(settings.apiKey),
    providerId,
    baseUrl: resolveProviderBaseUrl(providerId, storedUrl),
    awsRegion: trimmed(manual.awsRegion) || trimmed(settings.awsRegion),
    projectId: trimmed(manual.projectId) || trimmed(settings.projectId),
    model: trimmed(settings.manualModel) || trimmed(settings.model) || '',
    maxTokens:
      typeof settings.manualMaxTokens === 'number' && Number.isFinite(settings.manualMaxTokens)
        ? settings.manualMaxTokens
        : typeof settings.maxTokens === 'number'
          ? settings.maxTokens
          : 8192,
  }
}
