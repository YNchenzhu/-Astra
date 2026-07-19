/**
 * H5 remote-access HTTP + WebSocket server (Electron main process).
 *
 * Exposes a minimal, token-authenticated surface so a phone browser (reusing
 * the desktop React renderer in browser mode) or an IM adapter can drive the
 * same agentic chat the desktop UI uses. Disabled by default; controlled from
 * Settings → 远程访问 (H5).
 *
 * - REST (`/api/*`): conversations CRUD + chat send/cancel + permission/ask replies.
 * - WebSocket (`/ws`): server→client push of `StreamEvent`s for a conversation.
 *
 * Auth: every `/api/*` and `/ws` request needs a valid H5 token. Browser
 * requests (with an `Origin` header) additionally need an allow-listed origin
 * for CORS. `/health` is unauthenticated and returns only minimal status.
 */
import http from 'node:http'
import os from 'node:os'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  corsHeadersForOrigin,
  extractToken,
  isLocalTrustedRequest,
  isOriginAllowed,
  isProtectedPath,
} from './h5AccessPolicy'
import { loadH5Settings, verifyH5Token } from './h5Settings'
import {
  isRateLimited,
  recordTokenFailure,
  recordTokenSuccess,
  resetH5RateLimit,
} from './h5RateLimit'
import {
  cancelH5Chat,
  startH5Chat,
  startH5ChatBridge,
  stopH5ChatBridge,
  subscribe,
  unsubscribe,
  type H5SendRequest,
} from './h5ChatBridge'
import {
  deleteConversation,
  listConversations,
  loadConversation,
  renameConversation,
  saveConversation,
} from '../conversation/service'
import type { ConversationMessage } from '../conversation/types'
import { respondAskUserQuestion, respondPermissionRequest } from '../ai/interactionState'
import { loadImConfig } from './imConfig'
import {
  handleImRest,
  handleImUpgrade,
  isImRestPath,
  isImWsPath,
  isLoopbackAddress,
  startImBridge,
  stopImBridge,
} from './imBridge'
import { serveStatic } from './h5Static'
import { getBrowserSettings, saveBrowserSettings } from './h5SettingsApi'

let server: http.Server | null = null
let wss: WebSocketServer | null = null
let currentHost = ''
let currentPort = 0

const MAX_BODY_BYTES = 8 * 1024 * 1024 // 8 MiB — generous for image-bearing messages.

export interface H5ServerStatus {
  running: boolean
  host: string
  port: number
  /** Best-guess physical LAN IPv4 for building a scannable URL (0.0.0.0 binds). */
  lanAddress: string | null
  /** All candidate LAN IPv4s (best-first) so the user can pick the reachable one. */
  lanAddresses: string[]
}

// Interface-name fragments for adapters a phone on the Wi-Fi LAN normally
// CANNOT reach (VPN tunnels, WSL, VM bridges, container/virtual switches).
// Their IPs (often 10.x / 172.x) must NOT be the default QR target.
const VIRTUAL_IFACE_RE =
  /vpn|virtual|vmware|vbox|virtualbox|hyper-?v|vethernet|default switch|wsl|tailscale|zerotier|\btap\b|\btun\b|utun|anycast|docker|bridge|loopback/i

function scoreInterface(name: string, address: string): number {
  let score = 0
  if (VIRTUAL_IFACE_RE.test(name)) score -= 100
  if (/wlan|wi-?fi|wireless|无线|ethernet|以太网|en\d|eth\d/i.test(name)) score += 5
  if (address.startsWith('192.168.')) score += 4
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 2
  else if (address.startsWith('10.')) score += 1
  return score
}

/** All non-internal IPv4 LAN addresses, best (most phone-reachable) first. */
function getLanAddresses(): string[] {
  try {
    const candidates: Array<{ address: string; score: number }> = []
    for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
      for (const iface of ifaces ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          candidates.push({ address: iface.address, score: scoreInterface(name, iface.address) })
        }
      }
    }
    return candidates.sort((a, b) => b.score - a.score).map((c) => c.address)
  } catch {
    return []
  }
}

function getLanAddress(): string | null {
  return getLanAddresses()[0] ?? null
}

export function getH5ServerStatus(): H5ServerStatus {
  return {
    running: server !== null,
    host: currentHost,
    port: currentPort,
    lanAddress: getLanAddress(),
    lanAddresses: getLanAddresses(),
  }
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  cors: Record<string, string>,
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...cors })
  res.end(payload)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = 0
    const chunks: Buffer[] = []
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        done = true
        reject(new Error('payload too large'))
        try { req.destroy() } catch { /* ignore */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (err) => {
      if (done) return
      done = true
      reject(err)
    })
  })
}

async function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const raw = await readBody(req)
  if (!raw.trim()) return {} as T
  return JSON.parse(raw) as T
}

/**
 * Origins always allowed for a request, in addition to the configured list:
 * the server's OWN origin (the SPA we served talks to itself — same-origin
 * requests still carry an `Origin` header on POST, so without this a phone
 * loading the bundle from `http://<lan-ip>:<port>` would be CORS-blocked).
 */
function effectiveAllowedOrigins(req: http.IncomingMessage, configured: string[]): string[] {
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  if (!host) return configured
  return [...configured, `http://${host}`, `https://${host}`]
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const settings = loadH5Settings()
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null
  const allowed = effectiveAllowedOrigins(req, settings.allowedOrigins)
  const cors = corsHeadersForOrigin(origin, allowed)
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const { pathname } = url
  const method = (req.method || 'GET').toUpperCase()

  // CORS preflight.
  if (method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }

  // Unauthenticated health probe. Only the loopback desktop bootstrap needs the
  // `enabled` flag; remote callers get a minimal body so a probe can't be used
  // to fingerprint whether H5 is configured on this host.
  if (pathname === '/health') {
    const localProbe = isLocalTrustedRequest(req.socket.remoteAddress, origin, isLoopbackAddress)
    sendJson(res, 200, localProbe ? { ok: true, enabled: settings.enabled } : { ok: true }, cors)
    return
  }

  // "Local-trusted" = loopback peer AND a local/absent navigation Origin. Bare
  // loopback is NOT enough: a malicious web page in the user's browser can also
  // reach 127.0.0.1, so we additionally require the Origin to be absent/local.
  const localTrusted = isLocalTrustedRequest(req.socket.remoteAddress, origin, isLoopbackAddress)

  // IM adapter bridge REST (upstream protocol). This is the local backbone the
  // WeChat adapter needs (session create / git-info / tasks) and is available
  // whenever the server runs — independent of the H5 *browser* toggle, since a
  // bound IM account is reason enough for the server to be up. Local-trusted
  // clients (the adapter on the same machine, no browser Origin) are
  // token-exempt; everyone else needs the H5 token AND H5 enabled.
  if (isImRestPath(pathname)) {
    if (!localTrusted) {
      const remote = req.socket.remoteAddress
      if (isRateLimited(remote)) {
        sendJson(res, 429, { message: 'too many attempts' }, cors)
        return
      }
      if (!settings.enabled || !verifyH5Token(extractToken(req, url))) {
        recordTokenFailure(remote)
        sendJson(res, 401, { message: 'invalid or missing token' }, cors)
        return
      }
      recordTokenSuccess(remote)
    }
    try {
      const handled = await handleImRest(
        method,
        pathname,
        req,
        (status, body) => sendJson(res, status, body, cors),
        <T,>() => parseJsonBody<T>(req),
      )
      if (handled) return
    } catch (err) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : String(err) }, cors)
      return
    }
    sendJson(res, 404, { message: 'not found' }, cors)
    return
  }

  // Everything below is the H5 *browser* surface — gated on the H5 toggle.
  if (!settings.enabled) {
    sendJson(res, 503, { error: 'H5 access is disabled' }, cors)
    return
  }

  // Serve the renderer SPA bundle (unauthenticated, same-origin) for any GET
  // that is not an API / WS call. The bundle boots into H5 connect mode in a
  // browser; only `/api/*` + `/ws` are token-gated below.
  if (method === 'GET' && !pathname.startsWith('/api/') && pathname !== '/ws') {
    if (serveStatic(pathname, res, cors)) return
  }

  // Auth for protected surfaces.
  if (isProtectedPath(pathname)) {
    const remote = req.socket.remoteAddress
    if (origin && !isOriginAllowed(origin, allowed)) {
      sendJson(res, 403, { error: 'origin not allowed' }, cors)
      return
    }
    if (isRateLimited(remote)) {
      sendJson(res, 429, { error: 'too many attempts' }, cors)
      return
    }
    if (!verifyH5Token(extractToken(req, url))) {
      recordTokenFailure(remote)
      sendJson(res, 401, { error: 'invalid or missing token' }, cors)
      return
    }
    recordTokenSuccess(remote)
  }

  try {
    await routeApi(method, pathname, url, req, res, cors)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    sendJson(res, 400, { error: message }, cors)
  }
}

async function routeApi(
  method: string,
  pathname: string,
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  // Token-protected liveness probe used by the browser connect screen.
  if (method === 'GET' && pathname === '/api/ping') {
    sendJson(res, 200, { ok: true }, cors)
    return
  }

  // ── Conversations ──────────────────────────────────────────────
  if (method === 'GET' && pathname === '/api/conversations') {
    const workspacePath = url.searchParams.get('workspacePath') || ''
    if (!workspacePath) throw new Error('workspacePath required')
    sendJson(res, 200, { conversations: listConversations(workspacePath) }, cors)
    return
  }

  const convMatch = /^\/api\/conversations\/([^/]+)$/.exec(pathname)
  if (method === 'GET' && convMatch) {
    const workspacePath = url.searchParams.get('workspacePath') || ''
    if (!workspacePath) throw new Error('workspacePath required')
    // Audit A1: H5 read must NOT reset the desktop's live `main` todo state.
    const data = loadConversation(decodeURIComponent(convMatch[1]), workspacePath, undefined, {
      restoreMainTodoState: false,
    })
    if (!data) {
      sendJson(res, 404, { error: 'not found' }, cors)
      return
    }
    sendJson(res, 200, data, cors)
    return
  }

  if (method === 'POST' && pathname === '/api/conversations/save') {
    const body = await parseJsonBody<{
      id?: string
      workspacePath?: string
      messages?: ConversationMessage[]
      model?: string
      providerId?: string
    }>(req)
    if (!body.id || !body.workspacePath || !Array.isArray(body.messages)) {
      throw new Error('id, workspacePath and messages required')
    }
    const meta = saveConversation({
      id: body.id,
      workspacePath: body.workspacePath,
      messages: body.messages,
      model: body.model,
      providerId: body.providerId,
    })
    sendJson(res, 200, meta, cors)
    return
  }

  const renameMatch = /^\/api\/conversations\/([^/]+)\/rename$/.exec(pathname)
  if (method === 'POST' && renameMatch) {
    const body = await parseJsonBody<{ workspacePath?: string; title?: string }>(req)
    if (!body.workspacePath || !body.title) throw new Error('workspacePath and title required')
    const ok = renameConversation(decodeURIComponent(renameMatch[1]), body.workspacePath, body.title)
    sendJson(res, 200, { ok }, cors)
    return
  }

  const deleteMatch = /^\/api\/conversations\/([^/]+)\/delete$/.exec(pathname)
  if (method === 'POST' && deleteMatch) {
    const body = await parseJsonBody<{ workspacePath?: string }>(req)
    if (!body.workspacePath) throw new Error('workspacePath required')
    const ok = deleteConversation(decodeURIComponent(deleteMatch[1]), body.workspacePath)
    sendJson(res, 200, { ok }, cors)
    return
  }

  // ── Settings (browser reuses the desktop config; secrets masked) ──
  if (method === 'GET' && pathname === '/api/settings') {
    sendJson(res, 200, getBrowserSettings(), cors)
    return
  }
  if (method === 'POST' && pathname === '/api/settings') {
    const body = await parseJsonBody<Record<string, unknown>>(req)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('settings payload must be a JSON object')
    }
    saveBrowserSettings(body)
    sendJson(res, 200, { ok: true }, cors)
    return
  }

  // ── Chat ───────────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/api/chat/send') {
    const body = await parseJsonBody<H5SendRequest>(req)
    if (!Array.isArray(body.messages)) throw new Error('messages required')
    // Fire and forget — streaming is delivered over the WebSocket. Errors that
    // happen mid-turn surface as `error` stream events to the subscriber.
    void startH5Chat(body).catch((err) => {
      console.warn('[h5Server] startH5Chat failed:', err)
    })
    sendJson(res, 202, { ok: true, accepted: true }, cors)
    return
  }

  if (method === 'POST' && pathname === '/api/chat/cancel') {
    const body = await parseJsonBody<{ conversationId?: string }>(req)
    cancelH5Chat(body.conversationId)
    sendJson(res, 200, { ok: true }, cors)
    return
  }

  // ── HITL replies ───────────────────────────────────────────────
  if (method === 'POST' && pathname === '/api/permission/respond') {
    const body = await parseJsonBody<{
      requestId?: string
      behavior?: 'allow' | 'deny'
      updatedInput?: Record<string, unknown>
    }>(req)
    if (!body.requestId || (body.behavior !== 'allow' && body.behavior !== 'deny')) {
      throw new Error('requestId and behavior required')
    }
    const ok = respondPermissionRequest({
      requestId: body.requestId,
      behavior: body.behavior,
      updatedInput: body.updatedInput,
    })
    sendJson(res, 200, { ok }, cors)
    return
  }

  if (method === 'POST' && pathname === '/api/ask/respond') {
    const body = await parseJsonBody<{
      requestId?: string
      answers?: Record<string, string>
      conversationId?: string
    }>(req)
    if (!body.requestId || !body.answers) throw new Error('requestId and answers required')
    const ok = await respondAskUserQuestion({
      requestId: body.requestId,
      answers: body.answers,
      conversationId: body.conversationId,
    })
    sendJson(res, 200, { ok }, cors)
    return
  }

  sendJson(res, 404, { error: 'not found' }, cors)
}

function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const settings = loadH5Settings()
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null

  const reject = (code: number, message: string): void => {
    socket.write(`HTTP/1.1 ${code} ${message}\r\n\r\n`)
    socket.destroy()
  }

  // IM adapter session socket (`/ws/:sessionId`, upstream protocol) — the local
  // backbone for the WeChat adapter, available whenever the server runs
  // (independent of the H5 browser toggle). Local-trusted clients (loopback +
  // local/absent Origin) are token-exempt; everyone else needs H5 enabled +
  // token. WebSockets are NOT subject to the same-origin policy, so the Origin
  // check here is what stops a remote web page from driving the agent over a
  // loopback socket without a token.
  const remote = req.socket.remoteAddress
  if (isImWsPath(url.pathname)) {
    const localTrusted = isLocalTrustedRequest(remote, origin, isLoopbackAddress)
    if (!localTrusted) {
      if (isRateLimited(remote)) return reject(429, 'Too Many Requests')
      if (!settings.enabled || !verifyH5Token(extractToken(req, url))) {
        recordTokenFailure(remote)
        return reject(401, 'Unauthorized')
      }
      recordTokenSuccess(remote)
    }
    handleImUpgrade(req, socket, head, wss!, url.pathname)
    return
  }

  // The browser chat socket is gated on the H5 toggle.
  if (!settings.enabled) return reject(503, 'H5 disabled')
  if (url.pathname !== '/ws') return reject(404, 'Not Found')
  if (origin && !isOriginAllowed(origin, effectiveAllowedOrigins(req, settings.allowedOrigins))) {
    return reject(403, 'Forbidden')
  }
  if (isRateLimited(remote)) return reject(429, 'Too Many Requests')
  if (!verifyH5Token(extractToken(req, url))) {
    recordTokenFailure(remote)
    return reject(401, 'Unauthorized')
  }
  recordTokenSuccess(remote)

  wss!.handleUpgrade(req, socket, head, (ws) => {
    const conversationId = url.searchParams.get('conversationId') || undefined
    subscribe(conversationId, ws)
    ws.on('message', (data) => handleWsMessage(ws, data))
    ws.on('close', () => unsubscribe(ws))
    ws.on('error', () => unsubscribe(ws))
    try {
      ws.send(JSON.stringify({ channel: 'connected', conversationId: conversationId || 'default' }))
    } catch { /* ignore */ }
  })
}

function handleWsMessage(ws: WebSocket, data: unknown): void {
  // Allow re-subscribing to a different conversation over the open socket.
  try {
    const text = typeof data === 'string' ? data : data instanceof Buffer ? data.toString('utf8') : ''
    if (!text) return
    const msg = JSON.parse(text) as { type?: string; conversationId?: string }
    if (msg.type === 'subscribe') {
      unsubscribe(ws)
      subscribe(msg.conversationId, ws)
    }
  } catch {
    /* ignore malformed control frames */
  }
}

/**
 * Should the bridge server run? Yes when H5 browser access is enabled, OR when
 * a WeChat account is bound (the adapter needs the local `/api/sessions` +
 * `/ws/:id` backbone even without browser H5). Mirrors upstream, whose core
 * server is always available to local IM adapters.
 */
function shouldRunServer(enabled: boolean): boolean {
  if (enabled) return true
  try {
    const im = loadImConfig()
    return im.wechat.hasBotToken && Boolean(im.wechat.accountId)
  } catch {
    return false
  }
}

/** Start (or restart) the bridge server if enabled or WeChat is bound. Idempotent. */
export async function startH5Server(): Promise<H5ServerStatus> {
  const settings = loadH5Settings()
  if (!shouldRunServer(settings.enabled)) {
    return getH5ServerStatus()
  }
  if (server) {
    // Restart only if host/port changed.
    if (currentHost === settings.host && currentPort === settings.port) {
      return getH5ServerStatus()
    }
    await stopH5Server()
  }

  startH5ChatBridge()
  startImBridge()
  wss = new WebSocketServer({ noServer: true })
  server = http.createServer((req, res) => {
    void handleRequest(req, res)
  })
  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head))

  return new Promise<H5ServerStatus>((resolve, reject) => {
    server!.once('error', (err) => {
      console.error('[h5Server] listen error:', err)
      reject(err)
    })
    server!.listen(settings.port, settings.host, () => {
      const addr = server!.address()
      currentHost = settings.host
      // When `settings.port` is 0 the OS assigns an ephemeral port; read the
      // real one back from the listening socket so status / tests are accurate.
      currentPort = typeof addr === 'object' && addr ? addr.port : settings.port
      console.log(`[h5Server] listening on http://${currentHost}:${currentPort}`)
      resolve(getH5ServerStatus())
    })
  })
}

export async function stopH5Server(): Promise<void> {
  stopH5ChatBridge()
  stopImBridge()
  if (wss) {
    for (const client of wss.clients) {
      try { client.terminate() } catch { /* ignore */ }
    }
    wss.close()
    wss = null
  }
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
  resetH5RateLimit()
  currentHost = ''
  currentPort = 0
}
