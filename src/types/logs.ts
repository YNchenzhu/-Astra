import type { AgentId, SessionId } from './ids'

// ============================================================================
// Log / Transcript Types
// ============================================================================

/**
 * A message serialized for transcript file storage.
 */
export interface SerializedMessage {
  cwd: string
  userType: string
  entrypoint?: string
  sessionId: SessionId
  timestamp: string
  version: string
  gitBranch?: string
  slug?: string
  [key: string]: unknown
}

/**
 * Worktree session state persisted to the transcript for resume.
 */
export interface PersistedWorktreeSession {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: SessionId
  tmuxSessionName?: string
  hookBased?: boolean
}

/**
 * Per-file attribution state tracking character contributions.
 */
export interface FileAttributionState {
  contentHash: string
  claudeContribution: number
  mtime: number
}

/**
 * Attribution snapshot message stored in session transcript.
 */
export interface AttributionSnapshotMessage {
  type: 'attribution-snapshot'
  messageId: string
  surface: string
  fileStates: Record<string, FileAttributionState>
  promptCount?: number
  promptCountAtLastCommit?: number
  permissionPromptCount?: number
  permissionPromptCountAtLastCommit?: number
  escapeCount?: number
  escapeCountAtLastCommit?: number
}

/**
 * Content replacement record for prompt cache stability.
 */
export interface ContentReplacementRecord {
  toolUseId: string
  originalSize: number
  stubSize: number
  [key: string]: unknown
}

/**
 * A session log entry with full metadata.
 */
export interface LogOption {
  date: string
  messages: SerializedMessage[]
  fullPath?: string
  value: number
  created: Date
  modified: Date
  firstPrompt: string
  messageCount: number
  fileSize?: number
  isSidechain: boolean
  isLite?: boolean
  sessionId?: SessionId
  teamName?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  isTeammate?: boolean
  leafUuid?: string
  summary?: string
  customTitle?: string
  tag?: string
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  gitBranch?: string
  projectPath?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  contentReplacements?: ContentReplacementRecord[]
}

/**
 * Summary message stored in transcript.
 */
export interface SummaryMessage {
  type: 'summary'
  leafUuid: string
  summary: string
}

/**
 * User-set custom title message.
 */
export interface CustomTitleMessage {
  type: 'custom-title'
  sessionId: SessionId
  customTitle: string
}

/**
 * AI-generated session title.
 */
export interface AiTitleMessage {
  type: 'ai-title'
  sessionId: SessionId
  aiTitle: string
}

/**
 * Last prompt message for session.
 */
export interface LastPromptMessage {
  type: 'last-prompt'
  sessionId: SessionId
  lastPrompt: string
}

/**
 * Periodic task summary for `claude ps` display.
 */
export interface TaskSummaryMessage {
  type: 'task-summary'
  sessionId: SessionId
  summary: string
  timestamp: string
}

/**
 * Session tag message.
 */
export interface TagMessage {
  type: 'tag'
  sessionId: SessionId
  tag: string
}

/**
 * Agent custom name message.
 */
export interface AgentNameMessage {
  type: 'agent-name'
  sessionId: SessionId
  agentName: string
}

/**
 * Agent color message.
 */
export interface AgentColorMessage {
  type: 'agent-color'
  sessionId: SessionId
  agentColor: string
}

/**
 * Agent setting message.
 */
export interface AgentSettingMessage {
  type: 'agent-setting'
  sessionId: SessionId
  agentSetting: string
}

/**
 * PR link message for GitHub PR tracking.
 */
export interface PRLinkMessage {
  type: 'pr-link'
  sessionId: SessionId
  prNumber: number
  prUrl: string
  prRepository: string
  timestamp: string
}

/**
 * Session mode entry (coordinator/normal).
 */
export interface ModeEntry {
  type: 'mode'
  sessionId: SessionId
  mode: 'coordinator' | 'normal'
}

/**
 * Worktree state entry (enter/exit).
 */
export interface WorktreeStateEntry {
  type: 'worktree-state'
  sessionId: SessionId
  worktreeSession: PersistedWorktreeSession | null
}

/**
 * Content replacement entry for prompt cache stability.
 */
export interface ContentReplacementEntry {
  type: 'content-replacement'
  sessionId: SessionId
  agentId?: AgentId
  replacements: ContentReplacementRecord[]
}

/**
 * File history snapshot message.
 */
export interface FileHistorySnapshotMessage {
  type: 'file-history-snapshot'
  messageId: string
  snapshot: FileHistorySnapshot
  isSnapshotUpdate: boolean
}

/**
 * File history snapshot for a specific point in time.
 */
export interface FileHistorySnapshot {
  filePath: string
  content: string
  timestamp: string
  [key: string]: unknown
}

/**
 * Transcript message with parent and sidechain tracking.
 */
export interface TranscriptMessage extends SerializedMessage {
  parentUuid: string | null
  logicalParentUuid?: string | null
  isSidechain: boolean
  gitBranch?: string
  agentId?: AgentId
  teamName?: string
  agentName?: string
  agentColor?: string
  promptId?: string
}

/**
 * Speculation accept message with time saved.
 */
export interface SpeculationAcceptMessage {
  type: 'speculation-accept'
  timestamp: string
  timeSavedMs: number
}

/**
 * Persisted context-collapse commit entry.
 */
export interface ContextCollapseCommitEntry {
  type: 'marble-origami-commit'
  sessionId: SessionId
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}

/**
 * Snapshot of staged queue and spawn trigger state.
 */
export interface ContextCollapseSnapshotEntry {
  type: 'marble-origami-snapshot'
  sessionId: SessionId
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
  }>
  armed: boolean
  lastSpawnTokens: number
}

/**
 * Queue operation message for transcript entries.
 */
export interface QueueOperationMessage {
  type: 'queue-operation'
  sessionId: SessionId
  operation: string
  timestamp: string
  [key: string]: unknown
}

/**
 * Discriminated union of all transcript entry types.
 */
export type Entry =
  | TranscriptMessage
  | SummaryMessage
  | CustomTitleMessage
  | AiTitleMessage
  | LastPromptMessage
  | TaskSummaryMessage
  | TagMessage
  | AgentNameMessage
  | AgentColorMessage
  | AgentSettingMessage
  | PRLinkMessage
  | FileHistorySnapshotMessage
  | AttributionSnapshotMessage
  | QueueOperationMessage
  | SpeculationAcceptMessage
  | ModeEntry
  | WorktreeStateEntry
  | ContentReplacementEntry
  | ContextCollapseCommitEntry
  | ContextCollapseSnapshotEntry

/**
 * Sort logs by modified date (newest first).
 */
export function sortLogs(logs: LogOption[]): LogOption[] {
  return logs.sort((a, b) => {
    const modifiedDiff = b.modified.getTime() - a.modified.getTime()
    if (modifiedDiff !== 0) {
      return modifiedDiff
    }
    return b.created.getTime() - a.created.getTime()
  })
}
