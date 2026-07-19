/**
 * Zustand store for memory state.
 */

import { create } from 'zustand'
import type { MemoryType } from '../types'
import * as memoryAPI from '../services/memoryAPI'
import type { MemoryEntryWithSource, TeamMemorySyncResult } from '../services/memoryAPI'
import { reportUserActionError } from '../utils/reportUserActionError'

interface MemoryState {
  memories: MemoryEntryWithSource[]
  isLoading: boolean
  workspacePath: string | null
  lastSyncResult: TeamMemorySyncResult | null

  loadMemories: () => Promise<void>
  createMemory: (
    name: string,
    description: string,
    type: MemoryType,
    content: string,
    scope?: string,
  ) => Promise<void>
  updateMemory: (
    filename: string,
    updates: Partial<
      Pick<MemoryEntryWithSource, 'name' | 'description' | 'type' | 'content'> & { scope?: string }
    >,
  ) => Promise<void>
  toggleEnabled: (filename: string, enabled: boolean) => Promise<void>
  deleteMemory: (filename: string) => Promise<void>
  deleteMemories: (filenames: string[]) => Promise<void>
  setWorkspace: (path: string | null) => Promise<void>
  teamSync: () => Promise<TeamMemorySyncResult>
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  isLoading: false,
  workspacePath: null,
  lastSyncResult: null,

  loadMemories: async () => {
    set({ isLoading: true })
    try {
      const memories = await memoryAPI.scanMemdir()
      set({ memories, isLoading: false })
    } catch (error) {
      // Old code had an empty catch — a broken memory bridge silently showed
      // an empty list. Log silently (no alert) to keep panel open experience
      // smooth; the list will correctly show as empty and DevTools carries
      // the real reason.
      set({ isLoading: false })
      reportUserActionError('加载记忆', error, { silent: true })
    }
  },

  createMemory: async (name, description, type, content, scope) => {
    await memoryAPI.createMemory({
      name,
      description,
      type,
      content,
      scope,
    })
    await get().loadMemories()
  },

  updateMemory: async (filename, updates) => {
    const updated = await memoryAPI.updateMemory({ filename, ...updates })
    if (updated) {
      await get().loadMemories()
    }
  },

  toggleEnabled: async (filename, enabled) => {
    const updated = await memoryAPI.toggleMemoryEnabled(filename, enabled)
    if (updated) {
      await get().loadMemories()
    }
  },

  deleteMemory: async (filename) => {
    const ok = await memoryAPI.deleteMemory(filename)
    if (ok) {
      await get().loadMemories()
    }
  },

  // Batch delete: run every API delete first, then reload the list ONCE.
  // Reloading per-item (calling `deleteMemory` in a loop) flips `isLoading`
  // true→false N times and re-scans the memdir N times, which makes the
  // panel flicker between the list and the "加载记忆中..." placeholder.
  deleteMemories: async (filenames) => {
    if (filenames.length === 0) return
    let anyDeleted = false
    for (const filename of filenames) {
      try {
        const ok = await memoryAPI.deleteMemory(filename)
        if (ok) anyDeleted = true
      } catch (error) {
        reportUserActionError('删除记忆', error, { silent: true })
      }
    }
    if (anyDeleted) {
      await get().loadMemories()
    }
  },

  setWorkspace: async (path) => {
    // IPC is idempotent, so it's still safe when `useWorkspaceStore` is the
    // one driving us — but we no longer assume MemoryPanel is the only
    // caller. The workspace-store push ensures `workspacePath`/`memories`
    // track the active root even when the settings dialog never mounts.
    await memoryAPI.setMemoryWorkspace(path)
    set({ workspacePath: path })
    if (path) {
      await get().loadMemories()
    } else {
      set({ memories: [], lastSyncResult: null })
    }
  },

  teamSync: async () => {
    const result = await memoryAPI.syncTeamMemory()
    set({ lastSyncResult: result })
    await get().loadMemories()
    return result
  },
}))
