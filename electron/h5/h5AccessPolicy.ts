/**
 * H5 access policy — CORS + origin allow-listing + token extraction.
 *
 * Adapted from upstream's `src/server/h5AccessPolicy.ts`. The cursor-ui-clone
 * desktop app talks to its main process over Electron IPC, NOT over this HTTP
 * server, so the original "local-trusted vs h5-browser" classification is not
 * needed: every request to this server is a remote/H5 request and must present
 * a valid token (except `/health` and CORS preflight).
 *
 * Wildcard origins are intentionally unsupported — CORS is always explicit.
 */
import type { IncomingMessage } from 'node:http'

export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/$/, '').toLowerCase()
}

/**
 * Loopback / local-shell origins are always allowed (parity with upstream): a
 * browser served from the same machine, or the Electron `file://` shell, can
 * always reach the API regardless of the configured allow-list.
 */
export function isAlwaysAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false
  if (origin === 'null' || origin === 'file://') return true
  try {
    const host = new URL(origin).hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

export function isOriginAllowed(origin: string | null | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false
  if (isAlwaysAllowedOrigin(origin)) return true
  const normalized = normalizeOrigin(origin)
  return allowedOrigins.some((allowed) => normalizeOrigin(allowed) === normalized)
}

/**
 * True when the request carries no browser navigation `Origin`, or one that can
 * only come from the local desktop shell (`file://` / `localhost`). A real
 * cross-site browser page always sends its own `https://…` Origin, so this is
 * what distinguishes the on-machine IM adapter (no Origin) from a malicious web
 * page the user happens to be visiting (which CAN reach `127.0.0.1`).
 *
 * Mirrors upstream's `isLocalDesktopOrNavigationOrigin` and is the missing half
 * of the loopback trust check — loopback IP alone is NOT sufficient.
 */
export function isLocalNavigationOrigin(origin: string | null | undefined): boolean {
  if (!origin) return true
  return isAlwaysAllowedOrigin(origin)
}

/**
 * A request is "local-trusted" (token-exempt) ONLY when it comes from a
 * loopback peer AND has a local/absent navigation Origin. This blocks the
 * DNS-rebinding / CSRF class where a remote web page drives the loopback IM
 * surface from the user's own browser.
 */
export function isLocalTrustedRequest(
  remoteAddress: string | null | undefined,
  origin: string | null | undefined,
  isLoopback: (addr: string | null | undefined) => boolean,
): boolean {
  return isLoopback(remoteAddress) && isLocalNavigationOrigin(origin)
}

/** CORS response headers for an allowed origin, or `{}` when the origin is not allowed. */
export function corsHeadersForOrigin(
  origin: string | null | undefined,
  allowedOrigins: string[],
): Record<string, string> {
  if (!isOriginAllowed(origin, allowedOrigins)) return {}
  return {
    'Access-Control-Allow-Origin': origin as string,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Credentials': 'false',
    'Vary': 'Origin',
    'Access-Control-Max-Age': '600',
  }
}

/** Extract a bearer token from `Authorization: Bearer <t>` or the `token` query param. */
export function extractToken(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers['authorization']
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (m) return m[1].trim()
  }
  const q = url.searchParams.get('token')
  if (q && q.trim()) return q.trim()
  return null
}

/** Paths that require a valid H5 token. */
export function isProtectedPath(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname.startsWith('/ws')
}
