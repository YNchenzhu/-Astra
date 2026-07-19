/**
 * Compaction toast store.
 *
 * Replaces the old behaviour of appending a permanent `compact_boundary`
 * divider into the transcript for every compaction (which stacked up at the
 * bottom and never disappeared). Instead we surface a single TRANSIENT notice:
 *
 *   context_compact_start  → status 'compacting'  ("正在压缩…")
 *   context_compact        → status 'done'        ("已压缩 · 释放 N tokens")
 *                            then auto-dismiss after DONE_LINGER_MS.
 *
 * Only one notice is active at a time. A new compaction while one is showing
 * just resets the same slot, so consecutive thresholds in one turn no longer
 * pile up. A `done` without a preceding `start` (direct-recovery compaction
 * paths) still shows the done state briefly.
 */

import { create } from 'zustand'

export interface CompactionNotice {
  id: string
  status: 'compacting' | 'done'
  level: string
  reclaimedTokens?: number
  /**
   * Conversation the compaction belongs to. The toast component only renders
   * when this matches the active conversation, so switching tabs mid-compaction
   * never shows a stale "compacting" spinner on the wrong conversation.
   */
  conversationId: string
}

/** How long the "done" notice lingers before auto-dismissing. */
const DONE_LINGER_MS = 3500
/**
 * Safety cap on the "compacting" phase — if for some reason the matching
 * `done`/`context_compact` never arrives (errored compaction path), don't
 * leave a spinner stuck forever.
 */
const COMPACTING_TIMEOUT_MS = 60_000

interface CompactionToastStore {
  notice: CompactionNotice | null
  start: (conversationId: string, level: string) => void
  done: (conversationId: string, level: string, reclaimedTokens?: number) => void
  dismiss: () => void
}

let dismissTimer: ReturnType<typeof setTimeout> | null = null

function clearTimer(): void {
  if (dismissTimer) {
    clearTimeout(dismissTimer)
    dismissTimer = null
  }
}

let counter = 0
function nextId(): string {
  counter += 1
  return `compact-toast-${Date.now()}-${counter}`
}

export const useCompactionToastStore = create<CompactionToastStore>((set, get) => ({
  notice: null,

  start: (conversationId, level) => {
    clearTimer()
    const existing = get().notice
    set({
      notice: {
        // Reuse the slot id only when it belongs to the same conversation so a
        // start→done transition is seamless; a different conversation gets a
        // fresh id (and the previous notice is replaced).
        id: existing && existing.conversationId === conversationId ? existing.id : nextId(),
        status: 'compacting',
        level,
        conversationId,
      },
    })
    dismissTimer = setTimeout(() => {
      // Stuck-spinner guard: only clear if we're still in 'compacting'.
      if (useCompactionToastStore.getState().notice?.status === 'compacting') {
        useCompactionToastStore.getState().dismiss()
      }
    }, COMPACTING_TIMEOUT_MS)
  },

  done: (conversationId, level, reclaimedTokens) => {
    clearTimer()
    const existing = get().notice
    set({
      notice: {
        id: existing && existing.conversationId === conversationId ? existing.id : nextId(),
        status: 'done',
        level,
        conversationId,
        ...(typeof reclaimedTokens === 'number' && reclaimedTokens > 0
          ? { reclaimedTokens }
          : {}),
      },
    })
    dismissTimer = setTimeout(() => {
      useCompactionToastStore.getState().dismiss()
    }, DONE_LINGER_MS)
  },

  dismiss: () => {
    clearTimer()
    set({ notice: null })
  },
}))

/** Test-only reset. */
export function __resetCompactionToastForTests(): void {
  clearTimer()
  useCompactionToastStore.setState({ notice: null })
}
