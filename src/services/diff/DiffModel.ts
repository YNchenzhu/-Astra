// Shared data model for all three Diff modes (Inline Edit / Composer / Agent Review).

export type DiffOp = 'equal' | 'add' | 'delete'

export interface DiffLine {
  op: DiffOp
  text: string
}

export interface CharRange {
  startCol: number
  endCol: number
}

export interface DiffHunk {
  id: string
  origStartLine: number
  origEndLine: number
  modStartLine: number
  modEndLine: number
  type: 'add' | 'delete' | 'modify'
  originalLines: string[]
  modifiedLines: string[]
}

export interface DiffStats {
  added: number
  removed: number
  hunks: number
}

export interface DiffResult {
  diffLines: DiffLine[]
  hunks: DiffHunk[]
  stats: DiffStats
}

export interface FileDiff {
  filePath: string
  originalContent: string
  modifiedContent: string
  result: DiffResult
}

export type DiffSessionMode = 'inline-edit' | 'composer' | 'agent-review'

export interface DiffSession {
  id: string
  files: Map<string, FileDiff>
  mode: DiffSessionMode
  createdAt: number
}

