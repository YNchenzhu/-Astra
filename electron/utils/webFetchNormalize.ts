/**
 * Normalize WebFetch URL input — upstream-style `domain:` host form plus plain http(s) URLs.
 * Shared by Zod registry validation and {@link toolWebFetch} so IPC and agent paths stay aligned.
 */

export type WebFetchUrlNormalizeResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

/**
 * Accepts:
 * - `https://...` / `http://...`
 * - `domain:example.com` → `https://example.com`
 * - `domain:https://example.com/path` → unchanged URL after prefix
 */
export function normalizeWebFetchUrlInput(raw: string): WebFetchUrlNormalizeResult {
  const t = typeof raw === 'string' ? raw.trim() : ''
  if (!t) {
    return { ok: false, error: 'url is required' }
  }
  if (t.toLowerCase().startsWith('domain:')) {
    const rest = t.slice('domain:'.length).trim()
    if (!rest) {
      return { ok: false, error: 'domain: prefix requires a hostname or URL after it' }
    }
    if (/\s/.test(rest)) {
      return { ok: false, error: 'domain: target must not contain whitespace' }
    }
    if (rest.startsWith('http://') || rest.startsWith('https://')) {
      return { ok: true, url: rest }
    }
    return { ok: true, url: `https://${rest}` }
  }
  if (t.startsWith('http://') || t.startsWith('https://')) {
    return { ok: true, url: t }
  }
  return {
    ok: false,
    error: 'URL must start with http://, https://, or domain: (OpenClaude WebFetch style)',
  }
}
