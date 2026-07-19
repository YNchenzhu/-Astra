/**
 * IM adapter bridge — speaks the upstream desktop-server protocol so the ported
 * IM adapters (`adapters/wechat`, and the shared `adapters/common`) can connect
 * to this Electron app unmodified.
 *
 * The adapter expects:
 *   - REST `POST /api/sessions {workDir}` → `{sessionId}`
 *   - REST `GET  /api/sessions/:id` → 200 / 404
 *   - REST `GET  /api/sessions/recent-projects` → `{projects:[]}`
 *   - REST `GET  /api/sessions/:id/git-info` → GitInfo
 *   - REST `GET  /api/tasks/lists/:id` → `{tasks:[]}`
 *   - WS   `/ws/:sessionId` carrying `user_message` / `permission_response` /
 *          `stop_generation` / `ping`, and receiving upstream `ServerMessage`s.
 *
 * Here `sessionId` IS the chat `conversationId`. We translate our native
 * `StreamEvent`s into the upstream `ServerMessage` shape the adapter's handler
 * understands (`content_delta`, `permission_request`, `message_complete`, …).
 *
 * Auth: these endpoints are exempt from the H5 token ONLY for loopback clients
 * (the adapter normally runs on the same machine). Non-loopback callers still
 * need the H5 token. Run the adapter locally for the unauthenticated path.
 */
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { WebSocketServer, WebSocket } from 'ws'
import { addStreamTap } from '../ai/streamHandlerRegistry'
import { startH5Chat, cancelH5Chat } from './h5ChatBridge'
import { respondPermissionRequest, respondAskUserQuestion } from '../ai/interactionState'
import { setWorkspacePath } from '../tools/workspaceState'
import { loadSettings } from '../settings/settingsStore'
import { saveConversation, loadConversation } from '../conversation/service'
import { persistImSession, loadImSession } from './imSessionStore'
import {
  buildImContentBlocks,
  parseAskAnswers,
  translateStreamEventToServerMessages,
  type ImAskQuestionItem,
  type ImAttachmentRef,
} from './imProtocol'

export { isLoopbackAddress } from './imProtocol'

interface ImSession {
  sessionId: string
  workDir: string
}

type ImMessage = { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }

/** Soft cap on retained turns per session; the agentic loop compacts long
 *  histories on its own, this just bounds the in-memory map. */
const MAX_HISTORY_MESSAGES = 100

const sessions = new Map<string, ImSession>()
const sockets = new Map<string, Set<WebSocket>>()
/** Full multi-turn transcript per IM session, so each new turn carries context
 *  (upstream keeps this in a persistent CLI session; we rebuild it explicitly). */
const histories = new Map<string, ImMessage[]>()
/** Assistant text accumulated across `text_delta`s for the in-flight turn. */
const pendingAssistant = new Map<string, string>()
/** In-flight AskUserQuestion per session — the next user reply answers it. */
const pendingAsk = new Map<string, { requestId: string; questions: ImAskQuestionItem[] }>()
/** requestId → toolName for in-flight permission prompts (for "always" rules). */
const pendingPermissionTools = new Map<string, Map<string, string>>()
/** Per-session set of tool names the user chose to "always allow" this session. */
const alwaysAllowTools = new Map<string, Set<string>>()
/** Last upstream message type broadcast per session — used to drop a duplicate
 *  trailing `message_complete` (both `message_stop` and `task_terminated` map to
 *  it, but firing it twice is redundant). */
const lastBroadcastType = new Map<string, string>()
let tapDisposer: (() => void) | null = null

/**
 * Ensure an in-memory IM session exists for `sessionId`, rehydrating it (and its
 * conversation history) from disk after a restart so multi-turn context is not
 * lost when the adapter reconnects with a previously-stored session id.
 */
function ensureRehydratedSession(sessionId: string): ImSession | null {
  const live = sessions.get(sessionId)
  if (live) return live
  const stored = loadImSession(sessionId)
  if (!stored) return null
  const session: ImSession = { sessionId, workDir: stored.workDir }
  sessions.set(sessionId, session)
  try {
    // Audit A1: H5 rehydrate must NOT reset the desktop's live `main`
    // todos / objective — that surface belongs to the desktop renderer.
    const data = loadConversation(sessionId, stored.workDir, undefined, {
      restoreMainTodoState: false,
    })
    if (data && Array.isArray(data.messages) && data.messages.length > 0) {
      histories.set(
        sessionId,
        data.messages.map((m) => ({ role: m.role, content: m.content })),
      )
    }
  } catch (err) {
    console.warn('[imBridge] rehydrate history failed:', err)
  }
  return session
}

export function startImBridge(): void {
  if (tapDisposer) return
  tapDisposer = addStreamTap((event) => {
    const cid =
      typeof event?.conversationId === 'string' && event.conversationId.trim()
        ? event.conversationId.trim()
        : 'default'
    // Accumulate the assistant reply into per-session history regardless of
    // socket state (so a brief WS drop mid-turn doesn't lose context). Scoped
    // to IM sessions only — browser/desktop chats also pass through this tap.
    if (sessions.has(cid)) {
      accumulateAssistant(cid, event as unknown as Record<string, unknown> & { type?: string })
      // "Always allow" auto-response: if the user previously chose to always
      // allow this tool in this session, approve the prompt without bothering
      // them again — and do NOT surface it to the IM client.
      const ev = event as unknown as Record<string, unknown> & { type?: string }
      if (ev.type === 'permission_request') {
        const requestId = typeof ev.requestId === 'string' ? ev.requestId : ''
        const toolName = typeof ev.toolName === 'string' ? ev.toolName : ''
        if (requestId && toolName && alwaysAllowTools.get(cid)?.has(toolName)) {
          respondPermissionRequest({ requestId, behavior: 'allow' })
          return
        }
        if (requestId && toolName) {
          let map = pendingPermissionTools.get(cid)
          if (!map) {
            map = new Map()
            pendingPermissionTools.set(cid, map)
          }
          map.set(requestId, toolName)
        }
      } else if (ev.type === 'ask_user_question') {
        const requestId = typeof ev.requestId === 'string' ? ev.requestId : ''
        const questions = Array.isArray(ev.questions) ? (ev.questions as ImAskQuestionItem[]) : []
        if (requestId && questions.length > 0) {
          pendingAsk.set(cid, { requestId, questions })
        }
      }
    }
    if (!sockets.has(cid)) return
    for (const msg of translateStreamEventToServerMessages(event as unknown as Record<string, unknown> & { type?: string })) {
      broadcast(cid, msg)
    }
  })
}

export function stopImBridge(): void {
  tapDisposer?.()
  tapDisposer = null
  sessions.clear()
  sockets.clear()
  histories.clear()
  pendingAssistant.clear()
  pendingAsk.clear()
  pendingPermissionTools.clear()
  alwaysAllowTools.clear()
  lastBroadcastType.clear()
}

function pushHistory(sessionId: string, msg: ImMessage): void {
  const h = histories.get(sessionId) ?? []
  h.push(msg)
  if (h.length > MAX_HISTORY_MESSAGES) h.splice(0, h.length - MAX_HISTORY_MESSAGES)
  histories.set(sessionId, h)
}

function accumulateAssistant(sessionId: string, event: Record<string, unknown> & { type?: string }): void {
  switch (event.type) {
    case 'text_delta':
      if (typeof event.text === 'string' && event.text) {
        pendingAssistant.set(sessionId, (pendingAssistant.get(sessionId) ?? '') + event.text)
      }
      break
    case 'message_stop':
    case 'task_terminated': {
      const text = (pendingAssistant.get(sessionId) ?? '').trim()
      pendingAssistant.delete(sessionId)
      if (text) {
        pushHistory(sessionId, { role: 'assistant', content: text })
        persistSession(sessionId)
      }
      break
    }
    case 'error':
      // Drop the partial assistant text; the user can retry.
      pendingAssistant.delete(sessionId)
      break
  }
}

/** Best-effort persistence so IM conversations show up in the desktop history. */
function persistSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  const h = histories.get(sessionId)
  if (!session || !h || h.length === 0) return
  try {
    saveConversation({
      id: sessionId,
      workspacePath: session.workDir,
      messages: h.map((m, i) => ({
        id: `${sessionId}-${i}`,
        role: m.role,
        content: typeof m.content === 'string' ? m.content : extractText(m.content),
        timestamp: Date.now(),
      })),
    })
  } catch (err) {
    console.warn('[imBridge] persistSession failed:', err)
  }
}

function extractText(blocks: Array<Record<string, unknown>>): string {
  const parts = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
  return parts.join('\n') || '[多模态消息]'
}

function broadcast(sessionId: string, msg: Record<string, unknown>): void {
  // Drop a back-to-back duplicate `message_complete` (message_stop +
  // task_terminated both translate to it). Keeping the first still stops the
  // adapter's typing indicator; abort-only paths (where only task_terminated
  // fires) still get exactly one.
  const type = typeof msg.type === 'string' ? msg.type : ''
  if (type === 'message_complete' && lastBroadcastType.get(sessionId) === 'message_complete') {
    return
  }
  if (type) lastBroadcastType.set(sessionId, type)

  const set = sockets.get(sessionId)
  if (!set) return
  const payload = JSON.stringify(msg)
  for (const ws of set) {
    if (ws.readyState === 1) {
      try { ws.send(payload) } catch { /* ignore */ }
    }
  }
}

// ── REST ───────────────────────────────────────────────────────────
/** Returns true when the path is an IM-bridge REST endpoint. */
export function isImRestPath(pathname: string): boolean {
  return (
    pathname === '/api/sessions' ||
    pathname.startsWith('/api/sessions/') ||
    pathname.startsWith('/api/tasks/lists/')
  )
}

export async function handleImRest(
  method: string,
  pathname: string,
  req: http.IncomingMessage,
  send: (status: number, body: unknown) => void,
  parseBody: <T>() => Promise<T>,
): Promise<boolean> {
  if (method === 'POST' && pathname === '/api/sessions') {
    const body = await parseBody<{ workDir?: string }>()
    const workDir = (body.workDir || '').trim()
    if (!workDir) {
      send(400, { message: 'workDir required' })
      return true
    }
    const sessionId = randomUUID()
    sessions.set(sessionId, { sessionId, workDir })
    persistImSession(sessionId, workDir)
    try { setWorkspacePath(workDir) } catch { /* best effort */ }
    send(200, { sessionId })
    return true
  }

  if (method === 'GET' && pathname === '/api/sessions/recent-projects') {
    send(200, { projects: [] })
    return true
  }

  const gitMatch = /^\/api\/sessions\/([^/]+)\/git-info$/.exec(pathname)
  if (method === 'GET' && gitMatch) {
    const session = sessions.get(decodeURIComponent(gitMatch[1]))
    send(200, {
      branch: null,
      repoName: null,
      workDir: session?.workDir ?? '',
      changedFiles: 0,
    })
    return true
  }

  const taskMatch = /^\/api\/tasks\/lists\/([^/]+)$/.exec(pathname)
  if (method === 'GET' && taskMatch) {
    send(200, { tasks: [] })
    return true
  }

  const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname)
  if (method === 'GET' && sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1])
    // Rehydrate from disk so a session created before a desktop restart is still
    // reported as existing — the adapter then reuses it (and we restore its
    // history) instead of starting a fresh, context-less session.
    const exists = ensureRehydratedSession(id) !== null
    if (!exists) {
      send(404, { message: 'not found' })
      return true
    }
    send(200, { sessionId: id })
    return true
  }

  return false
}

// ── WebSocket ──────────────────────────────────────────────────────
/** `/ws/:sessionId` (note: the bare `/ws` path is the H5 browser channel). */
export function isImWsPath(pathname: string): boolean {
  return /^\/ws\/[^/]+$/.test(pathname)
}

export function handleImUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
  pathname: string,
): void {
  const sessionId = decodeURIComponent(pathname.slice('/ws/'.length))
  // Restore a persisted session (+ history) if the adapter reconnects after a
  // desktop restart so the conversation keeps its multi-turn context.
  ensureRehydratedSession(sessionId)
  wss.handleUpgrade(req, socket, head, (ws) => {
    let set = sockets.get(sessionId)
    if (!set) {
      set = new Set()
      sockets.set(sessionId, set)
    }
    set.add(ws)

    ws.on('message', (data) => {
      void handleImWsMessage(sessionId, ws, data)
    })
    ws.on('close', () => {
      const s = sockets.get(sessionId)
      s?.delete(ws)
      if (s && s.size === 0) sockets.delete(sessionId)
    })
    ws.on('error', () => {
      const s = sockets.get(sessionId)
      s?.delete(ws)
    })
    try { ws.send(JSON.stringify({ type: 'connected', sessionId })) } catch { /* ignore */ }
  })
}

async function handleImWsMessage(sessionId: string, ws: WebSocket, data: unknown): Promise<void> {
  let msg: Record<string, unknown>
  try {
    const text = typeof data === 'string' ? data : data instanceof Buffer ? data.toString('utf8') : ''
    if (!text) return
    msg = JSON.parse(text) as Record<string, unknown>
  } catch {
    return
  }

  switch (msg.type) {
    case 'ping':
      try { ws.send(JSON.stringify({ type: 'pong' })) } catch { /* ignore */ }
      return
    case 'user_message': {
      const session = ensureRehydratedSession(sessionId)
      const content = typeof msg.content === 'string' ? msg.content : ''

      // If an AskUserQuestion is pending for this session, the reply answers it
      // (routing it into respondAskUserQuestion) instead of starting a new turn.
      const ask = pendingAsk.get(sessionId)
      if (ask && content.trim()) {
        pendingAsk.delete(sessionId)
        const answers = parseAskAnswers(ask.questions, content)
        const ok = await respondAskUserQuestion({
          requestId: ask.requestId,
          answers,
          conversationId: sessionId,
        })
        if (!ok) {
          broadcast(sessionId, { type: 'error', message: '回答已超时或会话已结束，请重新发起。' })
        } else {
          // The agent resumes; show the typing indicator again until it streams.
          broadcast(sessionId, { type: 'status', state: 'thinking' })
        }
        return
      }

      const attachments = Array.isArray(msg.attachments) ? (msg.attachments as ImAttachmentRef[]) : []
      const contentBlocks = buildImContentBlocks(content, attachments)
      // Append to the session transcript so the model sees prior turns.
      pushHistory(sessionId, { role: 'user', content: contentBlocks })

      // Surface the active model so the adapter's /status can report it.
      try {
        const model = (loadSettings().model as string) || ''
        if (model) broadcast(sessionId, { type: 'system_notification', subtype: 'init', data: { model } })
      } catch { /* best effort */ }

      // Synthetic "thinking" status so the IM client shows a typing indicator
      // immediately — even for a text-only reply that emits no tool events.
      // The adapter stops typing on the eventual `message_complete` / `error`.
      broadcast(sessionId, { type: 'status', state: 'thinking' })
      try {
        await startH5Chat({
          conversationId: sessionId,
          messages: histories.get(sessionId) ?? [{ role: 'user', content: contentBlocks }],
          workspacePath: session?.workDir,
          enableTools: true,
        })
      } catch (err) {
        broadcast(sessionId, { type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
      return
    }
    case 'permission_response': {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : ''
      if (!requestId) return
      const allowed = Boolean(msg.allowed)
      // "always" → remember the tool for this session so future prompts for the
      // same tool are auto-approved by the stream tap (the desktop permission
      // engine has no per-IM persistent rule, so we scope it to the session).
      if (allowed && msg.rule === 'always') {
        const toolName = pendingPermissionTools.get(sessionId)?.get(requestId)
        if (toolName) {
          let set = alwaysAllowTools.get(sessionId)
          if (!set) {
            set = new Set()
            alwaysAllowTools.set(sessionId, set)
          }
          set.add(toolName)
        }
      }
      pendingPermissionTools.get(sessionId)?.delete(requestId)
      respondPermissionRequest({
        requestId,
        behavior: allowed ? 'allow' : 'deny',
      })
      return
    }
    case 'stop_generation':
      cancelH5Chat(sessionId)
      return
    default:
      return
  }
}
