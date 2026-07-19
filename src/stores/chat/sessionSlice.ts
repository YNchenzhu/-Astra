import type { ChatMessage } from '../../types'
import type { ChatSessionSlice, ChatState } from './types'

/**
 * Assistant row id for the in-flight main turn, keyed by conversation.
 *
 * Background sub-agents emit `subagent_*` on `ai:stream-event` after the main
 * turn sends `message_stop`, so we keep this Map alive per-conversation and
 * tear it down on cancel / conversation delete.
 */
export const pendingAssistantByConversation = new Map<string, string>()

export function blankSessionSlice(): ChatSessionSlice {
  return {
    messages: [],
    todos: [],
    isTyping: false,
    pendingPermissionRequest: null,
    pendingAskUserQuestion: null,
    pendingTeamPlanApproval: null,
    pendingPlanApproval: null,
    latestTerminationReason: null,
    // Bug C fix — orchestration telemetry per-session defaults. Mirrors the
    // top-level defaults in `orchestrationSlice.ts`; without these, switching
    // back to a freshly-created conversation would leak the previous tab's
    // values from the top-level (which is read by UI components directly).
    orchestrationPhase: null,
    orchestrationIteration: 0,
    orchestrationInnerIteration: 0,
    orchestrationPaused: false,
    permissionDenials: [],
    artifactManifests: [],
    checkpointList: [],
    hitlPaused: null,
  }
}

/**
 * Reads the session slice for `convId`. When `convId` is the currently-visible
 * conversation, returns a live snapshot built from the top-level fields;
 * otherwise returns a copy of the stored buffer (or a blank slice).
 */
export function readSlice(s: ChatState, convId: string): ChatSessionSlice {
  if (s.currentConversationId === convId) {
    return {
      messages: s.messages,
      todos: s.todos,
      isTyping: s.isTyping,
      pendingPermissionRequest: s.pendingPermissionRequest,
      pendingAskUserQuestion: s.pendingAskUserQuestion,
      pendingTeamPlanApproval: s.pendingTeamPlanApproval,
      pendingPlanApproval: s.pendingPlanApproval,
      latestTerminationReason: s.latestTerminationReason ?? null,
      // Bug C fix — orchestration mirror. The dispatcher in `mainStreamRouter`
      // already keeps the top-level fields in sync for the active conversation
      // (via the `apply(fn, extra)` second arg), so reading from top-level
      // here is correct. Background conversations build their slice from the
      // buffer branch below.
      orchestrationPhase: s.orchestrationPhase ?? null,
      orchestrationIteration: s.orchestrationIteration ?? 0,
      orchestrationInnerIteration: s.orchestrationInnerIteration ?? 0,
      orchestrationPaused: s.orchestrationPaused ?? false,
      permissionDenials: s.permissionDenials ?? [],
      artifactManifests: s.artifactManifests ?? [],
      checkpointList: s.checkpointList ?? [],
      hitlPaused: s.hitlPaused ?? null,
      // Audit R2 (2026-07) — must round-trip with `patchConversationSlice`'s
      // kernelDiagnostics mirror, otherwise any active-conversation apply()
      // would rebuild the slice without diagnostics and wipe the top-level.
      kernelDiagnostics: s.kernelDiagnostics ?? [],
    }
  }
  const b = s.sessionBuffers[convId]
  // Forward-compat: older buffers (pre-P0-2) may not have the new slot —
  // fill it in with `null` so the type narrows correctly without us
  // having to migrate every persisted buffer site explicitly. Spread
  // FIRST so any actual buffer value wins over the default.
  if (b) {
    const fallback: Pick<
      ChatSessionSlice,
      'pendingTeamPlanApproval' | 'pendingPlanApproval'
    > = {
      pendingTeamPlanApproval: null,
      pendingPlanApproval: null,
    }
    return { ...fallback, ...b }
  }
  return blankSessionSlice()
}

/**
 * Sorted, comma-joined string of conversation ids with active streams.
 * Returns a primitive so Zustand shallow-compare doesn't cause re-render loops.
 * Consumers should split on ',' to get the id array / set.
 */
export function getActiveStreamIdsKey(s: ChatState): string {
  const ids: string[] = []
  if (s.currentConversationId && s.isTyping) {
    ids.push(s.currentConversationId)
  }
  for (const [id, buf] of Object.entries(s.sessionBuffers)) {
    if (buf.isTyping && !ids.includes(id)) ids.push(id)
  }
  ids.sort()
  return ids.join(',')
}

/** How many background (non-current) sessions are actively streaming. */
export function countBackgroundActiveStreams(s: ChatState): number {
  let count = 0
  for (const [id, buf] of Object.entries(s.sessionBuffers)) {
    if (buf.isTyping && id !== s.currentConversationId) count++
  }
  return count
}

export function commitSlice(
  set: (fn: (prev: ChatState) => Partial<ChatState>) => void,
  convId: string,
  slice: ChatSessionSlice,
  extra?: Partial<ChatState>,
): void {
  set((st) => {
    const buffers = { ...st.sessionBuffers, [convId]: slice }
    if (st.currentConversationId !== convId) {
      return { sessionBuffers: buffers, ...extra }
    }
    return {
      sessionBuffers: buffers,
      messages: slice.messages,
      todos: slice.todos,
      isTyping: slice.isTyping,
      pendingPermissionRequest: slice.pendingPermissionRequest,
      pendingAskUserQuestion: slice.pendingAskUserQuestion,
      pendingTeamPlanApproval: slice.pendingTeamPlanApproval,
      pendingPlanApproval: slice.pendingPlanApproval,
      latestTerminationReason: slice.latestTerminationReason ?? null,
      // Bug C fix — propagate orchestration fields to top-level so UI
      // selectors re-render. `extra` (last spread) can still override.
      orchestrationPhase: slice.orchestrationPhase ?? null,
      orchestrationIteration: slice.orchestrationIteration ?? 0,
      orchestrationInnerIteration: slice.orchestrationInnerIteration ?? 0,
      orchestrationPaused: slice.orchestrationPaused ?? false,
      permissionDenials: slice.permissionDenials ?? [],
      artifactManifests: slice.artifactManifests ?? [],
      checkpointList: slice.checkpointList ?? [],
      hitlPaused: slice.hitlPaused ?? null,
      ...extra,
    }
  })
}

/**
 * Mutates the conversation's slice via `updater`, returning a `Partial<ChatState>`
 * suitable for passing to `set((st) => ({...}))`. When `convId` is the current
 * conversation, top-level fields are mirrored so components subscribed to them
 * re-render; otherwise the update only lives in `sessionBuffers`.
 */
export function patchConversationSlice(
  st: ChatState,
  convId: string,
  updater: (sl: ChatSessionSlice) => ChatSessionSlice,
): Partial<ChatState> {
  const sl = readSlice(st, convId)
  const nextSlice = updater(sl)
  const buffers = { ...st.sessionBuffers, [convId]: nextSlice }
  if (st.currentConversationId !== convId) {
    return { sessionBuffers: buffers }
  }
  return {
    sessionBuffers: buffers,
    messages: nextSlice.messages,
    todos: nextSlice.todos,
    isTyping: nextSlice.isTyping,
    pendingPermissionRequest: nextSlice.pendingPermissionRequest,
    pendingAskUserQuestion: nextSlice.pendingAskUserQuestion,
    pendingTeamPlanApproval: nextSlice.pendingTeamPlanApproval,
    pendingPlanApproval: nextSlice.pendingPlanApproval,
    latestTerminationReason: nextSlice.latestTerminationReason ?? null,
    // Bug C fix — keep orchestration mirror in sync after any per-session
    // mutation made via `apply(fn)` so the active conversation's UI re-renders.
    orchestrationPhase: nextSlice.orchestrationPhase ?? null,
    orchestrationIteration: nextSlice.orchestrationIteration ?? 0,
    orchestrationInnerIteration: nextSlice.orchestrationInnerIteration ?? 0,
    orchestrationPaused: nextSlice.orchestrationPaused ?? false,
    permissionDenials: nextSlice.permissionDenials ?? [],
    artifactManifests: nextSlice.artifactManifests ?? [],
    checkpointList: nextSlice.checkpointList ?? [],
    hitlPaused: nextSlice.hitlPaused ?? null,
    // Audit R2 (2026-07) — mirror kernelDiagnostics like the rest of the
    // orchestration state so a slice-side write without an `extra` override
    // still reaches the active-conversation UI.
    kernelDiagnostics: nextSlice.kernelDiagnostics ?? [],
  }
}

/**
 * Persist the visible session into buffers before switching away. Keeps any
 * in-flight stream state so the background tab can continue updating.
 */
export function flushCurrentSessionToBuffers(
  set: (fn: (st: ChatState) => Partial<ChatState>) => void,
  get: () => ChatState,
): void {
  const s = get()
  const id = s.currentConversationId
  if (!id) return
  const slice: ChatSessionSlice = {
    messages: s.messages,
    todos: s.todos,
    isTyping: s.isTyping,
    pendingPermissionRequest: s.pendingPermissionRequest,
    pendingAskUserQuestion: s.pendingAskUserQuestion,
    pendingTeamPlanApproval: s.pendingTeamPlanApproval,
    pendingPlanApproval: s.pendingPlanApproval,
    latestTerminationReason: s.latestTerminationReason ?? null,
  }
  set((st) => ({
    sessionBuffers: { ...st.sessionBuffers, [id]: slice },
  }))
}

/**
 * Newest assistant row that already lists this sub-agent (for streaming updates).
 *
 * Accepts a plain string because stream events carry the wire-form
 * `agentId: string`; comparison against `SubAgentDisplay.agentId` (branded)
 * works because the brand is only a compile-time marker.
 */
export function findAssistantIndexWithSubAgent(
  messages: ChatMessage[],
  agentId: string,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    if (m.subAgents?.some((sa) => sa.agentId === agentId)) return i
  }
  return -1
}

/** Where to attach a brand-new `subagent_start` (prefer streaming assistant bubble). */
export function findAssistantIndexForNewSubAgent(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'compact_boundary') continue
    if (m.role === 'assistant' && m.isStreaming) return i
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'compact_boundary') continue
    if (m.role === 'assistant') return i
  }
  return -1
}

/**
 * Join streamed sub-agent text chunks.
 *
 * Insert a newline only for Latin/digit run-on (e.g. "ready" + "worker" → two
 * lines). Do NOT split CJK streamed one code unit at a time — the old
 * `[^\s]` rule inserted `\n` between every Han character, and the preview
 * collapsed `\n` to spaces so the UI showed "已 收 到".
 */
export function mergeSubAgentOutputChunk(prev: string, delta: string): string {
  if (!delta) return prev
  if (!prev) return delta
  const prevAscii = /[a-zA-Z0-9]$/.test(prev)
  const nextAscii = /^[a-zA-Z0-9]/.test(delta)
  const sep = prevAscii && nextAscii ? '\n' : ''
  return prev + sep + delta
}
