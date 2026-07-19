/**
 * Stream handler registry — global stream state, active main stream tracking,
 * and query-loop channel management.
 */

import { setStreamEventSender } from './interactionState'
import { cancelPendingInteractionsForConversation } from './interactionState'
import { createQueryLoopChannel } from './queryLoopAsyncGenerator'
import { coalesceForIpc } from './streamCoalescer'
import type { StreamEvent } from './streamHandlerTypes'

type MainStreamRecord = {
  streamId: string
  conversationId: string
  abortController: AbortController
}

const CANCEL_ALL_MAIN_STREAMS = '__ALL_MAIN_STREAMS__'

const activeMainStreams = new Map<string, MainStreamRecord>()
const activeMainStreamIdsByConversation = new Map<string, Set<string>>()
export const queryLoopChannelsByConversation = new Map<string, ReturnType<typeof createQueryLoopChannel>>()

let streamEventWindow: Electron.BrowserWindow | null = null
let streamEventSenderInitialized = false

/** Mutable reference shared with handleSendMessage for async-iterable bridge wiring. */
export let lastQueryLoopBridge: ReturnType<typeof createQueryLoopChannel> | null = null

export function setLastQueryLoopBridge(v: ReturnType<typeof createQueryLoopChannel> | null): void {
  lastQueryLoopBridge = v
}

// P1-32: throttle the "untagged event" warning so we don't spam stderr if a
// misbehaving emitter loops forever. We only care about *novel* untagged
// event-types, not every replay of the same one.
//
// Capped so a buggy emitter that injects a unique token (timestamp / UUID)
// into every event.type can't grow this Set without bound. When the cap is
// reached we wrap around — at that point we've already warned hundreds of
// times and the operator clearly hasn't fixed it, so falling back to "warn
// every time we forget" is no worse than the runaway-Set status quo.
const WARNED_UNTAGGED_TYPES_MAX = 256
const warnedUntaggedEventTypes = new Set<string>()

/**
 * H5 / remote-access stream taps.
 *
 * Out-of-process consumers (the H5 HTTP/WS server, IM adapter bridges) register
 * a tap to receive every main-chat stream event without disturbing the
 * webContents broadcast or the per-conversation query-loop iterables. Taps see
 * the raw, un-coalesced event so a remote client gets the same fidelity as the
 * in-process renderer. Failures in one tap never block the others or the
 * renderer path.
 */
type StreamTap = (event: StreamEvent) => void
const streamTaps = new Set<StreamTap>()

export function addStreamTap(tap: StreamTap): () => void {
  streamTaps.add(tap)
  return () => {
    streamTaps.delete(tap)
  }
}

function fanoutToStreamTaps(event: StreamEvent): void {
  if (streamTaps.size === 0) return
  for (const tap of streamTaps) {
    try {
      tap(event)
    } catch (err) {
      console.warn('[streamHandlerRegistry] stream tap threw:', err)
    }
  }
}

export function ensureGlobalStreamEventSender(mainWindow: Electron.BrowserWindow): void {
  streamEventWindow = mainWindow
  if (streamEventSenderInitialized) return
  streamEventSenderInitialized = true
  setStreamEventSender((event) => {
    // Remote H5 / adapter taps mirror the in-process renderer broadcast.
    fanoutToStreamTaps(event as unknown as StreamEvent)
    // The query-loop async-iterable bridge is consumed in-process at the
    // consumer's own pace, so it does NOT participate in IPC coalescing —
    // pushing every event keeps `for await` consumers' fidelity intact.
    // Only the `webContents.send` path is gated through the coalescer to
    // smooth UI-side update bursts during multi-agent fan-out.
    const win = streamEventWindow
    if (win && !win.isDestroyed()) {
      coalesceForIpc(event as unknown as Record<string, unknown>, (final) => {
        const w = streamEventWindow
        if (w && !w.isDestroyed()) {
          w.webContents.send('ai:stream-event', final)
        }
      })
    }
    const conv =
      typeof event?.conversationId === 'string' && event.conversationId.trim()
        ? event.conversationId.trim()
        : undefined
    if (conv) {
      queryLoopChannelsByConversation.get(conv)?.push(event as unknown as StreamEvent)
      return
    }
    // P1-32: previously fell through to `lastQueryLoopBridge?.push(...)`. That
    // was the most-recently-registered bridge for ANY conversation, so an
    // untagged event from conversation A could leak into conversation B's
    // iterable consumer once B opened a stream. Dropping the iterable push
    // for untagged events keeps webContents broadcast working (the renderer
    // dispatches by its own current-conversation rules) without
    // misattributing telemetry. Warn once per event-type so the emitter
    // bug surfaces in dev without flooding the logs.
    const t = typeof event?.type === 'string' ? event.type : 'unknown'
    if (!warnedUntaggedEventTypes.has(t)) {
      if (warnedUntaggedEventTypes.size >= WARNED_UNTAGGED_TYPES_MAX) {
        warnedUntaggedEventTypes.clear()
      }
      warnedUntaggedEventTypes.add(t)
      console.warn(
        `[streamHandlerRegistry] dropping untagged stream event from query-loop iterable: type=${t}; ` +
          `emitter must include a conversationId.`,
      )
    }
  })
}

export function registerActiveMainStream(rec: MainStreamRecord): void {
  activeMainStreams.set(rec.streamId, rec)
  const setForConversation =
    activeMainStreamIdsByConversation.get(rec.conversationId) ?? new Set<string>()
  setForConversation.add(rec.streamId)
  activeMainStreamIdsByConversation.set(rec.conversationId, setForConversation)
}

export function unregisterActiveMainStream(streamId: string, conversationId: string): void {
  activeMainStreams.delete(streamId)
  const setForConversation = activeMainStreamIdsByConversation.get(conversationId)
  if (!setForConversation) return
  setForConversation.delete(streamId)
  if (setForConversation.size === 0) {
    activeMainStreamIdsByConversation.delete(conversationId)
  }
}

export function emitStreamEventToRenderer(event: StreamEvent): void {
  // Remote H5 / adapter taps mirror the renderer broadcast. Done before the
  // window guard so remote clients keep streaming even if no desktop window
  // is currently focused/visible.
  fanoutToStreamTaps(event)
  const win = streamEventWindow
  if (!win || win.isDestroyed()) return
  // Per-token text/thinking deltas are coalesced into ≤60Hz IPC bursts
  // so multi-agent fan-out doesn't saturate the main-process event loop.
  // Non-delta events (tool_*, message_stop, errors, …) flush the pending
  // buffer first and are then forwarded immediately, preserving renderer
  // ordering. See `streamCoalescer.ts` for the contract.
  coalesceForIpc(event as unknown as Record<string, unknown>, (final) => {
    const w = streamEventWindow
    if (w && !w.isDestroyed()) {
      w.webContents.send('ai:stream-event', final)
    }
  })
}

/** When `ASTRA_QUERY_LOOP_ASYNC_ITERABLE=1`, mirrors main chat `ai:stream-event` payloads for `for await` consumers (AC-1.4). */
export function getHandleSendMessageQueryLoopIterable(): AsyncIterable<StreamEvent> | null {
  return lastQueryLoopBridge?.iterable ?? null
}

export function cancelStream(conversationId?: string): void {
  if (typeof conversationId === 'string' && conversationId.trim()) {
    const cid = conversationId.trim()
    if (cid === CANCEL_ALL_MAIN_STREAMS) {
      for (const rec of activeMainStreams.values()) {
        rec.abortController.abort()
        cancelPendingInteractionsForConversation(rec.conversationId)
      }
      return
    }
    const ids = activeMainStreamIdsByConversation.get(cid)
    if (!ids || ids.size === 0) return
    for (const streamId of ids) {
      const rec = activeMainStreams.get(streamId)
      if (!rec) continue
      rec.abortController.abort()
      cancelPendingInteractionsForConversation(rec.conversationId)
    }
    return
  }
  if (activeMainStreams.size === 0) return
  for (const rec of activeMainStreams.values()) {
    rec.abortController.abort()
    cancelPendingInteractionsForConversation(rec.conversationId)
  }
}
