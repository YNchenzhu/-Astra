/**
 * Rule-based tool usage extraction.
 * No LLM call — maps tool names and inputs to session note updates.
 */

import type { SessionNote, SessionWorklogEntry } from './types'

export function extractFromToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: { success: boolean; output?: string; error?: string; writeType?: string },
): Partial<SessionNote> {
  const updates: Partial<SessionNote> = {}
  const now = new Date().toISOString()
  const worklogEntry: SessionWorklogEntry = { timestamp: now, action: '', detail: '' }

  switch (toolName) {
    case 'Read':
    case 'read_file': {
      const filePath = String(toolInput.filePath || '')
      updates.files = [{ path: filePath, action: 'read' }]
      worklogEntry.action = 'read file'
      worklogEntry.detail = filePath
      break
    }
    case 'Write':
    case 'write_file': {
      const filePath = String(toolInput.filePath || '')
      const writeType =
        typeof toolResult.writeType === 'string' ? toolResult.writeType : ''
      const action = writeType === 'update' ? 'modified' : 'created'
      updates.files = [{ path: filePath, action }]
      worklogEntry.action = action === 'modified' ? 'modified file' : 'created file'
      worklogEntry.detail = filePath
      break
    }
    case 'Edit':
    case 'edit_file':
    case 'MultiEdit':
    case 'multi_edit_file': {
      const filePath = String(toolInput.filePath || '')
      updates.files = [{ path: filePath, action: 'modified' }]
      worklogEntry.action = 'modified file'
      worklogEntry.detail = filePath
      break
    }
    case 'Bash':
    case 'bash': {
      const command = String(toolInput.command || '').slice(0, 100)
      worklogEntry.action = 'executed command'
      worklogEntry.detail = command
      if (!toolResult.success && toolResult.error) {
        updates.errors = [
          {
            error: String(toolResult.error).slice(0, 500),
            toolName: 'bash',
          },
        ]
      }
      break
    }
    case 'Glob':
    case 'glob': {
      const pattern = String(toolInput.pattern || '')
      worklogEntry.action = 'searched (glob)'
      worklogEntry.detail = pattern
      break
    }
    case 'Grep':
    case 'grep': {
      const pattern = String(toolInput.pattern || '')
      worklogEntry.action = 'searched (grep)'
      worklogEntry.detail = pattern
      break
    }
    default: {
      worklogEntry.action = `used tool: ${toolName}`
      // Do NOT JSON.stringify(toolInput) — it may contain sensitive values
      // (API keys, passwords, file contents). Only record safe metadata.
      const safeKeys = ['filePath', 'pattern', 'command', 'description', 'model']
      const safeParts: string[] = []
      for (const k of safeKeys) {
        const v = toolInput[k]
        if (typeof v === 'string' && v.trim()) {
          safeParts.push(`${k}=${v.trim().slice(0, 40)}`)
        }
      }
      worklogEntry.detail = safeParts.join(', ').slice(0, 100) || '(no safe metadata)'
    }
  }

  updates.worklog = [worklogEntry]
  updates.lastUpdated = now
  return updates
}
