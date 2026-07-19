/**
 * Active plan store — tracks the currently persisted plan file so the UI can
 * offer a persistent "查看计划" re-entry after the approval bar is gone.
 *
 * Fed by `plan:active` / `plan:updated` stream events in
 * `src/services/planTab.ts`. The slim approval bar only exists while a plan
 * is pending; once approved it disappears, so without this the user had no
 * way to reopen the live plan tab during implementation.
 */
import { create } from 'zustand'

interface ActivePlanState {
  /** Absolute path of the persisted plan file, or null when none is active. */
  planFilePath: string | null
  /** Last known full content (used as a fallback if a fresh disk read fails). */
  content: string
  setActive: (planFilePath: string, content: string) => void
  updateContent: (content: string) => void
  clear: () => void
}

export const useActivePlanStore = create<ActivePlanState>()((set) => ({
  planFilePath: null,
  content: '',
  setActive: (planFilePath, content) => set({ planFilePath, content }),
  updateContent: (content) => set({ content }),
  clear: () => set({ planFilePath: null, content: '' }),
}))
