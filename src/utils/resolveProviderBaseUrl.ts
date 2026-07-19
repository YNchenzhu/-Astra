/**
 * Built-in API base URLs when the user leaves「接口地址」empty.
 * Reads from `src/data/providerRegistry.ts` so there is a single source of
 * truth — no more duplicated switch blocks across client.ts / providers.ts /
 * resolveProviderBaseUrl.ts.
 */

import { PROVIDER_ENTRIES } from '../data/providerRegistry'

export function getBuiltinDefaultBaseUrl(providerId: string): string {
  const entry = PROVIDER_ENTRIES.find((e) => e.id === providerId)
  return entry?.baseUrl ?? ''
}

/** Non-empty trimmed user URL wins; otherwise the built-in default for `providerId`. */
export function resolveProviderBaseUrl(providerId: string, storedBaseUrl: unknown): string {
  const raw = typeof storedBaseUrl === 'string' ? storedBaseUrl.trim() : ''
  if (raw.length > 0) return raw
  return getBuiltinDefaultBaseUrl(providerId)
}

/**
 * Validate a user-typed `baseUrl` value at save time.
 *
 * Returns `null` when the value is acceptable (empty → falls back to the
 * built-in default; or a well-formed http(s) URL). Otherwise returns a
 * Chinese description of why it's invalid that the caller can drop into
 * an alert / inline error message.
 *
 * Why this exists: the SettingsDialog has "接口地址" right above
 * "API 密钥", and users routinely paste their `sk-...` key into the
 * wrong field. Without this gate, the bad value flows through
 * `resolveProviderBaseUrl` (which trusts whatever non-empty string the
 * user typed) into the main-process compatible client, where
 * `fetch(\`${baseUrl}/v1/responses\`)` ultimately throws the cryptic
 * `TypeError: Failed to parse URL from sk-.../v1/responses`. The runtime
 * has its own guard (`assertValidBaseUrl` in
 * `electron/ai/compatibleClient.ts`) for already-saved bad configs, but
 * catching it at save time is strictly nicer UX.
 */
export function describeInvalidBaseUrl(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed.length === 0) return null
  let parsed: URL | null = null
  try {
    parsed = new URL(trimmed)
  } catch {
    parsed = null
  }
  if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    return null
  }
  const looksLikeApiKey =
    /^sk-/i.test(trimmed) ||
    /^AIza[A-Za-z0-9_-]{10,}$/.test(trimmed) ||
    (!/[/:]/.test(trimmed) && /^[A-Za-z0-9_-]{20,}$/.test(trimmed))
  if (looksLikeApiKey) {
    return '该值看起来是 API 密钥，请把它填到下面的「API 密钥」字段；「接口地址」请留空使用默认地址，或填写完整的 https:// 端点 URL。'
  }
  return '请填写以 http:// 或 https:// 开头的完整 URL，或留空使用内置默认地址。'
}
