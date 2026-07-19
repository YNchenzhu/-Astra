/**
 * WebSearch (Brave) API key resolver.
 *
 * Only `settings.webSearchBraveApiKey` is consulted — by design the main
 * process ignores `process.env.BRAVE_API_KEY` so users have a single source
 * of truth. The Brave MCP preset ships with {@link BRAVE_SEARCH_API_KEY_PLACEHOLDER}
 * which we substitute at spawn time.
 *
 * The raw value from disk goes through {@link normalizeBraveApiKey} which is
 * stricter than the generic {@link normalizeApiKeyInput}: Brave keys are
 * opaque tokens with no whitespace and no wrapper syntax, so any surrounding
 * quotes, `Bearer ` prefix, `X-Subscription-Token:` header-form prefix, or
 * interior whitespace is almost certainly a copy-paste artifact and we
 * quietly strip it. This has eliminated the single most common source of
 * `SUBSCRIPTION_TOKEN_INVALID` 422 errors.
 */

import { normalizeApiKeyInput } from '../ai/diskCredentials'
import { readDiskSettings } from './settingsAccess'

/** Preset/docs only — never a real token; replaced with Settings → Tools value when spawning Brave MCP. */
export const BRAVE_SEARCH_API_KEY_PLACEHOLDER = '__BRAVE_KEY_FROM_SETTINGS_TOOLS__'

export type BraveSearchApiKeySource = 'settings:webSearchBraveApiKey' | 'none'

/**
 * Strip every common copy-paste wrapper from a user-entered Brave key.
 *
 * We intentionally do NOT reject any shape — if what's left doesn't start
 * with `BSA` Brave will still reject it, and we surface that as part of the
 * `SUBSCRIPTION_TOKEN_INVALID` diagnostic message. The job of this function
 * is to be tolerant of the real paste sources we've seen in the wild:
 *
 *   - `BSAabc123` (clean) → unchanged
 *   - `"BSAabc123"`, `'BSAabc123'`, ``` `BSAabc123` ``` → unwrap quotes
 *   - `Bearer BSAabc123` / `bearer BSAabc123` → drop `Bearer ` prefix
 *   - `X-Subscription-Token: BSAabc123` → drop HTTP-header-style prefix
 *   - `BSA abc 123` (stray interior spaces from a terminal paste) → `BSAabc123`
 *   - Keys with `\r\n` mid-string (notepad roundtrip) → stripped
 *   - Zero-width characters / BOM — already handled by `normalizeApiKeyInput`
 *
 * The order matters: trim-and-de-bom first, then strip `Bearer`/`Subscription-Token`
 * (so we can operate on the real token), then unwrap quotes, then drop interior
 * whitespace.
 */
export function normalizeBraveApiKey(raw: unknown): string {
  let s = normalizeApiKeyInput(raw)
  if (!s) return ''

  // Step 1 — unwrap a single layer of surrounding quotes FIRST. A common
  // paste shape is `"X-Subscription-Token: BSA..."` where the quotes wrap
  // the full header line; stripping them up front lets the later header /
  // Bearer passes see the real content.
  const QUOTE_PAIRS: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['\u201C', '\u201D'], // U+201C LEFT / U+201D RIGHT double curly
    ['\u2018', '\u2019'], // U+2018 LEFT / U+2019 RIGHT single curly
  ]
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      s = s.slice(open.length, s.length - close.length).trim()
      break
    }
  }

  // Step 2 — strip HTTP-header-style prefix that users sometimes copy from
  // the Brave docs' `curl` snippet (`-H "X-Subscription-Token: BSA..."`).
  // Case-insensitive because Brave's docs mix cases.
  const headerPrefix = /^x-subscription-token\s*:\s*/i
  if (headerPrefix.test(s)) {
    s = s.replace(headerPrefix, '').trim()
  }

  // Step 3 — strip a leading `Bearer ` prefix — surprisingly common when
  // users copy from OAuth-style helper docs and try to reuse the value.
  const bearerPrefix = /^bearer\s+/i
  if (bearerPrefix.test(s)) {
    s = s.replace(bearerPrefix, '').trim()
  }

  // Step 4 — Brave tokens have no interior whitespace; strip every ASCII /
  // Unicode whitespace char that survived (covers embedded `\r\n` from
  // Notepad roundtrip pastes, NBSPs from web copies, and rogue Tabs).
  s = s.replace(/\s+/g, '')

  return s
}

export function resolveBraveSearchApiKeyMeta(): {
  key: string | undefined
  source: BraveSearchApiKeySource
} {
  const s = readDiskSettings()
  const k = normalizeBraveApiKey(s.webSearchBraveApiKey)
  if (k && k !== BRAVE_SEARCH_API_KEY_PLACEHOLDER) {
    return { key: k, source: 'settings:webSearchBraveApiKey' }
  }
  return { key: undefined, source: 'none' }
}

export function resolveBraveSearchApiKey(): string | undefined {
  return resolveBraveSearchApiKeyMeta().key
}

/**
 * Produce a masked preview of a Brave key for diagnostics (UI status line,
 * 422 error messages). Never returns enough to recover the token —
 * shows the first 3 and last 4 characters with length. Short keys
 * (< 12 chars) are fully redacted so we don't accidentally leak a test
 * key someone typed by hand.
 *
 * Examples:
 *   "BSAabcdefgh12345" → "BSA…2345 (16 chars)"
 *   "abc"              → "(hidden, 3 chars)"
 *   undefined / empty  → "(none)"
 */
export function maskBraveApiKeyForDiagnostics(key: string | undefined | null): string {
  return maskApiKeyGeneric(key, 3)
}

// ─────────────────────────────────────────────────────────────────────────
// Baidu AI Search API
// ─────────────────────────────────────────────────────────────────────────

/** Canonical Baidu API key prefix. */
export const BAIDU_API_KEY_PREFIX = 'bce-v3/ALTAK-'

export type BaiduSearchApiKeySource = 'settings:webSearchBaiduApiKey' | 'none'

/**
 * Strip every common copy-paste wrapper from a user-entered Baidu key.
 * Follows the same strategy as {@link normalizeBraveApiKey}:
 *
 *   1. Unwrap outer quotes (ASCII + Unicode curly variants)
 *   2. Strip `Authorization:` / `Bearer ` header-style prefixes
 *   3. Strip interior whitespace (Baidu keys have none)
 *
 * Note: Baidu keys DO contain slashes (`/`) and hyphens (`-`) — that is
 * part of the canonical `bce-v3/ALTAK-...` format. Don't get clever about
 * stripping those.
 */
export function normalizeBaiduApiKey(raw: unknown): string {
  let s = normalizeApiKeyInput(raw)
  if (!s) return ''

  const QUOTE_PAIRS: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['\u201C', '\u201D'],
    ['\u2018', '\u2019'],
  ]
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      s = s.slice(open.length, s.length - close.length).trim()
      break
    }
  }

  // `Authorization: Bearer <key>` is the standard HTTP shape Baidu's docs
  // use in curl snippets — users paste the whole thing surprisingly often.
  const authPrefix = /^authorization\s*:\s*/i
  if (authPrefix.test(s)) {
    s = s.replace(authPrefix, '').trim()
  }
  const bearerPrefix = /^bearer\s+/i
  if (bearerPrefix.test(s)) {
    s = s.replace(bearerPrefix, '').trim()
  }

  // Interior whitespace / control chars — keys never contain them.
  s = s.replace(/\s+/g, '')
  return s
}

export function resolveBaiduSearchApiKeyMeta(): {
  key: string | undefined
  source: BaiduSearchApiKeySource
} {
  const s = readDiskSettings()
  const k = normalizeBaiduApiKey(s.webSearchBaiduApiKey)
  if (k) {
    return { key: k, source: 'settings:webSearchBaiduApiKey' }
  }
  return { key: undefined, source: 'none' }
}

export function resolveBaiduSearchApiKey(): string | undefined {
  return resolveBaiduSearchApiKeyMeta().key
}

/**
 * Masked preview tuned for Baidu keys — they're longer than Brave keys and
 * have a distinctive `bce-v3/ALTAK-` prefix, so we reveal 13 chars from the
 * head so the prefix is visible (proof the key is shape-valid) + 4 from
 * the tail for identification.
 *
 *   "bce-v3/ALTAK-<redacted>"  → "bce-v3/ALTAK-…tail (N chars)"
 *   short noise                → "(hidden, N chars)"
 */
export function maskBaiduApiKeyForDiagnostics(key: string | undefined | null): string {
  return maskApiKeyGeneric(key, BAIDU_API_KEY_PREFIX.length)
}

// ─────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a mask of the form `{first N}…{last 4} (length chars)`. Used by
 * both Brave and Baidu diagnostics; `headLen` varies per provider so the
 * visible prefix conveys enough to recognise the key shape.
 */
function maskApiKeyGeneric(
  key: string | undefined | null,
  headLen: number,
): string {
  const k = typeof key === 'string' ? key.trim() : ''
  if (!k) return '(none)'
  // Hide when the total length is below `head + '…' + tail + 1` — otherwise
  // the preview would leak effectively the entire key. `head + 9` matches
  // the historical Brave threshold (head 3 → hide at < 12 chars) while also
  // keeping Baidu's 13-char prefix safely behind its own mask threshold.
  if (k.length < headLen + 9) return `(hidden, ${k.length} chars)`
  const head = k.slice(0, headLen)
  const tail = k.slice(-4)
  return `${head}…${tail} (${k.length} chars)`
}
