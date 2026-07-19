/**
 * Session memory paths — upstream §3 / §11:
 * - Preferred: ~/.claude/projects/<workspace-slug>/session-memory/<conv>.md
 * - Legacy: ~/.claude/session-memory/<conv>.md (still read as fallback)
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export function getSessionMemoryRootDir(): string {
  return path.join(os.homedir(), '.claude', 'session-memory')
}

/** Deterministic slug from workspace root (16-char hex). */
export function workspacePathToSlug(workspacePath: string): string {
  return crypto.createHash('sha256').update(path.resolve(workspacePath.trim())).digest('hex').slice(0, 16)
}

export function getSessionMemoryProjectRoot(workspacePath: string): string {
  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    workspacePathToSlug(workspacePath),
    'session-memory',
  )
}

export function sanitizeConversationIdForFilename(id: string): string {
  const s = id.trim().replace(/[^a-zA-Z0-9._-]+/g, '_')
  if (!s) return 'conversation'
  // Audit S3: two distinct IDs sharing a 200-char sanitised prefix would
  // collide onto the same notes file. Conversation IDs are UUID-length in
  // practice so this is unreachable today, but if an ID ever exceeds the cap
  // we fold a short hash of the FULL id into the suffix to keep the mapping
  // injective. Short IDs are returned unchanged (no behaviour drift).
  if (s.length <= 200) return s
  const suffix = crypto.createHash('sha256').update(id).digest('hex').slice(0, 12)
  return `${s.slice(0, 200 - 1 - suffix.length)}-${suffix}`
}

/**
 * Primary path for writes. When `workspacePath` is set, uses project-scoped layout; else legacy flat dir.
 */
export function getSessionMemoryMarkdownPath(
  conversationId: string,
  workspacePath?: string | null,
): string {
  const safe = sanitizeConversationIdForFilename(conversationId)
  if (workspacePath?.trim()) {
    return path.join(getSessionMemoryProjectRoot(workspacePath.trim()), `${safe}.md`)
  }
  return path.join(getSessionMemoryRootDir(), `${safe}.md`)
}

export function getSessionMemoryLegacyFlatPath(conversationId: string): string {
  const safe = sanitizeConversationIdForFilename(conversationId)
  return path.join(getSessionMemoryRootDir(), `${safe}.md`)
}

export async function readSessionMemoryMarkdown(
  conversationId: string,
  workspacePath?: string | null,
): Promise<string | null> {
  const primary = getSessionMemoryMarkdownPath(conversationId, workspacePath)
  try {
    return await fs.readFile(primary, 'utf8')
  } catch {
    if (workspacePath?.trim()) {
      try {
        return await fs.readFile(getSessionMemoryLegacyFlatPath(conversationId), 'utf8')
      } catch {
        return null
      }
    }
    return null
  }
}

/**
 * Ensure directory exists for the active session-memory layout (project or flat).
 */
export async function ensureSessionMemoryTree(workspacePath?: string | null): Promise<string> {
  const root = workspacePath?.trim()
    ? getSessionMemoryProjectRoot(workspacePath.trim())
    : getSessionMemoryRootDir()
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const readme = path.join(root, 'README.md')
  try {
    await fs.access(readme)
  } catch {
    await fs.writeFile(
      readme,
      [
        '# Session memory',
        '',
        'Auto-maintained session notes for this workspace or host session.',
        '',
      ].join('\n'),
      'utf8',
    )
  }
  return root
}

/** @deprecated Use ensureSessionMemoryTree — kept for tests / call sites */
export async function ensureSessionMemoryDir(): Promise<string> {
  return ensureSessionMemoryTree(null)
}
