import type { SessionNote } from '../session/types'

export function buildAwaySummary(note: SessionNote | null): string {
  if (!note) {
    return 'No active session context to summarize.'
  }

  const lines: string[] = []
  lines.push(`Session: ${note.title}`)
  lines.push(`State: ${note.state}`)
  lines.push(`Last updated: ${note.lastUpdated}`)

  const pendingTasks = note.tasks.filter((t) => t.status !== 'completed')
  if (pendingTasks.length > 0) {
    lines.push('')
    lines.push('Pending tasks:')
    for (const task of pendingTasks.slice(0, 5)) {
      lines.push(`- ${task.description} (${task.status})`)
    }
  }

  if (note.files.length > 0) {
    const recentFiles = note.files.slice(-8)
    lines.push('')
    lines.push('Recent files touched:')
    for (const file of recentFiles) {
      lines.push(`- ${file.action}: ${file.path}`)
    }
  }

  if (note.errors.length > 0) {
    lines.push('')
    lines.push('Recent errors:')
    for (const err of note.errors.slice(-3)) {
      lines.push(`- ${err.error}`)
    }
  }

  if (note.worklog.length > 0) {
    const last = note.worklog[note.worklog.length - 1]
    lines.push('')
    lines.push(`Latest activity: [${last.timestamp}] ${last.action} — ${last.detail}`)
  }

  return lines.join('\n')
}
