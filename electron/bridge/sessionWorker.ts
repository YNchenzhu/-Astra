/**
 * Bridge session worker — runs `runAgenticLoopAsync` in an isolated
 * `worker_threads` process so a crashing tool / runaway streaming
 * payload / segfaulting native module can't take down the Electron
 * main process.
 *
 * Lifecycle (matches upstream §7.3 `sessionRunner` semantics):
 *
 *   1. Worker is spawned by {@link sessionSpawner}. As soon as the
 *      `parentPort.on('message')` handler is wired, we send `'ready'`.
 *   2. Parent posts `{ kind: 'init', payload }`. We construct
 *      AgenticLoopParams from the wire payload, send `'started'`,
 *      then drive `runAgenticLoopAsync` to completion.
 *   3. Each `LoopEvent` yielded by the generator becomes a
 *      `{ kind: 'event', event }` postMessage. The final
 *      `AgenticLoopResult` becomes `{ kind: 'done', result }`.
 *   4. Parent may post `{ kind: 'abort' }` at any time; we abort our
 *      internal AbortController which the generator observes and
 *      cleans up via its standard finally-block. Parent may also post
 *      `{ kind: 'update_token' }` to refresh the access token; we
 *      mutate our local `ProviderConfig` clone so the next API call
 *      uses the fresh value.
 *   5. Worker exits cleanly after sending `'done'` or `'fail'`.
 *
 * Tool execution caveat (P1-A boundary): the worker has its own
 * `toolRegistry` (empty by default — main-process initialisation
 * doesn't run inside the worker), so the practical workload here is
 * **text-only LLM dialogue + LoopEvent telemetry**. Full tool
 * execution requires the RPC tool port abstraction described in P1-A's
 * remaining ~30%; that work lands in a follow-up session.
 *
 * The worker module is bundled as a separate vite-plugin-electron
 * entry (`dist-electron/sessionWorker.js`). The spawner resolves the
 * path via `path.join(__dirname, 'sessionWorker.js')` — same convention
 * as `embeddingWorker.js`.
 */

import { parentPort } from 'node:worker_threads'
import {
  createInMemoryAgentLoopHost,
  runHostedAgentLoopAsync,
} from '../orchestration/hostedAgentLoop'
import type { AgenticLoopResult } from '../ai/loopEvents'
import {
  parseParentMessage,
  type ParentMessage,
  type SessionInit,
  type WorkerMessage,
} from './sessionMessages'
import type { AgenticLoopParams } from '../ai/agenticLoopTypes'
import type { ProviderConfig } from '../ai/client'
import { RemoteAgentLoopHostController } from './remoteHostProtocol'

if (!parentPort) {
  // Loud failure — we should NEVER be required outside a Worker context.
  // If this fires it means someone imported `sessionWorker.ts` directly
  // into the main bundle; the sessionSpawner bug below would have leaked
  // a giant chunk of provider SDKs into the main process.
  throw new Error('[sessionWorker] must be loaded as a worker_thread')
}

const port = parentPort

// ────────────────────────────────────────────────────────────────────────
// Lifecycle state
// ────────────────────────────────────────────────────────────────────────

let abortController: AbortController | null = null
let currentSessionId: string | null = null
/**
 * Mutable provider-config clone that {@link AgenticLoopParams.config}
 * points at. We replace `apiKey` in place when the parent posts
 * `update_token`; ProviderConfig stays referentially stable so the
 * agentic loop's internal logic (cache-key building, stream model
 * selection, …) doesn't see a "config changed" signal mid-flight.
 */
let liveConfig: ProviderConfig | null = null

function send(msg: WorkerMessage): void {
  try {
    port.postMessage(msg)
  } catch (err) {
    // postMessage can fail if the parent has already closed the port
    // (e.g. forced terminate). Nothing to surface — just stop the
    // bleeding so the worker doesn't crash on its own logging chain.
    void err
  }
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  send({ kind: 'log', level, message })
}

const remoteHost = new RemoteAgentLoopHostController((message) => send(message))

// ────────────────────────────────────────────────────────────────────────
// Init handler
// ────────────────────────────────────────────────────────────────────────

async function startSession(init: SessionInit): Promise<void> {
  if (currentSessionId) {
    // Re-init isn't supported in P1-A — one worker, one session, one
    // exit. The spawner enforces 1:1 on its side; this is just the
    // worker-side belt-and-braces.
    log('error', `re-init refused: session ${currentSessionId} already running`)
    send({ kind: 'fail', error: 'session already running' })
    return
  }
  currentSessionId = init.sessionId
  abortController = new AbortController()

  liveConfig = {
    ...init.params.config,
    apiKey: init.accessToken ?? init.params.config.apiKey,
  } as ProviderConfig

  // Reconstruct AgenticLoopParams from the wire payload. AbortSignal
  // and any callable fields are local to this worker.
  const params: AgenticLoopParams = {
    config: liveConfig,
    model: init.params.model,
    messages: init.params.messages as AgenticLoopParams['messages'],
    systemPrompt: init.params.systemPrompt,
    maxTokens: init.params.maxTokens,
    maxIterationsOverride: init.params.maxIterationsOverride,
    enableTools: init.params.enableTools ?? false,
    alwaysThinking: init.params.alwaysThinking,
    signal: abortController.signal,
    permissionDefaultMode: init.params.permissionDefaultMode,
    permissionRules: init.params.permissionRules,
  }

  send({ kind: 'started', sessionId: init.sessionId })

  let result: AgenticLoopResult | null = null
  try {
    const host = createInMemoryAgentLoopHost(params, {
      ...(init.initialTranscriptSnapshot
        ? { initialSnapshot: init.initialTranscriptSnapshot }
        : {}),
      onTranscriptCommit: (snapshot) => remoteHost.onTranscriptCommit(snapshot),
      iterationBoundary: (iteration) => remoteHost.iterationBoundary(iteration),
    })
    const gen = runHostedAgentLoopAsync(
      host,
      params,
    )
    while (true) {
      const r = await gen.next()
      if (r.done) {
        // r.value is AgenticLoopResult; capture it for the `done`
        // wire message.
        result = r.value
        break
      }
      send({ kind: 'event', event: r.value })
    }
    await remoteHost.awaitLatestAck()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('error', `loop crashed: ${message}`)
    send({ kind: 'fail', error: message })
    return
  } finally {
    abortController = null
  }

  if (result) {
    send({ kind: 'done', result })
  } else {
    // Defensive — generator should always end with a return value, but
    // if some future refactor forgets, surface the failure cleanly
    // instead of leaving the parent waiting forever.
    send({ kind: 'fail', error: 'loop returned no result' })
  }
}

// ────────────────────────────────────────────────────────────────────────
// Control plane
// ────────────────────────────────────────────────────────────────────────

function handleMessage(raw: unknown): void {
  const parsed = parseParentMessage(raw)
  if (!parsed.ok) {
    log('error', `invalid parent message: ${parsed.error}`)
    return
  }
  const msg: ParentMessage = parsed.value
  switch (msg.kind) {
    case 'init':
      // Async; we don't await — failures are surfaced via send('fail').
      void startSession(msg.payload).catch((err) => {
        log('error', `startSession threw: ${err instanceof Error ? err.message : String(err)}`)
      })
      return
    case 'abort':
      if (abortController) {
        log('info', `abort received${msg.reason ? `: ${msg.reason}` : ''}`)
        abortController.abort()
      }
      return
    case 'update_token':
      if (liveConfig) {
        liveConfig.apiKey = msg.token
        log('debug', 'access token refreshed')
      }
      return
    case 'pause':
    case 'resume':
    case 'transcript_ack':
      remoteHost.handleParentMessage(msg)
      return
    default: {
      const _exhaustive: never = msg
      void _exhaustive
    }
  }
}

port.on('message', handleMessage)
send({ kind: 'ready' })
