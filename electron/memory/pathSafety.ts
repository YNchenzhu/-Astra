/**
 * Memory path safety — adapted from upstream §2.5.
 *
 * Validates memory directory paths to prevent path traversal attacks,
 * writes to system-critical locations, and other dangerous patterns.
 */

import path from 'node:path'

export interface PathValidationResult {
  valid: boolean
  reason?: string
}

/**
 * Path segments that indicate the caller is trying to point a
 * **user-supplied** memory mirror at a sensitive credential / config tree.
 * Compared case-insensitively against every segment of the resolved path.
 *
 * NOT used by {@link validateMemoryPath} (which has to allow the platform's
 * own `userData` under `AppData` / `Library/Application Support` / `.config`
 * — those legitimately host the default memory bundle). Use
 * {@link isUserSuppliedMirrorPathSafe} explicitly when validating paths
 * that came from a renderer IPC payload or from `settings.autoMemoryDirectory`.
 *
 * Threat model: `autoMemoryDirectory` is an absolute path that
 * `mirrorExtractedToDirectory` recursively `mkdir`s and `writeFile`s into.
 * A compromised renderer IPC — or a tampered `userData/星构Astra-settings.json`
 * — could redirect the mirror into `~/.ssh`, `~/.aws`, etc., either leaking
 * (via subsequent reads) or clobbering the user's credentials.
 *
 * This complements `DANGEROUS_DIRECTORY_SEGMENT_NAMES` in
 * `electron/tools/fileToolValidation.ts` — that one is workspace-pollution
 * (`.git` / `.vscode` / `.idea` / `.claude`); this one is OS-level credential
 * dirs. The file-tool gate already blocks them at write time; we block them
 * earlier here so the mirror never even tries to `mkdir` inside them.
 */
const USER_SUPPLIED_SENSITIVE_SEGMENTS = new Set(
  [
    '.ssh',
    '.aws',
    '.gnupg',
    '.gpg',
    '.docker',
    '.kube',
    '.netrc',
    '.azure',
    '.gcloud',
  ].map((s) => s.toLowerCase()),
)

/**
 * Check whether a user-supplied mirror directory path contains any sensitive
 * credential / config segment. Returns `{ valid: false, reason }` when the
 * path should be refused, or `{ valid: true }` otherwise. Does NOT validate
 * basic shape — call {@link validateMemoryPath} first for that.
 *
 * Audit fix A5: normalise BEFORE splitting so paths like `~/foo/../.ssh/x`
 * or `~/.//.ssh/x` aren't smuggled through by the `..` / `.` segments.
 * `path.normalize` collapses `.` and `..` and removes double-separators —
 * tip: it does NOT resolve symlinks; that's a host-FS responsibility and
 * outside the schema-shape contract this function offers.
 */
export function isUserSuppliedMirrorPathSafe(
  absolutePath: string,
): PathValidationResult {
  const normalised = path.normalize(absolutePath)
  const parts = normalised.split(/[\\/]/).filter((p) => p.length > 0)
  for (const part of parts) {
    if (USER_SUPPLIED_SENSITIVE_SEGMENTS.has(part.toLowerCase())) {
      return {
        valid: false,
        reason: `Path contains sensitive segment "${part}" — refusing to mirror memory into a credential / config directory`,
      }
    }
  }
  return { valid: true }
}

/**
 * Validate a memory directory path for safety.
 * Rejects relative paths, root/near-root directories, Windows drive roots,
 * UNC paths, and null-byte injection.
 */
export function validateMemoryPath(memPath: string): PathValidationResult {
  if (!memPath || typeof memPath !== 'string') {
    return { valid: false, reason: 'Empty or invalid path' }
  }

  if (memPath.includes('\0')) {
    return { valid: false, reason: 'Path contains null byte' }
  }

  // Detect UNC syntax before the host-native absolute-path check. On POSIX,
  // `path.isAbsolute('\\\\server\\share')` is false, but the input is still a
  // Windows UNC path and must receive the stricter, stable rejection reason.
  if (memPath.startsWith('\\\\') || memPath.startsWith('//')) {
    return { valid: false, reason: 'UNC paths are not allowed' }
  }

  // Audit M5: reject a real `..` PATH SEGMENT (traversal) rather than any
  // `..` substring. The old `includes('..')` false-rejected legitimate
  // directory names like `a..b` or files like `notes..md`, while still being
  // no stronger against genuine traversal. Split on either separator and look
  // for an exact `..` component.
  if (memPath.split(/[\\/]/).some((seg) => seg === '..')) {
    return { valid: false, reason: 'Relative path traversal (.. segment) not allowed' }
  }

  if (!path.isAbsolute(memPath)) {
    return { valid: false, reason: 'Must be an absolute path' }
  }

  const normalized = path.normalize(memPath)
  if (normalized.length < 3) {
    return { valid: false, reason: 'Path too close to filesystem root' }
  }

  if (/^[A-Za-z]:\\?$/.test(normalized)) {
    return { valid: false, reason: 'Windows drive root is not allowed' }
  }

  if (normalized === '/' || normalized === '\\') {
    return { valid: false, reason: 'Filesystem root is not allowed' }
  }

  return { valid: true }
}

/**
 * Check whether a given file path resides within a known memory directory.
 * Uses normalize() + startsWith() to prevent path traversal.
 */
export function isAutoMemPath(filePath: string, memoryDir: string): boolean {
  if (!filePath || !memoryDir) return false
  const normalizedFile = path.normalize(filePath)
  const normalizedDir = path.normalize(memoryDir)
  return normalizedFile.startsWith(normalizedDir + path.sep) || normalizedFile === normalizedDir
}

/**
 * Check whether a path resides in any of the recognized memory scopes:
 * - User scope: <memoryBase>/memory/user/
 * - Project scope: <workspace>/.claude/memory/
 * - Team scope: <workspace>/.claude/team-memory/
 * - Session scope: ~/.claude/session-memory/
 */
export function isKnownMemoryPath(
  filePath: string,
  options: {
    userMemoryDir?: string
    workspaceMemoryDir?: string
    teamMemoryDir?: string
    sessionMemoryDir?: string
  },
): boolean {
  const normalized = path.normalize(filePath)
  const dirs = [
    options.userMemoryDir,
    options.workspaceMemoryDir,
    options.teamMemoryDir,
    options.sessionMemoryDir,
  ].filter((d): d is string => !!d)

  return dirs.some((dir) => {
    const nd = path.normalize(dir)
    return normalized.startsWith(nd + path.sep) || normalized === nd
  })
}
