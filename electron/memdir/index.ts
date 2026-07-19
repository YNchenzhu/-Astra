/**
 * Memory directory system — barrel exports.
 *
 * File-based memory system for persisting user preferences, feedback,
 * project context, and external resource references across sessions.
 */

// Memory type taxonomy
export {
  MEMORY_TYPES,
  parseMemoryType,
  MEMORY_FRONTMATTER_EXAMPLE,
  WHAT_NOT_TO_SAVE_SECTION,
  MEMORY_DRIFT_CAVEAT,
  WHEN_TO_ACCESS_SECTION,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
} from './memoryTypes'
export type { MemoryType } from './memoryTypes'

// Memory age utilities
export {
  memoryAgeDays,
  memoryAge,
  memoryFreshnessText,
  memoryFreshnessNote,
} from './memoryAge'

// Memory directory scanning
export {
  scanMemoryFiles,
  formatMemoryManifest,
} from './memoryScan'
export type { MemoryHeader } from './memoryScan'
