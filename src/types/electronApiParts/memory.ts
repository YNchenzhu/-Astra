import type { MemoryEntryDisplay } from '../tool'
import type { RecalledMemoryCompact } from '../agentModels'

export interface ElectronMemoryApi {
  list: () => Promise<MemoryEntryDisplay[]>
  get: (filename: string) => Promise<MemoryEntryDisplay | null>
  create: (params: { name: string; description: string; type: string; content: string; scope?: string }) => Promise<MemoryEntryDisplay>
  update: (params: { filename: string; name?: string; description?: string; type?: string; content?: string; scope?: string; enabled?: boolean }) => Promise<MemoryEntryDisplay | null>
  delete: (filename: string) => Promise<{ success: boolean }>
  setWorkspace: (path: string | null) => Promise<{ success: boolean }>
  recallForPrompt: (userMessage: string) => Promise<string>
  recallForPromptAi?: (
    payload:
      | unknown
      | { userMessage: unknown; alreadySurfaced?: string[] },
  ) => Promise<string>
  scanMemdir: () => Promise<MemoryEntryDisplay[]>
  teamSync: () => Promise<{
    exported: number
    imported: number
    teamDir: string
    blockedSecrets: Array<{ filename: string; reason: string }>
  }>
  lastRecalled: () => Promise<RecalledMemoryCompact[]>
  toggleEnabled: (params: { filename: string; enabled: boolean }) => Promise<MemoryEntryDisplay | null>
  getSystemPromptSection?: (autoMemoryEnabled: boolean) => Promise<string>
  validateDirectory?: (dir: string) => Promise<{ valid: boolean; reason?: string }>
  resetRecallState?: () => Promise<{ success: boolean }>
  drainExtractions?: () => Promise<{ success: boolean }>
}
