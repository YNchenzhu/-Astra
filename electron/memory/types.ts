/**
 * Memory system type definitions.
 * Four-type taxonomy ported from upstream:
 * user, feedback, project, reference
 */

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

export const MEMORY_SCOPES = ['session', 'project', 'user'] as const

export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export interface MemoryFrontmatter {
  name: string
  description: string
  type: MemoryType
  created: string
  updated: string
  scope?: MemoryScope
  enabled?: boolean
  tags?: string[]
  /**
   * Last successful auto-consolidation timestamp (ISO). Used by the incremental dedup pass
   * in {@link consolidateMemories} to skip re-comparing pairs that have both been seen by a
   * recent full sweep.
   */
  consolidatedAt?: string
  /**
   * Length of the content **before** {@link compressContent} truncated it. Absent when the
   * entry has never been compressed. Surfaces in the UI as "compressed from N chars" so the
   * user can decide whether to revisit the source.
   */
  originalLength?: number
  /**
   * SHA-256 of the full pre-compression content. Lets future callers verify whether they have
   * the original by comparing hashes — compression is irreversible (the dropped portion is
   * lost), but integrity of the surviving prefix can still be proven.
   */
  originalHash?: string
  /**
   * SHA-256 of the portion that was discarded during compression (i.e. the suffix beyond the
   * cut point). Allows future tooling to detect when the same dropped content reappears in a
   * newer entry without keeping the bytes around.
   */
  truncatedHash?: string
}

export interface MemoryEntry {
  filename: string
  frontmatter: MemoryFrontmatter
  content: string
  ageDays: number
  isStale: boolean
}

export interface MemoryIndexEntry {
  filename: string
  name: string
  description: string
  type: MemoryType
  updated: string
}

/** Renderer-facing display type (serializable over IPC) */
export interface MemoryEntryDisplay {
  filename: string
  name: string
  description: string
  type: MemoryType
  content: string
  updated: string
  ageDays: number
  isStale: boolean
  scope?: MemoryScope
  enabled?: boolean
  tags?: string[]
  /** Workspace file path when entry comes from memdir scan (read-only in UI). */
  sourcePath?: string
}

/** Parameters for creating a memory via IPC */
export interface CreateMemoryParams {
  name: string
  description: string
  type: MemoryType
  content: string
  scope?: MemoryScope
  enabled?: boolean
  tags?: string[]
}

/** Parameters for updating a memory via IPC */
export interface UpdateMemoryParams {
  filename: string
  name?: string
  description?: string
  type?: MemoryType
  content?: string
  scope?: MemoryScope
  enabled?: boolean
  tags?: string[]
}

/** Auto-extract: single memory item parsed from LLM response */
export interface ExtractedMemory {
  name: string
  type: MemoryType
  description: string
  content: string
}

/** Auto-extract: result of extraction run */
export interface AutoExtractResult {
  memories: ExtractedMemory[]
  errors: string[]
}

export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined
  return MEMORY_TYPES.find((t) => t === raw)
}

export function parseMemoryScope(
  raw: unknown,
  defaultScope: MemoryScope = 'project',
): MemoryScope {
  if (typeof raw !== 'string' || !raw.trim()) return defaultScope
  return MEMORY_SCOPES.find((t) => t === raw.trim()) ?? defaultScope
}
