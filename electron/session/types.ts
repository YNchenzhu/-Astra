/**
 * Session memory type definitions.
 * Tracks ongoing conversation state for context continuity.
 */

export interface SessionTask {
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked'
}

export interface SessionFile {
  path: string
  action: 'read' | 'created' | 'modified' | 'deleted'
  note?: string
}

export interface SessionError {
  error: string
  resolution?: string
  toolName?: string
}

export interface SessionWorklogEntry {
  timestamp: string
  action: string
  detail: string
}

export interface SessionNote {
  title: string
  state: 'active' | 'paused' | 'completed' | 'abandoned'
  tasks: SessionTask[]
  files: SessionFile[]
  errors: SessionError[]
  learnings: string[]
  worklog: SessionWorklogEntry[]
  lastUpdated: string
}
