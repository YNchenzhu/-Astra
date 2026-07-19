/**
 * Sandbox configuration manager for Electron shell execution.
 *
 * Architecture note: upstream uses @anthropic-ai/sandbox-runtime (OS-level
 * isolation via bubblewrap/sandbox-exec on Linux/macOS). This Electron app
 * runs primarily on Windows where those primitives are unavailable, so we
 * implement equivalent policy enforcement at the application layer:
 *
 * - Filesystem allow/deny lists (enforced by path validation before exec)
 * - Network domain allow/deny (enforced by WebFetch policy)
 * - Excluded commands (commands that bypass sandbox wrapping)
 * - Ignored violation patterns (suppressed warnings for known-safe ops)
 *
 * @module sandbox-config
 */

import { execSync } from 'node:child_process'
import path from 'node:path'
import {
  getSecurityWorkspaceRoots,
  hasSecurityWorkspaceRoot,
} from '../../security/workspaceAccess'
import { shutdownAsrtIfRunning } from './asrtAdapter'
import { resolveRipgrepBin } from '../ripgrepBin'

// ============================================================================
// Types
// ============================================================================

export interface SandboxFilesystemConfig {
  allowRead: string[]
  denyRead: string[]
  allowWrite: string[]
  denyWrite: string[]
}

export interface SandboxNetworkConfig {
  allowedDomains: string[]
  deniedDomains: string[]
  allowUnixSockets: boolean
  allowLocalBinding: boolean
}

export interface SandboxRipgrepConfig {
  command: string
  args: string[]
}

export interface SandboxConfig {
  enabled: boolean
  failIfUnavailable: boolean
  filesystem: SandboxFilesystemConfig
  network: SandboxNetworkConfig
  excludedCommands: string[]
  ignoreViolations: string[]
  enableWeakerNestedSandbox: boolean
  ripgrep?: SandboxRipgrepConfig
}

export interface SandboxViolationEvent {
  timestamp: number
  command: string
  violationType: 'filesystem' | 'network' | 'policy'
  details: string
  ignored: boolean
}

export interface SandboxDependencyCheck {
  errors: string[]
  warnings: string[]
}

export type SandboxAskCallback = (hostPattern: { host: string; port?: number }) => Promise<boolean>

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: false,
  failIfUnavailable: false,
  filesystem: {
    allowRead: [],
    denyRead: [],
    allowWrite: [],
    denyWrite: [],
  },
  network: {
    allowedDomains: [],
    deniedDomains: [],
    allowUnixSockets: false,
    allowLocalBinding: false,
  },
  excludedCommands: [],
  ignoreViolations: [],
  enableWeakerNestedSandbox: false,
}

// ============================================================================
// State
// ============================================================================

let config: SandboxConfig = { ...DEFAULT_CONFIG }
let violationLog: SandboxViolationEvent[] = []
const MAX_VIOLATION_LOG = 500

type SandboxConfigListener = (next: Readonly<SandboxConfig>) => void
const sandboxConfigListeners = new Set<SandboxConfigListener>()

function notifySandboxConfigListeners(next: Readonly<SandboxConfig>): void {
  for (const fn of sandboxConfigListeners) {
    try {
      fn(next)
    } catch (e) {
      console.warn('[sandbox-config] listener failed:', e)
    }
  }
}

/** upstream §10.4-style init hook — subscribe to merged sandbox config updates. */
export function subscribeSandboxConfig(listener: SandboxConfigListener): () => void {
  sandboxConfigListeners.add(listener)
  return () => {
    sandboxConfigListeners.delete(listener)
  }
}

// ============================================================================
// Helpers — sensitive path constants (Windows + cross-platform)
// ============================================================================

/**
 * Paths that should always be denied write access, analogous to
 * upstream's settings.json and .claude/skills protection.
 */
function getProtectedPaths(): string[] {
  const protectedPaths: string[] = []

  // Electron app user data directory (contains settings, credentials).
  // Require lazily so this protection list still builds in unit tests
  // where `electron` isn't present.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron')
    if (app) {
      protectedPaths.push(app.getPath('userData'))
    }
  } catch {
    // Not in Electron main process
  }

  // OS-level sensitive paths (Windows)
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    protectedPaths.push(
      systemRoot,
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
    )
    const userProfile = process.env.USERPROFILE
    if (userProfile) {
      protectedPaths.push(
        `${userProfile}\\.ssh`,
        `${userProfile}\\.aws`,
        `${userProfile}\\.kube`,
        `${userProfile}\\.docker`,
      )
    }
  } else {
    // Unix-like
    protectedPaths.push(
      '/etc/shadow',
      '/etc/sudoers',
      '/root/.ssh',
      '/proc',
      '/sys',
      '/dev',
    )
    const home = process.env.HOME
    if (home) {
      protectedPaths.push(
        `${home}/.ssh`,
        `${home}/.aws`,
        `${home}/.kube`,
        `${home}/.docker`,
      )
    }
  }

  return protectedPaths
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize or update the sandbox configuration.
 * Merges with defaults so partial configs are supported.
 */
export function setSandboxConfig(partial: Partial<SandboxConfig>): SandboxConfig {
  const wasEnabled = config.enabled
  config = {
    enabled: partial.enabled ?? config.enabled,
    failIfUnavailable: partial.failIfUnavailable ?? config.failIfUnavailable,
    filesystem: {
      ...config.filesystem,
      ...(partial.filesystem ?? {}),
    },
    network: {
      ...config.network,
      ...(partial.network ?? {}),
    },
    excludedCommands: partial.excludedCommands ?? config.excludedCommands,
    ignoreViolations: partial.ignoreViolations ?? config.ignoreViolations,
    enableWeakerNestedSandbox: partial.enableWeakerNestedSandbox ?? config.enableWeakerNestedSandbox,
    ripgrep: partial.ripgrep ?? config.ripgrep,
  }

  // Always protect OS-sensitive paths from write access
  const protectedPaths = getProtectedPaths()
  for (const p of protectedPaths) {
    if (!config.filesystem.denyWrite.includes(p)) {
      config.filesystem.denyWrite.push(p)
    }
  }

  // When workspace is open, allow write within workspace roots
  if (hasSecurityWorkspaceRoot()) {
    const roots = getSecurityWorkspaceRoots()
    for (const root of roots) {
      if (!config.filesystem.allowWrite.includes(root)) {
        config.filesystem.allowWrite.push(root)
      }
    }
  }

  if (wasEnabled && !config.enabled) {
    void shutdownAsrtIfRunning().catch(() => {
      /* ignore */
    })
  }

  notifySandboxConfigListeners(config)
  return config
}

/** Get the current sandbox configuration. */
export function getSandboxConfig(): Readonly<SandboxConfig> {
  return config
}

/** Check if sandbox enforcement is active. */
export function isSandboxEnabled(): boolean {
  return config.enabled
}

/**
 * Check if a filesystem path is denied for the given operation.
 *
 * Policy: denyWrite > allowWrite > denyRead > allowRead
 * A path is allowed for write only if it matches allowWrite and not denyWrite.
 */
export function isPathDeniedForOperation(
  resolvedPath: string,
  operation: 'read' | 'write',
): { denied: boolean; reason: string } {
  const normalized = resolvedPath.toLowerCase().replace(/\\/g, '/')

  // Check deny lists first (deny takes precedence)
  const denyList = operation === 'write'
    ? config.filesystem.denyWrite
    : config.filesystem.denyRead

  for (const pattern of denyList) {
    const normPattern = pattern.toLowerCase().replace(/\\/g, '/')
    if (pathMatchesPattern(normalized, normPattern)) {
      return {
        denied: true,
        reason: `Path "${resolvedPath}" is denied for ${operation} (matched deny pattern: ${pattern})`,
      }
    }
  }

  // For write operations, also check that path is in allow list
  if (operation === 'write' && config.filesystem.allowWrite.length > 0) {
    let allowed = false
    for (const pattern of config.filesystem.allowWrite) {
      const normPattern = pattern.toLowerCase().replace(/\\/g, '/')
      if (pathMatchesPattern(normalized, normPattern)) {
        allowed = true
        break
      }
    }
    if (!allowed) {
      return {
        denied: true,
        reason: `Path "${resolvedPath}" is not in the allowed write list`,
      }
    }
  }

  return { denied: false, reason: '' }
}

/**
 * Check if a command is in the excluded list (should bypass sandbox wrapping).
 */
export function isCommandExcluded(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

  for (const excluded of config.excludedCommands) {
    // Support pattern matching: "npm run test:*" matches "npm run test:unit"
    const regexPattern = excluded
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '.*')
    const re = new RegExp(`^${regexPattern}$`)
    if (re.test(trimmed)) return true
  }
  return false
}

/**
 * Add a command to the excluded commands list.
 */
export function addToExcludedCommands(command: string): void {
  const normalized = command.trim()
  if (normalized && !config.excludedCommands.includes(normalized)) {
    config.excludedCommands.push(normalized)
  }
}

/**
 * Record a sandbox violation event.
 */
export function recordViolation(event: Omit<SandboxViolationEvent, 'timestamp' | 'ignored'>): SandboxViolationEvent {
  const violation: SandboxViolationEvent = {
    ...event,
    timestamp: Date.now(),
    ignored: config.ignoreViolations.some((pattern) => {
      const re = new RegExp(
        pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*'),
      )
      return re.test(event.details)
    }),
  }

  violationLog.push(violation)
  if (violationLog.length > MAX_VIOLATION_LOG) {
    violationLog = violationLog.slice(-MAX_VIOLATION_LOG)
  }

  return violation
}

/**
 * Get recent violation events.
 */
export function getViolations(options?: { includeIgnored?: boolean; limit?: number }): SandboxViolationEvent[] {
  const includeIgnored = options?.includeIgnored ?? false
  const limit = options?.limit ?? 50

  const filtered = includeIgnored
    ? violationLog
    : violationLog.filter((v) => !v.ignored)

  return filtered.slice(-limit)
}

/**
 * Clear the violation log.
 */
export function clearViolations(): void {
  violationLog = []
}

/**
 * Check if a dependency (command) is available on the system.
 * Analogous to upstream's checkDependencies() for bwrap/socat/rg.
 */
export function checkCommandDependency(command: string): boolean {
  try {
    const isWindows = process.platform === 'win32'
    const cmd = isWindows ? `where ${command}` : `which ${command}`
    execSync(cmd, { stdio: 'pipe', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

/**
 * Check sandbox dependency availability.
 * On Linux/macOS, checks for bubblewrap (bwrap) and socat.
 * On Windows, returns no errors since we use app-level sandbox.
 */
export function checkSandboxDependencies(): SandboxDependencyCheck {
  const result: SandboxDependencyCheck = { errors: [], warnings: [] }

  if (process.platform === 'linux') {
    if (!checkCommandDependency('bwrap')) {
      result.errors.push('bubblewrap (bwrap) not found — install via your package manager')
    }
    if (!checkCommandDependency('socat')) {
      result.warnings.push('socat not found — network proxy features disabled')
    }
  } else if (process.platform === 'darwin') {
    // macOS sandbox-exec is built-in, but check for ripgrep. The bundled
    // @vscode/ripgrep binary (absolute path) satisfies this without PATH rg.
    if (!path.isAbsolute(resolveRipgrepBin()) && !checkCommandDependency('rg')) {
      result.warnings.push('ripgrep (rg) not found — glob/grep tools will use Node.js fallback')
    }
  }

  return result
}

/**
 * Reset sandbox state to defaults.
 */
export function resetSandboxConfig(): void {
  config = { ...DEFAULT_CONFIG }
  violationLog = []
}

/**
 * Pattern matching for filesystem paths.
 * Supports glob-like patterns: ** (recursive), * (single segment), ? (single char).
 */
function pathMatchesPattern(path: string, pattern: string): boolean {
  // Exact match
  if (path === pattern) return true

  // Handle ** recursive glob
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3)
    return path === prefix || path.startsWith(prefix + '/')
  }

  // Handle * wildcard (non-recursive)
  if (pattern.includes('*')) {
    const regexPattern = pattern
      .replace(/[.?+^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*\*/g, '__DOUBLE_STAR__')
      .replace(/\\\*/g, '[^/]*')
      .replace(/__DOUBLE_STAR__/g, '.*')
    const re = new RegExp(`^${regexPattern}$`)
    return re.test(path)
  }

  return false
}
