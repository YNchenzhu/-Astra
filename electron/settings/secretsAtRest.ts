/**
 * Encrypt API keys and similar secrets before writing `星构Astra-settings.json`,
 * using Electron {@link safeStorage} (OS keychain / DPAPI / libsecret).
 *
 * - Values without the marker are treated as legacy plaintext and still work.
 * - When encryption is unavailable (e.g. some Linux without secret service), values stay plaintext and we log once.
 */

import { safeStorage } from 'electron'

/** Prefix for ciphertext stored as base64 in JSON (unlikely to collide with real keys). */
export const SETTINGS_SECRET_PREFIX = '__PS_SK1__:'

let loggedEncryptionUnavailable = false

export function encryptSecretAtRest(plain: string): string {
  if (!plain) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    if (!loggedEncryptionUnavailable) {
      loggedEncryptionUnavailable = true
      console.warn('[settings] safeStorage unavailable — secrets stored as plaintext on disk')
    }
    return plain
  }
  try {
    const buf = safeStorage.encryptString(plain)
    return SETTINGS_SECRET_PREFIX + buf.toString('base64')
  } catch (e) {
    console.error('[settings] encryptString failed:', e)
    return plain
  }
}

export function decryptSecretAtRest(stored: unknown): string {
  if (stored == null) return ''
  const s = typeof stored === 'string' ? stored : String(stored)
  if (!s) return ''
  if (!s.startsWith(SETTINGS_SECRET_PREFIX)) {
    return s
  }
  const b64 = s.slice(SETTINGS_SECRET_PREFIX.length)
  if (!b64 || !safeStorage.isEncryptionAvailable()) {
    return ''
  }
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch (e) {
    console.error('[settings] decryptString failed:', e)
    return ''
  }
}

/** Decrypt known secret fields in place (for objects read from disk or held in memory as plaintext). */
export function decryptSettingsSecretsInPlace(root: Record<string, unknown>): void {
  if (typeof root.apiKey === 'string' && root.apiKey.startsWith(SETTINGS_SECRET_PREFIX)) {
    root.apiKey = decryptSecretAtRest(root.apiKey)
  }
  if (
    typeof root.webSearchBraveApiKey === 'string' &&
    root.webSearchBraveApiKey.startsWith(SETTINGS_SECRET_PREFIX)
  ) {
    root.webSearchBraveApiKey = decryptSecretAtRest(root.webSearchBraveApiKey)
  }
  if (
    typeof root.webSearchBaiduApiKey === 'string' &&
    root.webSearchBaiduApiKey.startsWith(SETTINGS_SECRET_PREFIX)
  ) {
    root.webSearchBaiduApiKey = decryptSecretAtRest(root.webSearchBaiduApiKey)
  }

  const mc = root.manualConfig
  if (mc && typeof mc === 'object' && !Array.isArray(mc)) {
    const o = mc as Record<string, unknown>
    if (typeof o.apiKey === 'string' && o.apiKey.startsWith(SETTINGS_SECRET_PREFIX)) {
      o.apiKey = decryptSecretAtRest(o.apiKey)
    }
  }

  const configs = root.apiConfigs
  if (Array.isArray(configs)) {
    for (const row of configs) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue
      const o = row as Record<string, unknown>
      if (typeof o.apiKey === 'string' && o.apiKey.startsWith(SETTINGS_SECRET_PREFIX)) {
        o.apiKey = decryptSecretAtRest(o.apiKey)
      }
    }
  }
}

/**
 * Deep clone and encrypt secret fields for persistence (does not mutate input).
 */
export function encryptSettingsSecretsForDisk(input: Record<string, unknown>): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(input)) as Record<string, unknown>

  if (typeof out.apiKey === 'string' && out.apiKey) {
    out.apiKey = encryptSecretAtRest(out.apiKey)
  }
  if (typeof out.webSearchBraveApiKey === 'string' && out.webSearchBraveApiKey) {
    out.webSearchBraveApiKey = encryptSecretAtRest(out.webSearchBraveApiKey)
  }
  if (typeof out.webSearchBaiduApiKey === 'string' && out.webSearchBaiduApiKey) {
    out.webSearchBaiduApiKey = encryptSecretAtRest(out.webSearchBaiduApiKey)
  }

  const mc = out.manualConfig
  if (mc && typeof mc === 'object' && !Array.isArray(mc)) {
    const o = mc as Record<string, unknown>
    if (typeof o.apiKey === 'string' && o.apiKey) {
      o.apiKey = encryptSecretAtRest(o.apiKey)
    }
  }

  if (Array.isArray(out.apiConfigs)) {
    out.apiConfigs = out.apiConfigs.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row
      const o = { ...(row as Record<string, unknown>) }
      if (typeof o.apiKey === 'string' && o.apiKey) {
        o.apiKey = encryptSecretAtRest(o.apiKey)
      }
      return o
    })
  }

  return out
}
