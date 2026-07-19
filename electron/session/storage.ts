/**
 * Session note persistence.
 * Stores structured conversation notes as Markdown.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomicUtf8 } from '../fs/atomicWrite'
import type { SessionNote, SessionTask, SessionFile, SessionError, SessionWorklogEntry } from './types'

export function hashProjectPath(projectPath: string): string {
  return crypto
    .createHash('sha256')
    .update(projectPath)
    .digest('hex')
    .slice(0, 16)
}

export function getSessionDir(
  userDataPath: string,
  projectHash: string,
  dataStoragePath?: string,
): string {
  const basePath = dataStoragePath || userDataPath
  return path.join(basePath, 'sessions', projectHash)
}

export function ensureSessionDir(
  userDataPath: string,
  projectHash: string,
  dataStoragePath?: string,
): string {
  const dir = getSessionDir(userDataPath, projectHash, dataStoragePath)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getSessionFilePath(
  userDataPath: string,
  projectHash: string,
  sessionId: string,
  dataStoragePath?: string,
): string {
  return path.join(
    getSessionDir(userDataPath, projectHash, dataStoragePath),
    `${sessionId}.md`,
  )
}

export function startNewSession(
  userDataPath: string,
  projectHash: string,
  dataStoragePath?: string,
): SessionNote {
  const dir = ensureSessionDir(userDataPath, projectHash, dataStoragePath)
  const sessionId = `session-${Date.now()}`
  const note: SessionNote = {
    title: `Session ${new Date().toISOString()}`,
    state: 'active',
    tasks: [],
    files: [],
    errors: [],
    learnings: [],
    worklog: [{ timestamp: new Date().toISOString(), action: 'session_started', detail: sessionId }],
    lastUpdated: new Date().toISOString(),
  }

  const filePath = path.join(dir, `${sessionId}.md`)
  writeFileAtomicUtf8(filePath, serializeSessionNote(note))

  return { ...note, _sessionId: sessionId } as SessionNote & { _sessionId?: string }
}

export function readSessionNote(
  userDataPath: string,
  projectHash: string,
  sessionId: string,
  dataStoragePath?: string,
): SessionNote | null {
  const filePath = getSessionFilePath(userDataPath, projectHash, sessionId, dataStoragePath)
  if (!fs.existsSync(filePath)) return null

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return parseSessionNote(raw)
  } catch {
    return null
  }
}

export function writeSessionNote(
  userDataPath: string,
  projectHash: string,
  sessionId: string,
  note: SessionNote,
  dataStoragePath?: string,
): void {
  const dir = ensureSessionDir(userDataPath, projectHash, dataStoragePath)
  const filePath = path.join(dir, `${sessionId}.md`)
  writeFileAtomicUtf8(filePath, serializeSessionNote(note))
}

export function listSessions(
  userDataPath: string,
  projectHash: string,
  dataStoragePath?: string,
): Array<{ sessionId: string; title: string; state: string; lastUpdated: string }> {
  const dir = getSessionDir(userDataPath, projectHash, dataStoragePath)
  if (!fs.existsSync(dir)) return []

  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
    const results: Array<{ sessionId: string; title: string; state: string; lastUpdated: string }> = []
    for (const f of files) {
      try {
        const filePath = path.join(dir, f)
        const raw = fs.readFileSync(filePath, 'utf-8')
        const note = parseSessionNote(raw)
        const sessionId = f.replace('.md', '')
        results.push({
          sessionId,
          title: note.title,
          state: note.state,
          lastUpdated: note.lastUpdated,
        })
      } catch {
        // Skip individual corrupted session files
      }
    }
    return results.sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime())
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeSessionNote(note: SessionNote): string {
  const lines: string[] = [
    `# ${note.title}`,
    `> State: ${note.state}`,
    `> Updated: ${note.lastUpdated}`,
    '',
  ]

  if (note.tasks.length > 0) {
    lines.push('## Tasks')
    for (const task of note.tasks) {
      const statusIcon =
        task.status === 'completed'
          ? '[x]'
          : task.status === 'blocked'
            ? '[!]'
            : task.status === 'in_progress'
              ? '[~]'
              : '[ ]'
      lines.push(`${statusIcon} ${task.description}`)
    }
    lines.push('')
  }

  if (note.files.length > 0) {
    lines.push('## Files')
    for (const file of note.files) {
      const action =
        file.action === 'created'
          ? '+'
          : file.action === 'modified'
            ? '*'
            : file.action === 'deleted'
              ? '-'
              : '>'
      lines.push(`${action} ${file.path}${file.note ? ` — ${file.note}` : ''}`)
    }
    lines.push('')
  }

  if (note.errors.length > 0) {
    lines.push('## Errors')
    for (const err of note.errors) {
      lines.push(
        `- ${err.error}${err.resolution ? ` → ${err.resolution}` : ''}${err.toolName ? ` (${err.toolName})` : ''}`,
      )
    }
    lines.push('')
  }

  if (note.learnings.length > 0) {
    lines.push('## Learnings')
    for (const learning of note.learnings) {
      lines.push(`- ${learning}`)
    }
    lines.push('')
  }

  if (note.worklog.length > 0) {
    lines.push('## Worklog')
    const recent = note.worklog.slice(-50)
    for (const entry of recent) {
      lines.push(`- [${entry.timestamp}] ${entry.action}: ${entry.detail}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function parseSessionNote(raw: string): SessionNote {
  const lines = raw.split('\n')
  const note: SessionNote = {
    title: 'Untitled Session',
    state: 'active',
    tasks: [],
    files: [],
    errors: [],
    learnings: [],
    worklog: [],
    lastUpdated: new Date().toISOString(),
  }

  let currentSection = ''

  for (const line of lines) {
    if (line.startsWith('# ')) {
      note.title = line.slice(2).trim()
      continue
    }
    if (line.startsWith('> State: ')) {
      const rawState = line.slice(9).trim()
      const validStates: SessionNote['state'][] = ['active', 'paused', 'completed', 'abandoned']
      note.state = validStates.includes(rawState as SessionNote['state']) ? (rawState as SessionNote['state']) : 'active'
      continue
    }
    if (line.startsWith('> Updated: ')) {
      note.lastUpdated = line.slice(11).trim()
      continue
    }
    if (line.startsWith('## ')) {
      currentSection = line.slice(3).trim().toLowerCase()
      continue
    }

    if (!line.trim()) continue

    if (currentSection === 'tasks') {
      const task = parseTaskLine(line)
      if (task) note.tasks.push(task)
    } else if (currentSection === 'files') {
      const file = parseFileLine(line)
      if (file) note.files.push(file)
    } else if (currentSection === 'errors') {
      const err = parseErrorLine(line)
      if (err) note.errors.push(err)
    } else if (currentSection === 'learnings') {
      if (line.startsWith('- ')) {
        note.learnings.push(line.slice(2).trim())
      }
    } else if (currentSection === 'worklog') {
      const entry = parseWorklogLine(line)
      if (entry) note.worklog.push(entry)
    }
  }

  return note
}

function parseTaskLine(line: string): SessionTask | null {
  const match = line.match(/^\s*([^[]+)\s+\[([x~! ])\]\s+(.*)$/)
  if (!match) {
    const simpleMatch = line.match(/^\s*\[([x~! ])\]\s+(.*)$/)
    if (simpleMatch) {
      const statusChar = simpleMatch[1]
      const status =
        statusChar === 'x'
          ? 'completed'
          : statusChar === '!'
            ? 'blocked'
            : statusChar === '~'
              ? 'in_progress'
              : 'pending'
      return { description: simpleMatch[2], status }
    }
    return null
  }
  const statusChar = match[2]
  const status =
    statusChar === 'x'
      ? 'completed'
      : statusChar === '!'
        ? 'blocked'
        : statusChar === '~'
          ? 'in_progress'
          : 'pending'
  return { description: match[3], status }
}

function parseFileLine(line: string): SessionFile | null {
  const match = line.match(/^\s*([+\-*])\s+(.+?)(?:\s+—\s*(.+))?$/)
  if (!match) return null
  const actionChar = match[1]
  const action =
    actionChar === '+'
      ? 'created'
      : actionChar === '*'
        ? 'modified'
        : actionChar === '-'
          ? 'deleted'
          : 'read'
  return { path: match[2].trim(), action, note: match[3] || undefined }
}

function parseErrorLine(line: string): SessionError | null {
  const match = line.match(/^\s*-\s+(.+?)(?:\s*→\s*(.+?))?(?:\s*\((.+)\))?$/)
  if (!match) return null
  return {
    error: match[1].trim(),
    resolution: match[2] ? match[2].trim() : undefined,
    toolName: match[3] ? match[3].trim() : undefined,
  }
}

function parseWorklogLine(line: string): SessionWorklogEntry | null {
  const match = line.match(/^\s*-\s*\[([^\]]+)\]\s+(.+?):\s+(.*)$/)
  if (!match) return null
  return {
    timestamp: match[1],
    action: match[2].trim(),
    detail: match[3].trim(),
  }
}

/**
 * Format session note for system prompt injection.
 */
const SESSION_PROMPT_MAX_ACTIVE_TASKS = 12
const SESSION_PROMPT_MAX_FILES = 40

function pushLimitedList(
  lines: string[],
  title: string,
  items: string[],
  maxItems: number,
): void {
  if (items.length === 0) return
  const visible = items.slice(-maxItems)
  lines.push('', title, ...visible)
  const omitted = items.length - visible.length
  if (omitted > 0) {
    lines.push(`- ... ${omitted} older item(s) omitted from session context`)
  }
}

export function formatSessionForPrompt(note: SessionNote): string {
  const lines: string[] = [
    '# Current Session',
    'Derived from tooling/session notes; may be stale. Verify against the current transcript or filesystem before treating as fact.',
    `State: ${note.state}`,
  ]

  if (note.tasks.length > 0) {
    const active = note.tasks.filter((t) => t.status !== 'completed')
    if (active.length > 0) {
      pushLimitedList(
        lines,
        'Pending tasks:',
        active.map((t) => `- ${t.description} (${t.status})`),
        SESSION_PROMPT_MAX_ACTIVE_TASKS,
      )
    }
  }

  if (note.files.length > 0) {
    pushLimitedList(
      lines,
      'Files touched:',
      note.files.map((f) => `- ${f.action}: ${f.path}`),
      SESSION_PROMPT_MAX_FILES,
    )
  }

  if (note.errors.length > 0) {
    lines.push('', 'Recent errors:', ...note.errors.slice(-3).map((e) => `- ${e.error}`))
  }

  return lines.join('\n')
}
