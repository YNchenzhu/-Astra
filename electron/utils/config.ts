/**
 * Global config utility — wraps settings.json for buddy/companion access.
 *
 * Provides typed access to the settings file, including companion data
 * and user identification for deterministic buddy generation.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { StoredCompanion } from '../buddy/types'
import { writeJsonFileAtomic } from '../fs/atomicWrite'
import {
  decryptSettingsSecretsInPlace,
  encryptSettingsSecretsForDisk,
} from '../settings/secretsAtRest'

export interface GlobalConfig {
  providerId: string
  apiKey: string
  model: string
  baseUrl: string
  maxTokens: number
  awsRegion: string
  projectId: string
  theme: string
  outputStyle: string
  language: string
  userID: string | null
  oauthAccount: { accountUuid: string } | null
  companion: StoredCompanion | null
  companionMuted: boolean
  buddy: {
    companion: StoredCompanion | null
    companionMuted: boolean
  } | null
}

let configPath = ''
let configCache: GlobalConfig | null = null

function getDefaultsPath(): string {
  if (!configPath) {
    // Lazy electron require: this helper is called from both main-process
    // (where `app.getPath` is available) and tool-loading code paths that
    // run in vitest. The `|| '.'` fallback covers the non-electron case.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    configPath = path.join(require('electron').app?.getPath('userData') || '.', '星构Astra-settings.json')
  }
  return configPath
}

function globalConfigFromFullSettings(parsed: Record<string, unknown>): GlobalConfig {
  return {
    providerId: (parsed.providerId as string) || 'anthropic',
    apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    model: (parsed.model as string) || 'claude-sonnet-4-20250514',
    baseUrl: (parsed.baseUrl as string) || '',
    maxTokens: (parsed.maxTokens as number) || 8192,
    awsRegion: (parsed.awsRegion as string) || '',
    projectId: (parsed.projectId as string) || '',
    theme: (parsed.theme as string) || 'dark',
    outputStyle: (parsed.outputStyle as string) || 'default',
    language: (parsed.language as string) || '',
    userID: (parsed.userID as GlobalConfig['userID']) ?? null,
    oauthAccount: (parsed.oauthAccount as { accountUuid: string }) || null,
    companion: (parsed.companion as StoredCompanion) || null,
    companionMuted: Boolean(parsed.companionMuted),
    buddy: (parsed.buddy as GlobalConfig['buddy']) || null,
  }
}

export function getGlobalConfig(): GlobalConfig {
  const p = getDefaultsPath()
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    decryptSettingsSecretsInPlace(parsed)
    configCache = globalConfigFromFullSettings(parsed)
    return configCache
  } catch {
    return {
      providerId: 'anthropic',
      apiKey: '',
      model: 'claude-sonnet-4-20250514',
      baseUrl: '',
      maxTokens: 8192,
      awsRegion: '',
      projectId: '',
      theme: 'dark',
      outputStyle: 'default',
      language: '',
      userID: null,
      oauthAccount: null,
      companion: null,
      companionMuted: false,
      buddy: null,
    }
  }
}

export function setGlobalConfig(config: Partial<GlobalConfig>): void {
  const p = getDefaultsPath()
  let full: Record<string, unknown> = {}
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    full = JSON.parse(raw) as Record<string, unknown>
    decryptSettingsSecretsInPlace(full)
  } catch {
    full = {}
  }
  for (const [k, v] of Object.entries(config)) {
    if (v !== undefined) {
      full[k] = v as unknown
    }
  }
  const forDisk = encryptSettingsSecretsForDisk(full)
  writeJsonFileAtomic(p, forDisk)
  configCache = globalConfigFromFullSettings(full)
}

export function clearConfigCache(): void {
  configCache = null
}
