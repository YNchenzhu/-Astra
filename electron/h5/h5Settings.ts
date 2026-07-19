/**
 * H5 / remote-access settings + token management.
 *
 * Ported from upstream's H5 access design (`docs/superpowers/specs/2026-05-09-h5-access-design.md`).
 * The desktop app keeps using IPC; this layer only governs the optional
 * HTTP/WebSocket server that exposes the chat surface to a phone browser or an
 * IM adapter over LAN / a self-managed reverse proxy.
 *
 * Persistence reuses the existing main-process settings file
 * (`星构Astra-settings.json`) under the `h5Access` key, so the settings UI can
 * read/write the non-secret fields through the regular `settings:get/set`
 * channels. Only the token *hash* is stored — the raw token is shown once at
 * generation time and never persisted.
 */
import crypto from 'node:crypto'
import { loadSettings, saveSettings } from '../settings/settingsStore'

export interface H5AccessSettings {
  /** Master switch. When false the server is not started and remote auth is rejected. */
  enabled: boolean
  /** sha256 hex of the active token. `null` until a token is generated. */
  tokenHash: string | null
  /** Masked preview (e.g. `ab12…9f`) for display in Settings. Never the raw token. */
  tokenPreview: string | null
  /** Explicit CORS allow-list. Wildcards are intentionally NOT supported. */
  allowedOrigins: string[]
  /** Optional public frontend base URL for building a shareable H5 URL behind a proxy. */
  publicBaseUrl: string | null
  /** Bind host. Default loopback; set to `0.0.0.0` (or a LAN IP) to expose on LAN. */
  host: string
  /** Bind port. */
  port: number
}

export const H5_SETTINGS_KEY = 'h5Access'

const DEFAULTS: H5AccessSettings = {
  enabled: false,
  tokenHash: null,
  tokenPreview: null,
  allowedOrigins: [],
  publicBaseUrl: null,
  host: '127.0.0.1',
  port: 5174,
}

/**
 * Normalize a single allowed origin to `scheme://host[:port]` with no path and
 * no wildcard. Returns `null` for invalid / unsupported entries so they are
 * dropped rather than silently never matching.
 */
export function normalizeAllowedOrigin(raw: string): string | null {
  const t = raw.trim()
  if (!t || t.includes('*')) return null
  try {
    const u = new URL(t)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    // Reject embedded credentials — an allow-list entry must be a bare origin.
    if (u.username || u.password) return null
    return u.origin
  } catch {
    return null
  }
}

/**
 * Normalize an optional public base URL (for building a shareable H5 URL behind
 * a proxy). Must be a valid http/https URL with no credentials; the trailing
 * slash is stripped. Returns `null` for empty/invalid input so we never persist
 * a malformed value that would later produce a broken launch URL.
 */
export function normalizePublicBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t) return null
  try {
    const u = new URL(t)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.origin}${path === '/' ? '' : path}`
  } catch {
    return null
  }
}

/**
 * Normalize the bind host. Accepts a bare hostname/IP; if a full URL slipped in
 * (e.g. pasted `http://0.0.0.0:5174`) we extract the hostname. Anything with a
 * path/space is rejected back to the default loopback host.
 */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t) return null
  if (t.includes('://')) {
    try {
      return new URL(t).hostname || null
    } catch {
      return null
    }
  }
  if (/[\s/\\]/.test(t)) return null
  return t
}

function coerce(raw: unknown): H5AccessSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const allowed = Array.isArray(r.allowedOrigins)
    ? Array.from(
        new Set(
          r.allowedOrigins
            .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
            .map((o) => normalizeAllowedOrigin(o))
            .filter((o): o is string => o !== null),
        ),
      )
    : DEFAULTS.allowedOrigins
  const portNum = typeof r.port === 'number' && Number.isInteger(r.port) && r.port > 0 && r.port < 65536
    ? r.port
    : DEFAULTS.port
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
    tokenHash: typeof r.tokenHash === 'string' && r.tokenHash.length > 0 ? r.tokenHash : null,
    tokenPreview: typeof r.tokenPreview === 'string' && r.tokenPreview.length > 0 ? r.tokenPreview : null,
    allowedOrigins: allowed,
    publicBaseUrl: normalizePublicBaseUrl(r.publicBaseUrl),
    host: normalizeHost(r.host) ?? DEFAULTS.host,
    port: portNum,
  }
}

export function loadH5Settings(): H5AccessSettings {
  const settings = loadSettings()
  return coerce(settings[H5_SETTINGS_KEY])
}

/** Merge-and-persist a partial update. Returns the resulting full settings. */
export function saveH5Settings(patch: Partial<H5AccessSettings>): H5AccessSettings {
  const settings = loadSettings()
  const current = coerce(settings[H5_SETTINGS_KEY])
  const next: H5AccessSettings = { ...current, ...patch }
  // Re-coerce so we never persist an invalid shape (e.g. bad port from UI).
  const coerced = coerce(next)
  settings[H5_SETTINGS_KEY] = coerced
  saveSettings(settings)
  return coerced
}

export function hashH5Token(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

function maskToken(token: string): string {
  if (token.length <= 6) return '••••'
  return `${token.slice(0, 4)}…${token.slice(-2)}`
}

/**
 * Generate a high-entropy token, persist only its hash + masked preview, and
 * return the raw token to the caller exactly once.
 */
export function generateAndStoreH5Token(): { token: string; preview: string } {
  const token = crypto.randomBytes(32).toString('base64url')
  const preview = maskToken(token)
  saveH5Settings({ tokenHash: hashH5Token(token), tokenPreview: preview })
  return { token, preview }
}

/** Constant-time comparison of a presented token against the stored hash. */
export function verifyH5Token(token: string | null | undefined): boolean {
  if (!token) return false
  const { tokenHash } = loadH5Settings()
  if (!tokenHash) return false
  const presented = Buffer.from(hashH5Token(token), 'hex')
  const expected = Buffer.from(tokenHash, 'hex')
  if (presented.length !== expected.length) return false
  return crypto.timingSafeEqual(presented, expected)
}

/** Strip the secret hash before sending H5 status to the renderer. */
export function toH5StatusForRenderer(s: H5AccessSettings): Omit<H5AccessSettings, 'tokenHash'> & { hasToken: boolean } {
  const { tokenHash, ...rest } = s
  return { ...rest, hasToken: Boolean(tokenHash) }
}
