import path from 'node:path'
import os from 'node:os'
import { setSecurityWorkspaceRoots } from '../security/workspaceAccess'
import { getSessionMemoryRootDir } from '../session/sessionMemoryPaths'
import {
  canonicalizeForLlmDrift,
  resolveWithDriftFallback,
} from '../utils/charDriftCanonical'

let workspacePath: string | null = null

type WorkspacePathListener = (cwd: string | null) => void
const workspacePathListeners = new Set<WorkspacePathListener>()

/**
 * Subscribe to workspace-path changes. Main-process subsystems use this to
 * mirror the path into long-lived siblings (e.g. the tool utilityProcess
 * which is spawned eagerly at prewarm but whose own `workspacePath` would
 * otherwise stay `null` forever). The callback fires synchronously and
 * MUST NOT throw.
 *
 * Worker processes also import this module (via `workerSideState`) and call
 * `setWorkspacePath` from `tool_init`, but they never register listeners,
 * so the broadcast is a no-op in the worker context.
 */
export function onWorkspacePathChange(cb: WorkspacePathListener): () => void {
  workspacePathListeners.add(cb)
  return () => {
    workspacePathListeners.delete(cb)
  }
}

export function setWorkspacePath(cwd: string | null): void {
  const next =
    cwd == null || !String(cwd).trim() ? null : String(cwd).trim()
  workspacePath = next
  setSecurityWorkspaceRoots(next ? [next] : [])
  for (const cb of workspacePathListeners) {
    try {
      cb(next)
    } catch (e) {
      console.warn('[workspaceState] listener threw:', e)
    }
  }
}

export function getWorkspacePath(): string | null {
  return workspacePath
}

/**
 * Normalize a raw file path from AI tool input.
 * - Strips leading `/` or `\` (models often output `/src/foo.ts` meaning workspace-relative)
 * - On Windows, handles both `/` and `\` separators
 * - Returns a cleaned relative or absolute path string
 */
function normalizeToolFilePath(raw: string): string {
  let s = raw.trim()

  // Strip leading forward slash or backslash that models often prepend
  // e.g. "/src/components/App.tsx" → "src/components/App.tsx"
  while ((s.startsWith('/') || s.startsWith('\\')) && !isAbsoluteLike(s)) {
    s = s.slice(1)
  }

  return s
}

/**
 * Heuristic: does this string look like an absolute path?
 * Covers Windows (`C:\`, `C:/`), POSIX (`/`), and UNC (`\\`).
 */
function isAbsoluteLike(s: string): boolean {
  if (s.length < 2) return false
  // Windows drive letter: C:\ or C:/
  if (
    /^[a-zA-Z]:[\\/]/.test(s) ||
    // POSIX root
    s.startsWith('/') ||
    // UNC
    s.startsWith('\\\\')
  ) {
    return true
  }
  return false
}

/** Known memory directory roots that file tools may access without a workspace. */
function isUnderKnownMemoryDir(resolvedPath: string): boolean {
  const resolved = path.resolve(resolvedPath).toLowerCase()
  const sessionMemRoot = path.resolve(getSessionMemoryRootDir()).toLowerCase()
  if (resolved === sessionMemRoot || resolved.startsWith(sessionMemRoot + path.sep)) return true
  // Also allow ~/.claude/memory/user for user-scoped memories
  const userMemRoot = path.resolve(os.homedir(), '.claude', 'memory', 'user').toLowerCase()
  if (resolved === userMemRoot || resolved.startsWith(userMemRoot + path.sep)) return true
  return false
}

// LLM character-drift tolerance.
// Drift canonicalizer + component-wise resolver live in
// `electron/utils/charDriftCanonical.ts` so they can be reused by
// `workspaceAccess` (IPC), `advancedToolUtils` (glob/grep), and
// `fileEditSemantics` (edit_file) without cross-module dependencies.
//
// `canonicalizeForPathMatch` is kept as a local re-export so the existing
// boundary test file's import name still resolves.
export const canonicalizeForPathMatch = canonicalizeForLlmDrift
export { resolveWithDriftFallback }

/**
 * Resolve a path for AI file tools (Read / Write / Edit).
 * Requires a workspace to be open — except for known memory directories
 * (session-memory, memory/user) which are always accessible by absolute path.
 * Returns { ok: true, resolved } on success, or { ok: false, reason } on failure.
 *
 * Handles common model output quirks:
 * - Leading `/` on workspace-relative paths (e.g. `/src/foo.ts`)
 * - Mixed slash/backslash separators
 * - Unicode normalization (NFC)
 * - LLM character drift on Chinese paths: curly quotes / fullwidth CJK
 *   punctuation. When the literal resolved path doesn't exist, we walk the
 *   path component-by-component and substitute drift-equivalent sibling
 *   names that DO exist on disk. The returned path always uses the disk's
 *   actual character forms so subsequent tool calls don't re-drift.
 */
export function resolvePathForTool(
  filePath: string,
): { ok: true; resolved: string } | { ok: false; reason: string } {
  const raw = typeof filePath === 'string' ? filePath.trim() : ''
  if (!raw) {
    return { ok: false, reason: 'Path is empty.' }
  }

  const cleaned = normalizeToolFilePath(raw)

  // Allow absolute paths under known memory directories even without a workspace
  if (!workspacePath && isAbsoluteLike(cleaned)) {
    const resolved = path.resolve(cleaned).normalize('NFC')
    if (isUnderKnownMemoryDir(resolved)) {
      const driftResolved = resolveWithDriftFallback(resolved)
      return { ok: true, resolved: driftResolved ?? resolved }
    }
    return { ok: false, reason: 'No workspace folder is open. Open a folder before using file tools.' }
  }

  if (!workspacePath) {
    return { ok: false, reason: 'No workspace folder is open. Open a folder before using file tools.' }
  }

  const resolvedRaw = isAbsoluteLike(cleaned)
    ? path.resolve(cleaned)
    : path.resolve(workspacePath, cleaned)
  const resolved = resolvedRaw.normalize('NFC')
  const driftResolved = resolveWithDriftFallback(resolved)
  return { ok: true, resolved: driftResolved ?? resolved }
}

/**
 * Check whether a resolved file path is inside the workspace.
 * Prevents path traversal attacks (e.g. "../../etc/hosts").
 * Returns { safe: true, resolved } on success, or { safe: false, reason } on failure.
 */
export function validatePathWithinWorkspace(
  filePath: string,
): { safe: true; resolved: string } | { safe: false; reason: string } {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { safe: false, reason: 'filePath must be a non-empty string.' }
  }

  if (!workspacePath) {
    return { safe: false, reason: 'No workspace folder is open.' }
  }

  const resolveResult = resolvePathForTool(filePath)
  if (!resolveResult.ok) {
    return { safe: false, reason: resolveResult.reason }
  }

  const resolved = resolveResult.resolved
  const normalizedResolved = resolved.toLowerCase().replace(/\\/g, '/')
  const normalizedWs = path.resolve(workspacePath).toLowerCase().replace(/\\/g, '/')

  if (
    normalizedResolved !== normalizedWs &&
    !normalizedResolved.startsWith(normalizedWs + '/')
  ) {
    return {
      safe: false,
      reason: `Path "${filePath}" resolves to "${resolved}" which is outside the workspace "${workspacePath}".`,
    }
  }

  return { safe: true, resolved }
}
