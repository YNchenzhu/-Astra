/**
 * Renderer-side IPC bridge for the memory system.
 */

import type { MemoryEntryDisplay, MemoryType } from '../types'

export type MemoryEntryWithSource = MemoryEntryDisplay & {
  sourcePath?: string
}

export interface BlockedSecretReport {
  filename: string
  reason: string
}

export interface TeamMemorySyncResult {
  exported: number
  imported: number
  teamDir: string
  /**
   * Files the secret guard refused to export to team memory. Present
   * (possibly empty) on every sync result; consumers should surface a
   * warning when the array is non-empty so the user can locate and
   * sanitise the offending source memory file.
   */
  blockedSecrets: BlockedSecretReport[]
}

function getAPI() {
  return typeof window !== 'undefined' && window.electronAPI
    ? window.electronAPI
    : null
}

/**
 * Throw when the preload bridge (`electronAPI` or its `memory` sub-namespace)
 * is missing. Same rationale as `conversationAPI.requireAPI`: the old pattern
 * (`if (!api) return null/false/[]`) conflated "preload broken" with
 * "legitimate empty state", making memory-panel buttons appear dead.
 */
function requireMemoryAPI(origin: string) {
  const api = getAPI()
  if (!api?.memory) {
    throw new Error(
      `${origin}: window.electronAPI.memory is not available (preload bridge missing).`,
    )
  }
  return api
}

export async function listMemories(): Promise<MemoryEntryDisplay[]> {
  const api = requireMemoryAPI('listMemories')
  return api.memory.list()
}

export async function scanMemdir(): Promise<MemoryEntryWithSource[]> {
  const api = requireMemoryAPI('scanMemdir')
  const mem = api.memory as typeof api.memory & {
    scanMemdir?: () => Promise<MemoryEntryWithSource[]>
  }
  if (typeof mem.scanMemdir === 'function') {
    return mem.scanMemdir()
  }
  return listMemories()
}

export async function syncTeamMemory(): Promise<TeamMemorySyncResult> {
  const api = requireMemoryAPI('syncTeamMemory')
  const mem = api.memory as { teamSync?: () => Promise<TeamMemorySyncResult> }
  if (typeof mem.teamSync !== 'function') {
    throw new Error(
      'syncTeamMemory: api.memory.teamSync is not available (preload bridge outdated).',
    )
  }
  return mem.teamSync()
}

export async function getMemory(
  filename: string,
): Promise<MemoryEntryDisplay | null> {
  const api = requireMemoryAPI('getMemory')
  return api.memory.get(filename)
}

export async function createMemory(params: {
  name: string
  description: string
  type: MemoryType
  content: string
  scope?: string
}): Promise<MemoryEntryDisplay> {
  const api = requireMemoryAPI('createMemory')
  return api.memory.create(params)
}

export async function updateMemory(params: {
  filename: string
  name?: string
  description?: string
  type?: MemoryType
  content?: string
  scope?: string
  enabled?: boolean
}): Promise<MemoryEntryDisplay | null> {
  const api = requireMemoryAPI('updateMemory')
  return api.memory.update(params)
}

export async function toggleMemoryEnabled(
  filename: string,
  enabled: boolean,
): Promise<MemoryEntryDisplay | null> {
  const api = requireMemoryAPI('toggleMemoryEnabled')
  const mem = api.memory as {
    toggleEnabled?: (p: { filename: string; enabled: boolean }) => Promise<MemoryEntryDisplay | null>
  }
  if (typeof mem.toggleEnabled !== 'function') {
    throw new Error(
      'toggleMemoryEnabled: api.memory.toggleEnabled is not available (preload bridge outdated).',
    )
  }
  return mem.toggleEnabled({ filename, enabled })
}

/** Matches main-process `getLastRecalledForUi` / IPC `memory:last-recalled`. */
export interface RecalledMemory {
  filename: string
  name: string
  type: string
  matchSnippet: string
}

export async function getLastRecalledMemories(): Promise<RecalledMemory[]> {
  // This one legitimately degrades to `[]` when the optional IPC is missing —
  // it's a passive snapshot, not a user-initiated action — so we keep the
  // old behavior. The UI shows an empty recall list which is accurate.
  const api = getAPI()
  const mem = api?.memory as { lastRecalled?: () => Promise<RecalledMemory[]> }
  if (typeof mem?.lastRecalled === 'function') {
    return mem.lastRecalled()
  }
  return []
}

export async function deleteMemory(filename: string): Promise<boolean> {
  const api = requireMemoryAPI('deleteMemory')
  const result = await api.memory.delete(filename)
  return result.success
}

export async function setMemoryWorkspace(
  path: string | null,
): Promise<void> {
  const api = requireMemoryAPI('setMemoryWorkspace')
  await api.memory.setWorkspace(path)
}

export async function recallForPrompt(
  userMessage: string,
): Promise<string> {
  const api = requireMemoryAPI('recallForPrompt')
  return api.memory.recallForPrompt(userMessage)
}
