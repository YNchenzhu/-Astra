/**
 * IPC stream coalescer and large-delta pacer.
 *
 * Small token deltas are coalesced into one frame-sized IPC update. Large
 * upstream deltas are split across animation-frame-sized timer ticks so a
 * gateway that buffers output does not make the renderer jump by a whole
 * paragraph. Events are kept in FIFO order; a completion or tool event waits
 * behind any paced delta that preceded it.
 */

type AnyEvent = Record<string, unknown>

const DELTA_TYPES = new Set([
  'text_delta',
  'subagent_text',
  'thinking_delta',
  'subagent_thinking_delta',
  'reasoning_summary_delta',
  'subagent_reasoning_summary_delta',
])

const DEFAULT_COALESCE_MS = 16
const DEFAULT_PACE_CHARS = 48
const MAX_BOUNDARY_DRAIN_FRAMES = 12

function readClampedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function readCoalesceMs(): number {
  return readClampedInteger(process.env.POLE_STREAM_COALESCE_MS, DEFAULT_COALESCE_MS, 0, 200)
}

function readPaceChars(): number {
  return readClampedInteger(process.env.POLE_STREAM_PACE_CHARS, DEFAULT_PACE_CHARS, 8, 4096)
}

let coalesceWindowMs = readCoalesceMs()
let paceChars = readPaceChars()

interface QueuedEvent {
  event: AnyEvent
  remainingText: string | null
}

interface StreamBuffer {
  queue: QueuedEvent[]
  timer: NodeJS.Timeout | null
  boundaryPaceChars: number | null
  latestSendFn: (event: AnyEvent) => void
}

const buffers = new Map<string, StreamBuffer>()

function streamKey(event: AnyEvent): string {
  const conversationId =
    typeof event.conversationId === 'string' ? event.conversationId : ''
  const agentId = typeof event.agentId === 'string' ? event.agentId : 'main'
  return `${conversationId}|${agentId}`
}

function isDeltaEvent(event: AnyEvent): boolean {
  return typeof event.type === 'string' && DELTA_TYPES.has(event.type)
}

function remainingDeltaChars(buffer: StreamBuffer): number {
  let total = 0
  for (const item of buffer.queue) {
    if (item.remainingText !== null) total += item.remainingText.length
  }
  return total
}

function hasQueuedBoundary(buffer: StreamBuffer): boolean {
  return buffer.queue.some((item) => item.remainingText === null)
}

function takePrefix(text: string, maxChars: number): [prefix: string, rest: string] {
  if (text.length <= maxChars) return [text, '']
  let end = Math.max(1, maxChars)
  const lastCodeUnit = text.charCodeAt(end - 1)
  const nextCodeUnit = text.charCodeAt(end)
  if (
    lastCodeUnit >= 0xd800 &&
    lastCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  ) {
    end += 1
  }
  return [text.slice(0, end), text.slice(end)]
}

function clearBufferTimer(buffer: StreamBuffer): void {
  if (!buffer.timer) return
  clearTimeout(buffer.timer)
  buffer.timer = null
}

function scheduleBuffer(key: string, buffer: StreamBuffer): void {
  if (buffer.timer || coalesceWindowMs === 0) return
  buffer.timer = setTimeout(() => {
    const current = buffers.get(key)
    if (!current) return
    current.timer = null
    flushOneTick(key, current)
  }, coalesceWindowMs)
}

function flushOneTick(key: string, buffer: StreamBuffer): void {
  let budget = buffer.boundaryPaceChars ?? paceChars

  while (buffer.queue.length > 0) {
    const head = buffer.queue[0]
    if (head.remainingText === null) {
      buffer.latestSendFn(head.event)
      buffer.queue.shift()
      continue
    }

    if (budget <= 0) break
    const [text, rest] = takePrefix(head.remainingText, budget)
    buffer.latestSendFn({ ...head.event, text })
    budget = Math.max(0, budget - text.length)
    if (rest.length === 0) {
      buffer.queue.shift()
      continue
    }
    head.remainingText = rest
    break
  }

  if (buffer.queue.length === 0) {
    buffers.delete(key)
    return
  }
  if (!hasQueuedBoundary(buffer)) buffer.boundaryPaceChars = null
  scheduleBuffer(key, buffer)
}

function flushBufferImmediately(buffer: StreamBuffer): void {
  clearBufferTimer(buffer)
  while (buffer.queue.length > 0) {
    const item = buffer.queue.shift()!
    if (item.remainingText === null) {
      buffer.latestSendFn(item.event)
    } else if (item.remainingText.length > 0) {
      buffer.latestSendFn({ ...item.event, text: item.remainingText })
    }
  }
}

function appendDelta(buffer: StreamBuffer, event: AnyEvent): void {
  const text = typeof event.text === 'string' ? event.text : ''
  if (!text) return
  for (let index = buffer.queue.length - 1; index >= 0; index--) {
    const queued = buffer.queue[index]
    if (queued.remainingText === null) break
    if (queued.event.type === event.type) {
      queued.event = event
      queued.remainingText += text
      return
    }
  }
  buffer.queue.push({ event, remainingText: text })
}

export function coalesceForIpc(
  event: AnyEvent,
  sendFn: (event: AnyEvent) => void,
): void {
  if (coalesceWindowMs === 0) {
    sendFn(event)
    return
  }

  const key = streamKey(event)
  const isDelta = isDeltaEvent(event)
  let buffer = buffers.get(key)

  if (!buffer && !isDelta) {
    sendFn(event)
    return
  }

  if (!buffer) {
    buffer = { queue: [], timer: null, boundaryPaceChars: null, latestSendFn: sendFn }
    buffers.set(key, buffer)
  } else {
    buffer.latestSendFn = sendFn
  }

  if (isDelta) {
    appendDelta(buffer, event)
    if (buffer.queue.length === 0) {
      buffers.delete(key)
      return
    }
    scheduleBuffer(key, buffer)
    return
  }

  buffer.queue.push({ event, remainingText: null })
  const pendingChars = remainingDeltaChars(buffer)
  if (pendingChars <= paceChars) {
    flushBufferImmediately(buffer)
    buffers.delete(key)
    return
  }
  buffer.boundaryPaceChars = Math.max(
    buffer.boundaryPaceChars ?? paceChars,
    Math.ceil(pendingChars / MAX_BOUNDARY_DRAIN_FRAMES),
  )
  scheduleBuffer(key, buffer)
}

export function flushAllStreamCoalescerBuffers(): void {
  for (const buffer of buffers.values()) flushBufferImmediately(buffer)
  buffers.clear()
}

export function __resetStreamCoalescerForTests(): void {
  for (const buffer of buffers.values()) clearBufferTimer(buffer)
  buffers.clear()
  coalesceWindowMs = readCoalesceMs()
  paceChars = readPaceChars()
}

export function __getCoalesceWindowMsForTests(): number {
  return coalesceWindowMs
}

export function __getStreamPaceCharsForTests(): number {
  return paceChars
}
