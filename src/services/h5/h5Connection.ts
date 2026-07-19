/**
 * H5 browser-mode connection state.
 *
 * When the renderer runs in a phone/desktop browser (no Electron preload), it
 * connects to a desktop instance's H5 server using a Server URL + Token. Both
 * are persisted in localStorage; the Server URL may also be seeded from a
 * `?serverUrl=` query parameter (see the H5 access docs).
 */
const SERVER_URL_KEY = 'h5.serverUrl'
const TOKEN_KEY = 'h5.token'

export interface H5ConnectionInfo {
  serverUrl: string
  token: string
}

/** True when running outside Electron (no real preload-injected electronAPI). */
export function isBrowserMode(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as { electronAPI?: unknown; __H5_BROWSER_MODE__?: boolean }
  if (w.__H5_BROWSER_MODE__) return true
  return !w.electronAPI
}

function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/$/, '')
}

/**
 * Seed the server URL + token from query params if present (persisted for
 * reloads). Supports the scan-to-connect QR flow: a QR encodes
 * `?serverUrl=<api>&h5Token=<token>` so the phone connects without typing.
 */
function seedFromQuery(): void {
  try {
    const params = new URLSearchParams(window.location.search)
    const fromQuery = params.get('serverUrl')
    if (fromQuery && fromQuery.trim()) {
      localStorage.setItem(SERVER_URL_KEY, normalizeServerUrl(fromQuery))
    }
    const token = params.get('h5Token') || params.get('token')
    if (token && token.trim()) {
      localStorage.setItem(TOKEN_KEY, token.trim())
    }
  } catch {
    /* ignore */
  }
}

export function getStoredConnection(): H5ConnectionInfo | null {
  try {
    seedFromQuery()
    const serverUrl = localStorage.getItem(SERVER_URL_KEY)
    const token = localStorage.getItem(TOKEN_KEY)
    if (serverUrl && token) return { serverUrl: normalizeServerUrl(serverUrl), token }
  } catch {
    /* ignore */
  }
  return null
}

export function getStoredServerUrl(): string {
  try {
    seedFromQuery()
    const stored = localStorage.getItem(SERVER_URL_KEY)
    if (stored) return normalizeServerUrl(stored)
    // When the SPA is served by the H5 server itself, default to the current
    // origin so a same-origin connection needs only the token.
    if (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') {
      return window.location.origin
    }
    return ''
  } catch {
    return ''
  }
}

export function setStoredConnection(info: H5ConnectionInfo): void {
  localStorage.setItem(SERVER_URL_KEY, normalizeServerUrl(info.serverUrl))
  localStorage.setItem(TOKEN_KEY, info.token)
}

export function clearStoredConnection(): void {
  localStorage.removeItem(TOKEN_KEY)
  // Keep the server URL so a re-connect only needs the token re-entered.
}

export type H5VerifyResult =
  | { ok: true }
  | { ok: false; kind: 'unreachable' | 'unauthorized' | 'disabled' | 'unknown'; message: string }

/** Probe `/health` then a token-protected endpoint to validate the connection. */
export async function verifyConnection(info: H5ConnectionInfo): Promise<H5VerifyResult> {
  const base = normalizeServerUrl(info.serverUrl)
  let health: Response
  try {
    health = await fetch(`${base}/health`, { method: 'GET' })
  } catch {
    return { ok: false, kind: 'unreachable', message: '无法连接到 Server URL，请检查地址、端口、防火墙或反向代理。' }
  }
  if (!health.ok) {
    return { ok: false, kind: 'unreachable', message: `服务返回 ${health.status}。` }
  }
  try {
    const body = (await health.json()) as { enabled?: boolean }
    if (body && body.enabled === false) {
      return { ok: false, kind: 'disabled', message: 'H5 访问在桌面端设置里是关闭状态，请先启用。' }
    }
  } catch {
    /* /health body optional */
  }

  let ping: Response
  try {
    ping = await fetch(`${base}/api/ping`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${info.token}` },
    })
  } catch {
    return { ok: false, kind: 'unreachable', message: '健康检查通过，但 API 请求失败（可能被 CORS 拦截）。' }
  }
  if (ping.status === 401) {
    return { ok: false, kind: 'unauthorized', message: 'Token 无效，请在桌面端设置页复制最新 Token。' }
  }
  if (ping.status === 503) {
    return { ok: false, kind: 'disabled', message: 'H5 访问已关闭，请在桌面端启用。' }
  }
  if (!ping.ok) {
    return { ok: false, kind: 'unknown', message: `API 返回 ${ping.status}。` }
  }
  return { ok: true }
}
