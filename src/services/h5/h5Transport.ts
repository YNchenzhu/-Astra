/**
 * H5 browser-mode transport: REST + WebSocket against the desktop H5 server.
 *
 * - REST calls attach `Authorization: Bearer <token>`.
 * - The WebSocket carries the token as a `?token=` query param and subscribes
 *   to one conversation at a time (the active chat). `https://` backends are
 *   correctly upgraded to `wss://` (the H5 design called this out as a common
 *   string-concatenation bug).
 */
import type { StreamEvent } from '../../types'
import type { H5ConnectionInfo } from './h5Connection'

type StreamListener = (event: StreamEvent) => void

export class H5Transport {
  private readonly serverUrl: string
  private readonly token: string
  private ws: WebSocket | null = null
  private currentConversationId = 'default'
  private readonly listeners = new Set<StreamListener>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUser = false

  constructor(info: H5ConnectionInfo) {
    this.serverUrl = info.serverUrl.replace(/\/$/, '')
    this.token = info.token
  }

  private wsBase(): string {
    if (this.serverUrl.startsWith('https://')) return `wss://${this.serverUrl.slice('https://'.length)}`
    if (this.serverUrl.startsWith('http://')) return `ws://${this.serverUrl.slice('http://'.length)}`
    return this.serverUrl
  }

  // ── REST ────────────────────────────────────────────────────────
  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.serverUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
    })
    return this.parse<T>(res)
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.serverUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return this.parse<T>(res)
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text()
    const data = text ? JSON.parse(text) : {}
    if (!res.ok) {
      const message = (data && typeof data === 'object' && 'error' in data ? String(data.error) : '') || `HTTP ${res.status}`
      throw new Error(message)
    }
    return data as T
  }

  // ── WebSocket ───────────────────────────────────────────────────
  onStreamEvent(listener: StreamListener): () => void {
    this.listeners.add(listener)
    this.ensureSocket()
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Point the live socket at a different conversation (sends a control frame). */
  subscribe(conversationId: string): void {
    this.currentConversationId = conversationId || 'default'
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'subscribe', conversationId: this.currentConversationId }))
      } catch {
        /* ignore */
      }
    } else {
      this.ensureSocket()
    }
  }

  private ensureSocket(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    this.closedByUser = false
    const url = `${this.wsBase()}/ws?token=${encodeURIComponent(this.token)}&conversationId=${encodeURIComponent(this.currentConversationId)}`
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = socket
    socket.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as {
          channel?: string
          event?: StreamEvent
        }
        if (parsed.channel === 'ai:stream-event' && parsed.event) {
          for (const l of this.listeners) {
            try { l(parsed.event) } catch { /* ignore */ }
          }
        }
      } catch {
        /* ignore malformed frame */
      }
    }
    socket.onclose = () => {
      this.ws = null
      if (!this.closedByUser) this.scheduleReconnect()
    }
    socket.onerror = () => {
      try { socket.close() } catch { /* ignore */ }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.listeners.size > 0) this.ensureSocket()
    }, 2000)
  }

  dispose(): void {
    this.closedByUser = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    this.listeners.clear()
  }
}
