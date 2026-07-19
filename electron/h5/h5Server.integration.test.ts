/**
 * Integration test for the H5 server + IM bridge.
 *
 * Spins up the real `http` + `ws` server (`startH5Server`) on an ephemeral
 * loopback port and drives it with a real `ws` client and `fetch`. The heavy
 * Electron-coupled leaf modules (settings store, agentic chat bridge,
 * conversation persistence, interaction state, the renderer stream registry)
 * are mocked so the test exercises ONLY the server's routing / auth / protocol
 * translation — no Electron `app` is imported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import WebSocket from 'ws'

/** Mirror of `h5Settings.hashH5Token` (sha256 hex). Inlined so the test does
 *  not import the mocked `h5Settings` module. */
function hashH5Token(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

// ── Mutable mock state (hoisted so vi.mock factories can read it) ──────────
const H = vi.hoisted(() => {
  return {
    settings: {
      enabled: true,
      tokenHash: '' as string,
      tokenPreview: 'tok…01',
      allowedOrigins: ['https://cc.example.com'] as string[],
      publicBaseUrl: null as string | null,
      host: '127.0.0.1',
      port: 0,
    },
    token: 'secret-token',
    wechatBound: false,
    streamTap: null as null | ((e: Record<string, unknown>) => void),
    startH5Chat: vi.fn(async () => {}),
    cancelH5Chat: vi.fn(),
    respondPermissionRequest: vi.fn(() => true),
    respondAskUserQuestion: vi.fn(async () => true),
    setWorkspacePath: vi.fn(),
    saveConversation: vi.fn(() => ({ id: 'c1', title: 't' })),
    listConversations: vi.fn(() => [{ id: 'c1', title: 't' }]),
    loadConversation: vi.fn(() => ({ meta: { id: 'c1' }, messages: [] })),
    deleteConversation: vi.fn(() => true),
    renameConversation: vi.fn(() => true),
  }
})

vi.mock('./h5Settings', () => ({
  loadH5Settings: () => H.settings,
  verifyH5Token: (t: string | null | undefined) =>
    Boolean(t) && hashH5Token(t as string) === H.settings.tokenHash,
}))

vi.mock('../ai/streamHandlerRegistry', () => ({
  addStreamTap: (cb: (e: Record<string, unknown>) => void) => {
    H.streamTap = cb
    return () => {
      H.streamTap = null
    }
  },
}))

vi.mock('./h5ChatBridge', () => ({
  startH5Chat: (...args: unknown[]) => H.startH5Chat(...(args as [])),
  cancelH5Chat: (...args: unknown[]) => H.cancelH5Chat(...(args as [])),
  startH5ChatBridge: vi.fn(),
  stopH5ChatBridge: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}))

vi.mock('../ai/interactionState', () => ({
  respondPermissionRequest: (...a: unknown[]) => H.respondPermissionRequest(...(a as [])),
  respondAskUserQuestion: (...a: unknown[]) => H.respondAskUserQuestion(...(a as [])),
}))

vi.mock('../tools/workspaceState', () => ({
  setWorkspacePath: (...a: unknown[]) => H.setWorkspacePath(...(a as [])),
}))

vi.mock('../conversation/service', () => ({
  saveConversation: (...a: unknown[]) => H.saveConversation(...(a as [])),
  listConversations: (...a: unknown[]) => H.listConversations(...(a as [])),
  loadConversation: (...a: unknown[]) => H.loadConversation(...(a as [])),
  deleteConversation: (...a: unknown[]) => H.deleteConversation(...(a as [])),
  renameConversation: (...a: unknown[]) => H.renameConversation(...(a as [])),
}))

vi.mock('../settings/settingsStore', () => ({
  loadSettings: () => ({ model: 'test-model' }),
}))

// Avoid touching the real ~/.claude IM-session store during the test.
vi.mock('./imSessionStore', () => ({
  persistImSession: vi.fn(),
  loadImSession: vi.fn(() => null),
  deleteImSession: vi.fn(),
}))

vi.mock('./imConfig', () => ({
  // Controls `shouldRunServer` when H5 browser access is disabled.
  loadImConfig: () => ({
    wechat: { hasBotToken: H.wechatBound, accountId: H.wechatBound ? 'acc' : '' },
  }),
}))

// Imported AFTER the mocks are declared (vi.mock is hoisted above imports).
import { startH5Server, stopH5Server, getH5ServerStatus } from './h5Server'

let base = ''

interface TestClient {
  ws: WebSocket
  msgs: Array<Record<string, unknown>>
}

/** Open a ws client that buffers EVERY received frame from the moment of
 *  connection, so polling `waitFor` is race-free even if the server sends a
 *  message before a per-call listener could attach. */
function openClient(path: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${getH5ServerStatus().port}${path}`)
    const msgs: Array<Record<string, unknown>> = []
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        msgs.push(JSON.parse(raw.toString()) as Record<string, unknown>)
      } catch {
        /* ignore */
      }
    })
    ws.once('open', () => resolve({ ws, msgs }))
    ws.once('error', reject)
  })
}

async function waitFor(
  client: TestClient,
  predicate: (m: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = client.msgs.find(predicate)
    if (found) return found
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('timeout waiting for ws message')
}

beforeEach(async () => {
  H.settings.enabled = true
  H.settings.port = 0
  H.settings.allowedOrigins = ['https://cc.example.com']
  H.settings.tokenHash = hashH5Token(H.token)
  H.streamTap = null
  vi.clearAllMocks()
  await startH5Server()
  base = `http://127.0.0.1:${getH5ServerStatus().port}`
})

afterEach(async () => {
  await stopH5Server()
})

describe('h5Server REST auth branches', () => {
  it('serves /health unauthenticated with the enabled flag', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, enabled: true })
  })

  it('rejects a protected route without a token (401)', async () => {
    const res = await fetch(`${base}/api/ping`)
    expect(res.status).toBe(401)
  })

  it('accepts a protected route with the correct bearer token', async () => {
    const res = await fetch(`${base}/api/ping`, {
      headers: { Authorization: `Bearer ${H.token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('blocks a disallowed Origin with 403 even with a valid token', async () => {
    const res = await fetch(`${base}/api/ping`, {
      headers: { Authorization: `Bearer ${H.token}`, Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
  })

  it('echoes CORS headers for an allow-listed Origin', async () => {
    const res = await fetch(`${base}/api/ping`, {
      headers: { Authorization: `Bearer ${H.token}`, Origin: 'https://cc.example.com' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://cc.example.com')
  })

  it('returns 503 for protected routes when H5 is disabled at request time', async () => {
    // The listening socket reads `enabled` live per request, so flipping the
    // flag while the server is up exercises the disabled-access branch.
    H.settings.enabled = false
    try {
      const res = await fetch(`${base}/api/ping`, { headers: { Authorization: `Bearer ${H.token}` } })
      expect(res.status).toBe(503)
    } finally {
      H.settings.enabled = true
    }
  })

  it('lists conversations through the authed REST surface', async () => {
    const res = await fetch(`${base}/api/conversations?workspacePath=${encodeURIComponent('/ws')}`, {
      headers: { Authorization: `Bearer ${H.token}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ conversations: [{ id: 'c1', title: 't' }] })
    expect(H.listConversations).toHaveBeenCalledWith('/ws')
  })
})

describe('imBridge WS send/receive (cc-haha protocol)', () => {
  it('creates a session over REST (loopback token-exempt) and drives a chat turn', async () => {
    // createSession — loopback exempt, so no token needed.
    const createRes = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: '/work/dir' }),
    })
    expect(createRes.status).toBe(200)
    const { sessionId } = (await createRes.json()) as { sessionId: string }
    expect(typeof sessionId).toBe('string')
    expect(H.setWorkspacePath).toHaveBeenCalledWith('/work/dir')

    const client = await openClient(`/ws/${sessionId}`)
    const connected = await waitFor(client, (m) => m.type === 'connected')
    expect(connected).toMatchObject({ type: 'connected', sessionId })

    // Send a user message → bridge starts a chat + emits a synthetic typing status.
    client.ws.send(JSON.stringify({ type: 'user_message', content: 'hello there' }))
    const status = await waitFor(client, (m) => m.type === 'status')
    expect(status).toMatchObject({ type: 'status', state: 'thinking' })

    await vi.waitFor(() => expect(H.startH5Chat).toHaveBeenCalledTimes(1))
    const call = (H.startH5Chat.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(call).toMatchObject({ conversationId: sessionId, workspacePath: '/work/dir', enableTools: true })

    // Drive a model stream event through the captured tap → client gets content_delta.
    expect(H.streamTap).toBeTypeOf('function')
    H.streamTap!({ type: 'text_delta', text: 'hi!', conversationId: sessionId })
    const delta = await waitFor(client, (m) => m.type === 'content_delta')
    expect(delta).toEqual({ type: 'content_delta', text: 'hi!' })

    // Completion → message_complete (stops typing on the adapter side).
    H.streamTap!({ type: 'message_stop', conversationId: sessionId })
    const done = await waitFor(client, (m) => m.type === 'message_complete')
    expect(done).toEqual({ type: 'message_complete' })

    client.ws.close()
  })

  it('forwards a permission_response to the interaction state', async () => {
    const createRes = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: '/work/dir' }),
    })
    const { sessionId } = (await createRes.json()) as { sessionId: string }
    const client = await openClient(`/ws/${sessionId}`)
    await waitFor(client, (m) => m.type === 'connected')

    client.ws.send(JSON.stringify({ type: 'permission_response', requestId: 'perm-9', allowed: true }))
    await vi.waitFor(() =>
      expect(H.respondPermissionRequest).toHaveBeenCalledWith({ requestId: 'perm-9', behavior: 'allow' }),
    )

    client.ws.send(JSON.stringify({ type: 'stop_generation' }))
    await vi.waitFor(() => expect(H.cancelH5Chat).toHaveBeenCalledWith(sessionId))

    // ping → pong round-trip.
    client.ws.send(JSON.stringify({ type: 'ping' }))
    const pong = await waitFor(client, (m) => m.type === 'pong')
    expect(pong).toEqual({ type: 'pong' })

    client.ws.close()
  })

  it('serves the IM bridge (loopback) even when H5 browser access is disabled, but gates browser paths', async () => {
    // Simulate: H5 browser off, but a WeChat account is bound → server still runs.
    await stopH5Server()
    H.settings.enabled = false
    H.wechatBound = true
    await startH5Server()
    base = `http://127.0.0.1:${getH5ServerStatus().port}`
    try {
      // IM bridge REST works (loopback, no token) despite H5 being disabled.
      const create = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: '/w' }),
      })
      expect(create.status).toBe(200)
      // Browser surface (e.g. /api/ping) stays gated → 503 when disabled.
      const ping = await fetch(`${base}/api/ping`, { headers: { Authorization: `Bearer ${H.token}` } })
      expect(ping.status).toBe(503)
    } finally {
      H.settings.enabled = true
      H.wechatBound = false
    }
  })

  it('carries multi-turn history and reports the active model', async () => {
    const createRes = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: '/m' }),
    })
    const { sessionId } = (await createRes.json()) as { sessionId: string }
    const client = await openClient(`/ws/${sessionId}`)
    await waitFor(client, (m) => m.type === 'connected')

    // Turn 1.
    client.ws.send(JSON.stringify({ type: 'user_message', content: 'first' }))
    const sysinit = await waitFor(client, (m) => m.type === 'system_notification')
    expect(sysinit).toMatchObject({ subtype: 'init', data: { model: 'test-model' } })
    await vi.waitFor(() => expect(H.startH5Chat).toHaveBeenCalledTimes(1))

    // Simulate the assistant reply for turn 1 via the stream tap.
    H.streamTap!({ type: 'text_delta', text: 'reply-one', conversationId: sessionId })
    H.streamTap!({ type: 'message_stop', conversationId: sessionId })
    await waitFor(client, (m) => m.type === 'message_complete')
    await vi.waitFor(() => expect(H.saveConversation).toHaveBeenCalled())

    // Turn 2 — history must include the user+assistant turn-1 messages.
    client.ws.send(JSON.stringify({ type: 'user_message', content: 'second' }))
    await vi.waitFor(() => expect(H.startH5Chat).toHaveBeenCalledTimes(2))
    const secondCall = (H.startH5Chat.mock.calls[1] as unknown[])[0] as { messages: Array<{ role: string; content: unknown }> }
    expect(secondCall.messages).toHaveLength(3)
    expect(secondCall.messages[0]).toMatchObject({ role: 'user', content: 'first' })
    expect(secondCall.messages[1]).toMatchObject({ role: 'assistant', content: 'reply-one' })
    expect(secondCall.messages[2]).toMatchObject({ role: 'user', content: 'second' })

    client.ws.close()
  })

  it('H1: rejects a loopback IM REST call carrying a remote browser Origin without a token', async () => {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
      body: JSON.stringify({ workDir: '/x' }),
    })
    expect(res.status).toBe(401)
  })

  it('H1: rejects a loopback IM WebSocket carrying a remote Origin without a token', async () => {
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${getH5ServerStatus().port}/ws/sess-x`, {
          headers: { origin: 'https://evil.example.com' },
        })
        ws.once('open', () => {
          ws.close()
          reject(new Error('should not have connected'))
        })
        ws.once('error', () => resolve())
        ws.once('unexpected-response', () => resolve())
      }),
    ).resolves.toBeUndefined()
  })

  it('M2: routes the next reply to a pending AskUserQuestion instead of a new turn', async () => {
    const createRes = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: '/ask' }),
    })
    const { sessionId } = (await createRes.json()) as { sessionId: string }
    const client = await openClient(`/ws/${sessionId}`)
    await waitFor(client, (m) => m.type === 'connected')

    client.ws.send(JSON.stringify({ type: 'user_message', content: 'do it' }))
    await vi.waitFor(() => expect(H.startH5Chat).toHaveBeenCalledTimes(1))

    // Agent asks a question mid-turn.
    H.streamTap!({
      type: 'ask_user_question',
      requestId: 'ask-7',
      questions: [{ header: '环境', options: [{ label: '生产' }, { label: '预发' }] }],
      conversationId: sessionId,
    })
    const prompt = await waitFor(client, (m) => m.type === 'content_delta')
    expect(String(prompt.text)).toContain('环境')

    // The user's reply answers the question; it must NOT start a second chat turn.
    client.ws.send(JSON.stringify({ type: 'user_message', content: '1' }))
    await vi.waitFor(() =>
      expect(H.respondAskUserQuestion).toHaveBeenCalledWith({
        requestId: 'ask-7',
        answers: { 环境: '生产' },
        conversationId: sessionId,
      }),
    )
    expect(H.startH5Chat).toHaveBeenCalledTimes(1)

    client.ws.close()
  })

  it('M3: "always" remembers the tool and auto-approves later prompts silently', async () => {
    const createRes = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: '/perm' }),
    })
    const { sessionId } = (await createRes.json()) as { sessionId: string }
    const client = await openClient(`/ws/${sessionId}`)
    await waitFor(client, (m) => m.type === 'connected')

    // First prompt for tool "Write" is surfaced to the user.
    H.streamTap!({ type: 'permission_request', requestId: 'p1', toolName: 'Write', input: {}, conversationId: sessionId })
    await waitFor(client, (m) => m.type === 'permission_request')

    // User picks "always allow".
    client.ws.send(JSON.stringify({ type: 'permission_response', requestId: 'p1', allowed: true, rule: 'always' }))
    await vi.waitFor(() =>
      expect(H.respondPermissionRequest).toHaveBeenCalledWith({ requestId: 'p1', behavior: 'allow' }),
    )

    const seenBefore = client.msgs.filter((m) => m.type === 'permission_request').length

    // A later prompt for the SAME tool is auto-approved and NOT shown again.
    H.streamTap!({ type: 'permission_request', requestId: 'p2', toolName: 'Write', input: {}, conversationId: sessionId })
    await vi.waitFor(() =>
      expect(H.respondPermissionRequest).toHaveBeenCalledWith({ requestId: 'p2', behavior: 'allow' }),
    )
    await new Promise((r) => setTimeout(r, 60))
    const seenAfter = client.msgs.filter((m) => m.type === 'permission_request').length
    expect(seenAfter).toBe(seenBefore)

    client.ws.close()
  })

  it('does NOT leak stream events to clients of other sessions', async () => {
    const r1 = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: '/a' }),
    })
    const s1 = ((await r1.json()) as { sessionId: string }).sessionId
    const client = await openClient(`/ws/${s1}`)
    await waitFor(client, (m) => m.type === 'connected')

    // Emit an event for a DIFFERENT, unconnected session.
    H.streamTap!({ type: 'text_delta', text: 'other', conversationId: 'some-other-session' })
    await new Promise((r) => setTimeout(r, 100))
    expect(client.msgs.some((m) => m.type === 'content_delta')).toBe(false)

    client.ws.close()
  })
})
