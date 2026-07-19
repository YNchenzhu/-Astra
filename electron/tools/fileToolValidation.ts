/**
 * upstream FileReadTool §1.3-style checks: UNC SMB safety, device paths, binary extensions.
 * Report §5.6: path safety pipeline (shell expansion → transport/device → type/basename; mutate adds §5.9 dirs + glob).
 * Report §5.9: DANGEROUS_FILES / DANGEROUS_DIRECTORIES (case-insensitive segment/basename match).
 * Applied to read/write/edit after path resolution.
 */

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import { getSessionMemoryRootDir } from '../session/sessionMemoryPaths'
import { isResolvedPathInKnownMemoryWritableTree } from '../memory/memoryPathGate'
import { resolveRealPathAllowingMissingLeaf } from './canonicalPath'
import {
  getSessionAgentTypeForMemoryGates,
  getSessionMemoryWritableTargetPathForGates,
} from './sessionMemoryGateBridge'
import { getWorkspacePath } from './workspaceState'

/** Report §5.9 — sensitive dotfiles; compare basenames with normalizeCaseForComparison. */
export const DANGEROUS_FILE_BASENAMES = new Set(
  [
    '.gitconfig',
    '.gitmodules',
    '.bashrc',
    '.bash_profile',
    '.zshrc',
    '.zprofile',
    '.profile',
    '.ripgreprc',
    '.mcp.json',
    '.claude.json',
  ].map((s) => s.toLowerCase()),
)

/** Report §5.9 — any path segment matching blocks mutate (not read) to avoid breaking routine .vscode reads. */
export const DANGEROUS_DIRECTORY_SEGMENT_NAMES = new Set(
  ['.git', '.vscode', '.idea', '.claude'].map((s) => s.toLowerCase()),
)

export function normalizeCaseForComparison(s: string): string {
  return s.toLowerCase()
}

/**
 * Report §5.6 — reject raw paths that look like shell interpolation / env expansion
 * (workspace resolution may not mirror the shell; prevents surprise targets).
 */
export function rawPathContainsSuspiciousExpansion(raw: string): boolean {
  const s = raw
  if (s.includes('$(') || s.includes('${')) return true
  if (s.includes('`')) return true
  if (/%[^/%\s]+%/i.test(s)) return true
  if (/~[+-](?:[/\\]|$)/.test(s)) return true
  if (/~[^/\\\s]+(?:[/\\]|$)/.test(s)) return true
  return false
}

/**
 * Report §5.6 — write/edit: refuse glob metacharacters in the **raw** path (models must not batch-write via `*` / `?`).
 */
export function rawMutatePathContainsGlobMetachar(raw: string): boolean {
  return /[*?]/.test(raw.trim())
}

function pathSegmentsForDangerCheck(resolvedPath: string): string[] {
  const n = resolvedPath.replace(/\\/g, '/')
  return n.split('/').filter((seg) => seg.length > 0)
}

export function isDangerousSensitiveFileBasename(filePath: string): boolean {
  // `path.basename` follows the host OS. A Windows path can still arrive in
  // tests, migrated settings, or remote tool input while the host is POSIX,
  // where backslashes are ordinary characters. Normalize separators first so
  // the security decision is based on the path's syntax, not the runner OS.
  const base = normalizeCaseForComparison(path.posix.basename(filePath.replace(/\\/g, '/')))
  return DANGEROUS_FILE_BASENAMES.has(base)
}

function isPathUnderParent(absChild: string, absParent: string): boolean {
  // Windows paths are case-insensitive; normalize both paths to lowercase before comparison.
  const parent = process.platform === 'win32' ? absParent.toLowerCase() : absParent
  const child = process.platform === 'win32' ? absChild.toLowerCase() : absChild
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * True when under ~/.claude/session-memory or ~/.claude/projects/.../session-memory/
 * (upstream project-scoped session notes). Uses {@link resolveRealPathAllowingMissingLeaf}
 * so symlinks are defeated whether the target file exists or not.
 */
export function isUnderSessionMemoryWritableRoot(resolvedPath: string): boolean {
  const abs = resolveRealPathAllowingMissingLeaf(resolvedPath)
  const flat = path.resolve(getSessionMemoryRootDir())
  if (isPathUnderParent(abs, flat)) return true
  const projectsRoot = path.resolve(path.join(os.homedir(), '.claude', 'projects'))
  if (!isPathUnderParent(abs, projectsRoot)) return false
  const rel = path.relative(projectsRoot, abs).replace(/\\/g, '/')
  return rel.split('/').includes('session-memory')
}

/**
 * True when `a` and `b` resolve to the exact same absolute path. Symlinks
 * are followed when the leaf exists; otherwise the nearest existing
 * ancestor is realpath'd and the tail re-joined (matches
 * {@link resolveRealPathAllowingMissingLeaf}). Windows comparison is
 * case-insensitive.
 */
function isSameResolvedPath(a: string, b: string): boolean {
  const ra = resolveRealPathAllowingMissingLeaf(path.resolve(a))
  const rb = resolveRealPathAllowingMissingLeaf(path.resolve(b))
  if (process.platform === 'win32') {
    return ra.toLowerCase() === rb.toLowerCase()
  }
  return ra === rb
}

/**
 * Programmatic path gate for the session-memory-internal agent.
 * This agent must ONLY access its designated session-memory markdown file path.
 * The system prompt instruction is not enough — this enforces it at the code level.
 *
 * Read access: any file under the session-memory tree (the agent may read existing notes).
 * Write/mutate access:
 *   - When the host has set {@link AgentContext.sessionMemoryWritableTargetPath}
 *     (production scribe path), the resolved path MUST equal that target
 *     exactly. This stops the scribe from creating siblings like
 *     `<conv>-new.md`, `_test.md`, `*.bak`, etc.
 *   - When no target is set (legacy / test callers), falls back to the
 *     original "any `.md` under the session-memory tree" rule.
 */
export function gateSessionMemoryInternalAgentPath(
  resolvedPath: string,
  mode: 'read' | 'mutate' = 'read',
): FileToolGate {
  if (getSessionAgentTypeForMemoryGates() !== 'session-memory-internal') {
    return { ok: true }
  }

  if (!isUnderSessionMemoryWritableRoot(resolvedPath)) {
    return {
      ok: false,
      error:
        '[session-memory-internal] Access denied: this agent may only read/write files under the session-memory directory.',
    }
  }

  if (mode === 'mutate') {
    const ext = path.extname(resolvedPath).toLowerCase()
    if (ext !== '.md') {
      return {
        ok: false,
        error:
          '[session-memory-internal] Access denied: this agent may only write .md files in session-memory.',
      }
    }
    const target = getSessionMemoryWritableTargetPathForGates()
    if (target && target.trim() && !isSameResolvedPath(resolvedPath, target)) {
      return {
        ok: false,
        error:
          `[session-memory-internal] Access denied: this agent may only mutate its designated session-memory file (${target}). ` +
          `Refusing write to "${resolvedPath}" — do NOT create sibling files like \`*-new.md\`, \`_test.md\`, or \`*.bak\`; ` +
          `re-issue the Edit against the designated path with a corrected old_string.`,
      }
    }
  }

  return { ok: true }
}

/** Registry tool names that must be pre-flight gated for session-memory-internal. */
const SESSION_MEMORY_MUTATION_TOOL_NAMES = new Set<string>([
  'write_file',
  'edit_file',
  'multi_edit_file',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'notebook_edit',
  'delete_file',
  'move_file',
  'rename_file',
  'create_directory',
])

const SESSION_MEMORY_READ_TOOL_NAMES = new Set<string>([
  'read_file',
  'Read',
  'NotebookRead',
  'notebook_read',
])

/** Search tools must be confined to the session-memory tree (Bug 4). */
const SESSION_MEMORY_SEARCH_TOOL_NAMES = new Set<string>([
  'Glob',
  'glob',
  'Grep',
  'grep',
])

const SESSION_MEMORY_FORBIDDEN_TOOL_NAMES = new Set<string>([
  'Bash',
  'bash',
  'PowerShell',
  'powershell',
  'shell',
  'run_command',
  'execute_command',
  'WebSearch',
  'web_search',
  'WebFetch',
  'web_fetch',
  'Agent',
  'Task',
  'SendMessage',
  'TeamCreate',
  // P1-17: TodoWrite would otherwise default-allow through this gate (it has
  // no file path) and let session-memory-internal pollute the parent's
  // todo panel. Resolver-level injection is also skipped for this agent
  // type as a primary defense.
  'TodoWrite',
  'todo_write',
])

function extractFilePathFromSessionMemoryToolInput(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const candidates: unknown[] = [
    input.filePath,
    input.file_path,
    input.path,
    input.source,
    input.destination,
    input.target,
    input.notebookPath,
    input.notebook_path,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

/** Extract the search root for a Glob/Grep call (cwd/path/directory variants). */
function extractSearchRootFromSessionMemoryToolInput(
  input: Record<string, unknown>,
): string {
  const candidates: unknown[] = [
    input.cwd,
    input.path,
    input.directory,
    input.dir,
    input.root,
    input.baseDir,
    input.base_dir,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

/**
 * Raw pattern inspection for Glob/Grep — path traversal (`..`) or absolute
 * paths in include/exclude/pattern are rejected to stop escaping out of the
 * sandbox via ripgrep's `--glob` expansion, even when `cwd` itself is inside
 * session-memory.
 */
function sessionMemorySearchPatternContainsEscape(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const s = raw.trim()
  if (!s) return false
  if (/(^|[\\/])\.\.([\\/]|$)/.test(s)) return true
  if (path.isAbsolute(s)) return true
  if (/^[a-z]:[\\/]/i.test(s)) return true
  if (s.startsWith('\\\\') || s.startsWith('//')) return true
  return false
}

/**
 * HARD pre-flight gate: must be called **before** any diff-preview rendering or
 * permission UI whenever the current agent context is `session-memory-internal`.
 *
 * Belt-and-suspenders over {@link gateSessionMemoryInternalAgentPath}: stops the
 * request at the earliest point in {@link runAgenticToolUse} so that the user is
 * never shown an approve-able diff for an out-of-sandbox path (audit v3 Bug 1/2/3).
 *
 * Pass the **raw input** (resolution happens inside); the caller does not need to
 * resolve the path ahead of time.
 */
export function gateSessionMemoryInternalAgentToolUse(
  toolName: string,
  input: Record<string, unknown>,
): FileToolGate {
  if (getSessionAgentTypeForMemoryGates() !== 'session-memory-internal') return { ok: true }

  if (SESSION_MEMORY_FORBIDDEN_TOOL_NAMES.has(toolName)) {
    return {
      ok: false,
      error: `[session-memory-internal] Access denied: tool "${toolName}" is not permitted for this agent.`,
    }
  }

  const isMutation =
    SESSION_MEMORY_MUTATION_TOOL_NAMES.has(toolName) ||
    (toolName.startsWith('mcp__') &&
      /(write_file|edit_file|move_file|delete_file|rename_file|create_directory)$/i.test(
        toolName,
      ))
  const isRead =
    SESSION_MEMORY_READ_TOOL_NAMES.has(toolName) ||
    (toolName.startsWith('mcp__') && /read_file$/i.test(toolName))
  const isSearch = SESSION_MEMORY_SEARCH_TOOL_NAMES.has(toolName)

  if (isSearch) {
    const rawRoot = extractSearchRootFromSessionMemoryToolInput(input)
    if (!rawRoot) {
      return {
        ok: false,
        error: `[session-memory-internal] Access denied: "${toolName}" requires an explicit cwd/path under the session-memory tree.`,
      }
    }
    // `path.resolve` canonicalises `..` segments; the gate then catches any
    // absolute path or traversal that still resolves outside the tree.
    const resolvedRoot = path.resolve(rawRoot)
    const rootGate = gateSessionMemoryInternalAgentPath(resolvedRoot, 'read')
    if (!rootGate.ok) return rootGate

    // For Glob the top-level `pattern` IS a file-path glob; for Grep it is a
    // regex and must not be path-validated (valid regexes like `..` would
    // otherwise be rejected).
    const pathLikeKeys =
      toolName === 'Glob' || toolName === 'glob'
        ? ['pattern', 'include', 'exclude', 'glob', 'globPattern']
        : ['include', 'exclude', 'glob', 'globPattern']
    for (const k of pathLikeKeys) {
      if (sessionMemorySearchPatternContainsEscape(input[k])) {
        return {
          ok: false,
          error: `[session-memory-internal] Access denied: "${toolName}" ${k} must not contain parent-directory escapes or absolute paths.`,
        }
      }
    }
    return { ok: true }
  }

  // Close the MCP fall-through: session-memory-internal's whitelist is
  // Read/Write/Edit/Glob/Grep only — no MCP tool is part of its declared
  // scope. If a connected MCP server exposes tools whose names don't match
  // the filesystem read/mutation patterns recognised above (e.g.
  // `mcp__shell__exec`, `mcp__git__commit`, `mcp__sql__execute`), they would
  // otherwise reach the model and bypass the path-based gate. Deny them
  // outright so the only MCP traffic that survives is `*read_file` /
  // `*write_file` / `*edit_file` / `*move_file` / `*delete_file` /
  // `*rename_file` / `*create_directory` — all of which still go through the
  // path gate below.
  if (toolName.startsWith('mcp__') && !isMutation && !isRead) {
    return {
      ok: false,
      error: `[session-memory-internal] Access denied: MCP tool "${toolName}" is not permitted for this agent (only filesystem-style MCP read/write tools scoped to the session-memory directory are allowed).`,
    }
  }

  // P1-16: previously fell through to `return { ok: true }` for any tool
  // that wasn't classified as mutation/read/search/forbidden. New tools (or
  // arbitrary internal tools the model invoked by name) silently passed the
  // gate — violating the "this agent can only touch ~/.claude/session-memory/"
  // contract documented in AGENTS.md. Now: default-deny.
  if (!isMutation && !isRead) {
    return {
      ok: false,
      error:
        `[session-memory-internal] Access denied: tool "${toolName}" is not on this agent's allowlist ` +
        `(scoped to filesystem read/mutation/search inside the session-memory tree).`,
    }
  }

  const raw = extractFilePathFromSessionMemoryToolInput(toolName, input)
  if (!raw) {
    return {
      ok: false,
      error: `[session-memory-internal] Access denied: tool "${toolName}" requires an explicit file path inside the session-memory tree.`,
    }
  }
  const resolved = path.resolve(raw)
  return gateSessionMemoryInternalAgentPath(resolved, isMutation ? 'mutate' : 'read')
}

/**
 * Pre-canonicalisation for the `session-memory-internal` scribe: rewrite
 * any relative `filePath` / `file_path` / `path` field on the tool input
 * to an absolute path **rooted at the session-memory target's parent
 * directory**, not at the agent's CWD.
 *
 * Why this exists (audit v4, May 2026):
 *   The scribe's CWD inherits the host Electron process's CWD — in dev
 *   mode that's the project workspace (e.g. `C:\…\Desktop\标书智能体`),
 *   in packaged builds it's an arbitrary install/launch dir. Both are
 *   meaningless to this agent. When deepseek-v4-pro emits a bare
 *   basename like `conv-X.md` (observed in `.cursor/debug-c1971a.log`
 *   H6 evidence), `resolvePathForTool` resolves it against the workspace
 *   root and the session-memory gate rejects every call — burning ~10
 *   minutes in a read→deny→retry loop.
 *
 * After this rewrite:
 *   - bare basename / "./conv-X.md" → `<targetDir>/conv-X.md` (matches
 *     target → gate passes → tool reads target ✓)
 *   - wrong relative path like `.claude/projects/.../X.md` →
 *     `<targetDir>/.claude/projects/.../X.md` (still outside the
 *     allowed area → gate rejects with a deterministic error rather
 *     than an opaque ENOENT)
 *   - absolute path → unchanged (existing behaviour ✓)
 *
 * No-op when the current agent is not `session-memory-internal` or no
 * sandboxed target is set.
 */
export function canonicaliseSessionMemoryToolInput(
  input: Record<string, unknown>,
): void {
  if (getSessionAgentTypeForMemoryGates() !== 'session-memory-internal') return
  const target = getSessionMemoryWritableTargetPathForGates()
  if (!target || !target.trim()) return
  const baseDir = path.dirname(target)
  // Audit S2: cover every path-bearing key the gate later inspects
  // (`extractFilePathFromSessionMemoryToolInput`), not just filePath/path.
  // Otherwise a relative `source`/`destination` on move/rename/notebook tools
  // would be resolved against the meaningless process CWD and rejected even
  // when it pointed at a legitimate in-sandbox sibling.
  const PATH_KEYS = [
    'filePath',
    'file_path',
    'path',
    'source',
    'destination',
    'target',
    'notebookPath',
    'notebook_path',
  ] as const
  for (const key of PATH_KEYS) {
    const v = input[key]
    if (typeof v !== 'string') continue
    const raw = v.trim()
    if (!raw) continue
    if (path.isAbsolute(raw)) continue
    input[key] = path.resolve(baseDir, raw)
  }
}

/**
 * Audit fix (2026-06, P0 R4) — workspace root boundary for AI file tools.
 *
 * `resolvePathForTool` deliberately resolves absolute paths verbatim and the
 * mutate/search gates historically never checked the workspace root, so an
 * agent could write to or search any absolute path on disk — inconsistent
 * with the IPC/renderer-side `security/workspaceAccess` policy.
 *
 * Policy enforced here (realpath-aware, symlinks defeated via
 * {@link resolveRealPathAllowingMissingLeaf}):
 *   - Mutations and search roots must resolve inside the workspace root.
 *   - Carve-outs (legitimate out-of-workspace trees):
 *       1. the session-memory tree (scribe agent writes ~/.claude/session-memory),
 *       2. known memory-writable trees (~/.claude memory/agent-memory gates),
 *       3. the OS temp directory (scratch files for scripts/tests).
 *   - Escape hatches for operators: `POLE_ALLOW_OUTSIDE_WORKSPACE_WRITES=1`
 *     (mutate) / `POLE_ALLOW_OUTSIDE_WORKSPACE_SEARCH=1` (search).
 *   - No workspace open → no boundary to enforce (resolvePathForTool already
 *     restricts the no-workspace case to known memory dirs).
 *
 * Reads (`gateFileReadPath`) intentionally stay unbounded — out-of-workspace
 * reads are an established product behavior (see pathResolution.boundary.test).
 */
function isUnderOutsideWorkspaceCarveOut(resolvedPath: string): boolean {
  if (isUnderSessionMemoryWritableRoot(resolvedPath)) return true
  if (isResolvedPathInKnownMemoryWritableTree(resolvedPath)) return true
  const abs = resolveRealPathAllowingMissingLeaf(resolvedPath)
  let tmpReal: string
  try {
    tmpReal = fs.realpathSync(os.tmpdir())
  } catch {
    tmpReal = path.resolve(os.tmpdir())
  }
  return isPathUnderParent(abs, tmpReal)
}

export function gateWorkspaceBoundary(
  resolvedPath: string,
  mode: 'mutate' | 'search',
): FileToolGate {
  const escapeEnv =
    mode === 'mutate'
      ? process.env.POLE_ALLOW_OUTSIDE_WORKSPACE_WRITES
      : process.env.POLE_ALLOW_OUTSIDE_WORKSPACE_SEARCH
  if (escapeEnv === '1') return { ok: true }

  const workspace = getWorkspacePath()
  if (!workspace || !workspace.trim()) return { ok: true }

  let wsReal: string
  try {
    wsReal = fs.realpathSync(path.resolve(workspace))
  } catch {
    wsReal = path.resolve(workspace)
  }
  const abs = resolveRealPathAllowingMissingLeaf(resolvedPath)
  if (isPathUnderParent(abs, wsReal)) return { ok: true }
  if (isUnderOutsideWorkspaceCarveOut(resolvedPath)) return { ok: true }

  const verb = mode === 'mutate' ? 'write/edit' : 'search'
  return {
    ok: false,
    error:
      `Refusing to ${verb} outside the workspace root: "${resolvedPath}" is not under "${workspace}". ` +
      `Allowed exceptions: the session-memory / memory trees and the OS temp directory. ` +
      `Use a workspace-relative path, or set ${
        mode === 'mutate'
          ? 'POLE_ALLOW_OUTSIDE_WORKSPACE_WRITES=1'
          : 'POLE_ALLOW_OUTSIDE_WORKSPACE_SEARCH=1'
      } to opt out (not recommended).`,
  }
}

export function pathHasDangerousDirectorySegment(resolvedPath: string): boolean {
  for (const seg of pathSegmentsForDangerCheck(resolvedPath)) {
    if (DANGEROUS_DIRECTORY_SEGMENT_NAMES.has(normalizeCaseForComparison(seg))) {
      return true
    }
  }
  return false
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
const ALLOWED_BINARY_EXT = new Set(['.pdf', ...IMAGE_EXT])

// 已迁移到 constants/files.ts 的 BLOCKED_READ_EXTENSIONS
const BLOCKED_READ_EXT = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.o',
  '.a',
  '.lib',
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.wasm',
  '.class',
  '.pyc',
  '.pyo',
  '.sqlite',
  '.db',
  '.mdb',
  '.iso',
  '.dmg',
  '.img',
])

const UNIX_DEVICE_RES = [
  /^\/dev\/(zero|random|urandom|null|full|stdin|stdout|stderr|tty|console|fd)$/i,
  /^\/proc\/self\/fd\/[0-2]$/i,
  /^\/proc\/\d+\/fd\/[0-2]$/i,
]

function normalizeForCheck(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase()
}

/**
 * UNC `\\server\share` or `//server/share` — avoid fs ops that trigger SMB auth (NTLM leak risk).
 */
export function isUncOrSmbStylePath(raw: string, resolved: string): boolean {
  const t = raw.trim()
  if (t.startsWith('\\\\') || t.startsWith('//')) return true
  const r = resolved.trim()
  if (r.startsWith('\\\\')) return true
  const n = normalizeForCheck(r)
  if (n.startsWith('\\\\?\\unc\\')) return true
  if (n.startsWith('\\\\.\\')) return true
  return false
}

export function isBlockedUnixStyleDevicePath(resolved: string): boolean {
  const posix = resolved.replace(/\\/g, '/')
  for (const re of UNIX_DEVICE_RES) {
    if (re.test(posix)) return true
  }
  return false
}

export function isBlockedBinaryExtensionForRead(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  if (!ext || ALLOWED_BINARY_EXT.has(ext)) return false
  return BLOCKED_READ_EXT.has(ext)
}

export type FileToolGate = { ok: true } | { ok: false; error: string }

/** Ordered §5.6 read checks (first failure wins; for tests / telemetry). */
export const FILE_READ_PATH_VALIDATION_STEP_IDS = [
  'shell_expansion',
  'unc_smb',
  'unix_device',
  'binary_extension',
  'sensitive_basename',
] as const

/** Ordered §5.6 mutate checks after read-equivalent guards. */
export const FILE_MUTATE_PATH_VALIDATION_STEP_IDS = [
  'shell_expansion',
  'glob_metachar',
  'unc_smb',
  'unix_device',
  'sensitive_basename',
  'protected_directory_segment',
  'workspace_boundary',
] as const

/**
 * Pre-flight for read_file: UNC/device/binary extension.
 */
export function gateFileReadPath(rawInput: string, resolvedPath: string): FileToolGate {
  const sessionGate = gateSessionMemoryInternalAgentPath(resolvedPath, 'read')
  if (!sessionGate.ok) return sessionGate

  if (rawPathContainsSuspiciousExpansion(rawInput)) {
    return {
      ok: false,
      error:
        'Refusing path that contains shell-style expansion or command substitution (report §5.6). Use a literal workspace-relative path.',
    }
  }
  if (isUncOrSmbStylePath(rawInput, resolvedPath)) {
    return {
      ok: false,
      error:
        'Refusing to access UNC/SMB or device-namespace paths from the read tool (Windows NTLM / auth risk). Use a workspace-local path or map the share to a drive letter first.',
    }
  }
  if (isBlockedUnixStyleDevicePath(resolvedPath)) {
    return {
      ok: false,
      error: 'Refusing to read a blocked device/special path (OpenClaude-style device file guard).',
    }
  }
  if (isBlockedBinaryExtensionForRead(resolvedPath)) {
    return {
      ok: false,
      error: `Refusing to read binary file type (${path.extname(resolvedPath)}). Use a text source, image, PDF, SVG, or Notebook tool path as appropriate.`,
    }
  }
  if (isDangerousSensitiveFileBasename(resolvedPath)) {
    return {
      ok: false,
      error:
        'Refusing to read a report §5.9 sensitive file (.gitconfig, .mcp.json, .claude.json, shell profiles, etc.).',
    }
  }
  return { ok: true }
}

/**
 * Pre-flight for write/edit: same UNC/device guards (binary extension less critical for writes).
 */
export function gateFileMutatePath(rawInput: string, resolvedPath: string): FileToolGate {
  const sessionGate = gateSessionMemoryInternalAgentPath(resolvedPath, 'mutate')
  if (!sessionGate.ok) return sessionGate

  if (rawPathContainsSuspiciousExpansion(rawInput)) {
    return {
      ok: false,
      error:
        'Refusing path that contains shell-style expansion or command substitution (report §5.6). Use a literal workspace-relative path.',
    }
  }
  if (rawMutatePathContainsGlobMetachar(rawInput)) {
    return {
      ok: false,
      error:
        'Refusing write/edit path that contains glob metacharacters (* or ?) in the raw path (report §5.6). Use a single concrete file path.',
    }
  }
  if (isUncOrSmbStylePath(rawInput, resolvedPath)) {
    return {
      ok: false,
      error:
        'Refusing to write via UNC/SMB or device-namespace paths (Windows auth / safety). Use a workspace-local path.',
    }
  }
  if (isBlockedUnixStyleDevicePath(resolvedPath)) {
    return {
      ok: false,
      error: 'Refusing to write to a blocked device/special path.',
    }
  }
  if (isDangerousSensitiveFileBasename(resolvedPath)) {
    return {
      ok: false,
      error:
        'Refusing to write a report §5.9 sensitive file (.gitconfig, .mcp.json, .claude.json, shell profiles, etc.).',
    }
  }
  if (
    pathHasDangerousDirectorySegment(resolvedPath) &&
    !isUnderSessionMemoryWritableRoot(resolvedPath) &&
    !isResolvedPathInKnownMemoryWritableTree(resolvedPath)
  ) {
    return {
      ok: false,
      error:
        'Refusing to write under a report §5.9 protected directory segment (.git, .vscode, .idea, .claude). ' +
        'Allowed under `.claude` only for memory/session/agent-memory trees (see memory path gate).',
    }
  }
  const boundaryGate = gateWorkspaceBoundary(resolvedPath, 'mutate')
  if (!boundaryGate.ok) return boundaryGate
  return { ok: true }
}
