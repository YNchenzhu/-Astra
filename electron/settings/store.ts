import path from 'node:path'
import fs from 'node:fs'
import type { App } from 'electron'
import { writeJsonFileAtomic } from '../fs/atomicWrite'
import {
  decryptSettingsSecretsInPlace,
  encryptSettingsSecretsForDisk,
} from './secretsAtRest'

let SETTINGS_PATH: string | null = null

const SETTINGS_BASENAME = '星构Astra-settings.json'

export function getSettingsPath(app: App): string {
  if (!SETTINGS_PATH) {
    SETTINGS_PATH = path.join(app.getPath('userData'), SETTINGS_BASENAME)
  }
  return SETTINGS_PATH
}

export function ensureSettingsDir(app: App): void {
  const dir = path.dirname(getSettingsPath(app))
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function defaultSettings(): Record<string, unknown> {
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
    uiLocale: 'zh-CN',
  }
}

function listAstraSettingsReadPaths(app: App): string[] {
  const root = app.getPath('userData')
  return [path.join(root, SETTINGS_BASENAME), path.join(root, '星构Astra-settings.dev.json')]
}

function listLegacyBeijiSettingsReadPaths(app: App): string[] {
  const root = app.getPath('userData')
  return [path.join(root, '北极星-settings.json'), path.join(root, '北极星-settings.dev.json')]
}

export function loadSettingsFile(app: App): Record<string, unknown> {
  try {
    ensureSettingsDir(app)
    const primary = getSettingsPath(app)
    for (const candidate of listAstraSettingsReadPaths(app)) {
      if (!fs.existsSync(candidate)) continue
      const data = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as Record<string, unknown>
      decryptSettingsSecretsInPlace(data)
      if (candidate !== primary) {
        console.info('[settings] using', path.basename(candidate), '— migrate to', SETTINGS_BASENAME, 'on next save')
      }
      return data
    }
    for (const candidate of listLegacyBeijiSettingsReadPaths(app)) {
      if (!fs.existsSync(candidate)) continue
      const legacy = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as Record<string, unknown>
      decryptSettingsSecretsInPlace(legacy)
      return legacy
    }
  } catch (error) {
    console.error('Failed to load settings:', error)
  }
  return defaultSettings()
}

export function saveSettingsFile(app: App, settings: Record<string, unknown>): void {
  try {
    ensureSettingsDir(app)
    const settingsPath = getSettingsPath(app)
    writeJsonFileAtomic(settingsPath, encryptSettingsSecretsForDisk(settings))
  } catch (error) {
    console.error('Failed to save settings:', error)
    throw error
  }
}
