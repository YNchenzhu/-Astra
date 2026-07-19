/**
 * Command wrapper and policy enforcement for sandboxed shell execution.
 *
 * upstream wraps commands via BaseSandboxManager.wrapWithSandbox() which
 * uses OS-level primitives (bubblewrap bwrap on Linux, sandbox-exec on macOS).
 * This module provides equivalent enforcement at the application layer for
 * Electron/Windows, plus a unified interface that delegates to the existing
 * shellRunner.ts for actual execution.
 *
 * Key responsibilities:
 * 1. Pre-execution command validation (blocked patterns, path resolution)
 * 2. Environment variable sanitization (minimal env for sandbox mode)
 * 3. Violation recording and stderr annotation
 * 4. Excluded command bypass logic
 *
 * @module sandbox-command
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolResult } from '../../tools/types'
import { getAgentContext } from '../../agents/agentContext'
import { getToolUseExecutionContext } from '../../agents/toolUseContext'
import { taskRuntimeStore } from '../../tools/TaskRuntimeStore'
import {
  registerForegroundShell,
  trackShellProcess,
  completeShellTask,
  failShellTask,
  startShellStallWatchdog,
} from '../../tools/tasks/ShellTaskManager'
import { killProcessTree } from '../../tools/tasks/killProcessTree'
import {
  isSandboxEnabled,
  isCommandExcluded,
  recordViolation,
  getSandboxConfig,
} from './sandbox-config'
import { rewriteWindowsNullRedirectForShell, runPosixShellCommand } from '../../tools/shellRunner'
import { formatShellFailure, formatShellSpawnError } from '../../tools/shellErrorFormat'
import { getPrimaryWorkspaceRoot } from '../../security/workspaceAccess'
import { resolveSandboxWrappedCommandLine, cleanupAfterAsrtCommand } from './asrtAdapter'
export { wrapWithSandbox } from './sandboxPrimitiveWrap'

// ============================================================================
// Types
// ============================================================================

export interface SandboxCommandOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** Skip sandbox enforcement even when enabled */
  bypassSandbox?: boolean
  /** Custom command label for violation tracking */
  label?: string
  /** When true, use tracked background shell with the same wrapped command + sandbox env */
  runInBackground?: boolean
}

export interface SandboxCommandResult extends ToolResult {
  /** Whether sandbox enforcement was applied */
  sandboxed: boolean
  /** Violations detected during execution */
  violations?: string[]
}

// ============================================================================
// Blocked command patterns (analogous to upstream's blocked patterns)
// ============================================================================

const BLOCKED_COMMAND_PATTERNS = [
  // PowerShell abuse
  /\binvoke-expression\b/i,
  /\biex\s*\(/i,
  /\bdownloadstring\b/i,
  /\bdownloadfile\b/i,
  /\bpowershell\s+(-enc|-e\s)\b/i,
  // Remote code execution
  /\bbash\s+-c\s+"\$\(curl\b/i,
  /\bbash\s+-c\s+"\$\(wget\b/i,
  // Windows binary abuse
  /\bregsvr32\s/i,
  /\bmshta\s/i,
  /\brandll32\s/i,
  /\bcertutil\s+-urlcache\b/i,
  /\bstart-bitstransfer\b/i,
  // Base64 decode and execute
  /\bfrombase64string\b/i,
]

// ============================================================================
// Environment
// ============================================================================

/**
 * Create a minimal environment for sandboxed execution.
 * Analogous to upstream's subprocessShellEnv() with ASTRA_SHELL_SANDBOX=1.
 */
function createSandboxEnv(): Record<string, string> {
  const base = process.env as Record<string, string>
  const minimal: Record<string, string> = {
    PATH: base.PATH || base.Path || getDefaultPath(),
    PATHEXT: base.PATHEXT || '',
    SystemRoot: base.SystemRoot || '',
    WINDIR: base.WINDIR || '',
    TEMP: base.TEMP || base.TMP || getSystemTempDir(),
    TMP: base.TMP || base.TEMP || getSystemTempDir(),
    HOME: base.HOME || base.USERPROFILE || '',
    USERPROFILE: base.USERPROFILE || '',
    // Signal sandbox mode to child processes
    CLAUDECODE: '1',
    ASTRA: '1',
    ASTRA_SHELL_SANDBOX: '1',
  }

  // Prevent git from using interactive editor
  minimal.GIT_EDITOR = 'true'
  // Force UTF-8 on Windows
  if (process.platform === 'win32') {
    minimal.PYTHONIOENCODING = 'utf-8'
    minimal.PYTHONUTF8 = '1'
  }

  return minimal
}

function getDefaultPath(): string {
  if (process.platform === 'win32') {
    return 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem'
  }
  return '/usr/local/bin:/usr/bin:/bin'
}

function getSystemTempDir(): string {
  return process.env.TEMP || process.env.TMP || (process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp')
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a command string against blocked patterns.
 * Returns { ok: false, reason } if blocked, { ok: true } if allowed.
 */
export function validateSandboxCommand(
  command: string,
): { ok: true } | { ok: false; reason: string } {
  const trimmed = command.trim()
  if (!trimmed) {
    return { ok: false, reason: 'Command is empty' }
  }

  // Check blocked patterns
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        reason: `Command matches blocked pattern: ${pattern.source}`,
      }
    }
  }

  return { ok: true }
}

/**
 * Validate cwd is within allowed workspace paths.
 */
function validateCwd(cwd: string): { ok: true } | { ok: false; reason: string } {
  if (!cwd) return { ok: true }

  const resolved = path.resolve(cwd)
  const workspaceRoot = getPrimaryWorkspaceRoot()
  if (!workspaceRoot) return { ok: true }

  const normResolved = resolved.toLowerCase().replace(/\\/g, '/')
  const normRoot = workspaceRoot.toLowerCase().replace(/\\/g, '/')
  const prefix = normRoot.endsWith('/') ? normRoot : normRoot + '/'

  if (normResolved === normRoot || normResolved.startsWith(prefix)) {
    return { ok: true }
  }

  return {
    ok: false,
    reason: `CWD "${cwd}" is outside workspace root`,
  }
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute a command with sandbox policy enforcement.
 *
 * If sandbox is not enabled, or command is excluded, delegates to
 * shellRunner.runPosixShellCommand() without wrapping.
 *
 * If sandbox is enabled, applies:
 * - Environment variable sanitization
 * - Blocked pattern validation
 * - CWD workspace validation
 * - Violation recording
 *
 * @returns SandboxCommandResult with enforcement metadata
 */
export async function runSandboxedCommand(
  command: string,
  options?: SandboxCommandOptions,
): Promise<SandboxCommandResult> {
  const bypass = options?.bypassSandbox ?? false
  const enabled = isSandboxEnabled() && !bypass

  // If sandbox not enabled or command excluded, run without wrapping
  if (!enabled || isCommandExcluded(command)) {
    return runWithoutSandbox(command, options)
  }

  return runWithSandbox(command, options)
}

/**
 * Execute without sandbox enforcement (fallback path).
 * Uses the existing shellRunner execution logic.
 */
async function runWithoutSandbox(
  command: string,
  options?: SandboxCommandOptions,
): Promise<SandboxCommandResult> {
  const result = await runPosixShellCommand(command, options?.cwd, {
    timeoutMs: options?.timeoutMs,
    runInBackground: options?.runInBackground,
  })

  return {
    ...result,
    sandboxed: false,
  }
}

/**
 * Execute with sandbox enforcement.
 */
async function runWithSandbox(
  command: string,
  options?: SandboxCommandOptions,
): Promise<SandboxCommandResult> {
  const violations: string[] = []

  // Step 1: Validate command against blocked patterns
  const cmdValidation = validateSandboxCommand(command)
  if (!cmdValidation.ok) {
    recordViolation({
      command,
      violationType: 'policy',
      details: cmdValidation.reason,
    })
    return {
      success: false,
      error: `Sandbox policy blocked command: ${cmdValidation.reason}`,
      sandboxed: true,
      violations: [cmdValidation.reason],
    }
  }

  // Step 2: Validate cwd
  const cwd = options?.cwd || getPrimaryWorkspaceRoot() || process.cwd()
  const cwdValidation = validateCwd(cwd)
  if (!cwdValidation.ok) {
    recordViolation({
      command,
      violationType: 'filesystem',
      details: cwdValidation.reason,
    })
    return {
      success: false,
      error: `Sandbox filesystem blocked: ${cwdValidation.reason}`,
      sandboxed: true,
      violations: [cwdValidation.reason],
    }
  }

  // Step 3: Create sandbox environment
  const sandboxEnv = options?.env ?? createSandboxEnv()

  const cmd = rewriteWindowsNullRedirectForShell(command)
  const { cmdLine, useAsrtCleanup } = await resolveSandboxWrappedCommandLine(cmd)
  const timeout = Math.max(1000, Math.min(600_000, options?.timeoutMs ?? 120_000))

  if (options?.runInBackground) {
    const result = await runPosixShellCommand(cmdLine, cwd, {
      runInBackground: true,
      timeoutMs: timeout,
      envOverride: sandboxEnv,
    })
    void cleanupAfterAsrtCommand(useAsrtCleanup)
    cleanupAfterSandboxCommand(cwd)
    return {
      ...result,
      sandboxed: true,
    }
  }

  // Windows: ASRT and bubblewrap don't exist, astraPrimitiveWrap is a no-op
  // (see sandboxPrimitiveWrap.ts:17–19), so `cmdLine` is the raw user command.
  // Spawning with `shell: true` below would route it through cmd.exe, which
  // can't run POSIX commands (`grep`, `wc`, `head`, `2>/dev/null`, …) and exits
  // silently with no captured output because `2>/dev/null` swallows cmd's own
  // "is not recognized" stderr into a literal `\dev\null` file. Delegate to
  // runPosixShellCommand so getToolShellSpawnSpec can pick Git Bash for POSIX
  // idioms, matching the non-sandbox path and the runInBackground branch above.
  if (process.platform === 'win32') {
    const result = await runPosixShellCommand(cmdLine, cwd, {
      timeoutMs: timeout,
      envOverride: sandboxEnv,
    })
    void cleanupAfterAsrtCommand(useAsrtCleanup)
    cleanupAfterSandboxCommand(cwd)
    return {
      ...result,
      sandboxed: true,
    }
  }

  let child: ChildProcess
  try {
    child = spawn(cmdLine, [], {
      cwd,
      shell: true,
      env: sandboxEnv,
      windowsHide: true,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    recordViolation({
      command,
      violationType: 'policy',
      details: `Spawn failed: ${msg}`,
    })
    return {
      success: false,
      error: `Sandbox spawn failed: ${msg}`,
      sandboxed: true,
    }
  }

  return new Promise((resolve) => {
    const label = options?.label ?? 'bash'
    // When invoked inside an agent tool_use, reuse the `toolUseId` as the
    // runtime task id so that cancel / retry / output-slice calls from the
    // renderer (which only know toolUseId) resolve to this shell's
    // stopHandler and kill the child process. Without this the sandbox
    // generated its own `sandbox-<label>-...` id and the renderer's
    // `ai:stop-task` would silently miss the handler.
    const toolUseId = getToolUseExecutionContext()?.toolUseId ?? null
    const taskId = toolUseId || `sandbox-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const commandEcho = cmdLine.length > 400 ? `${cmdLine.slice(0, 400)}…` : cmdLine

    let stdout = ''
    let stderr = ''
    let settled = false

    const resolveOnce = (result: SandboxCommandResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    taskRuntimeStore.start(taskId, 'bash')
    taskRuntimeStore.append(taskId, 'meta', `Sandbox ${label}: ${commandEcho}\n`)

    const startedAt = Date.now()
    const ownerAgentId = getAgentContext()?.agentId
    registerForegroundShell(taskId, commandEcho, ownerAgentId)
    trackShellProcess(taskId, child)
    startShellStallWatchdog(taskId, commandEcho)

    const killTimer = setTimeout(() => {
      killProcessTree(child)
    }, timeout)

    taskRuntimeStore.setStopHandler(taskId, () => {
      killProcessTree(child)
    })

    // Forward agent-level abort (e.g. main chat `ai:cancel` → cancelStream
    // → agentic signal) to the child shell. Without this the shell would
    // keep running until it finishes naturally even after the user
    // cancelled the turn.
    const agentSignal = getAgentContext()?.signal
    const onAbort = () => {
      killProcessTree(child)
    }
    if (agentSignal) {
      if (agentSignal.aborted) {
        onAbort()
      } else {
        agentSignal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8')
      stdout += text
      taskRuntimeStore.append(taskId, 'stdout', text)
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8')
      stderr += text
      taskRuntimeStore.append(taskId, 'stderr', text)
    })

    child.on('close', (code, signal) => {
      clearTimeout(killTimer)
      taskRuntimeStore.clearStopHandler(taskId)
      if (agentSignal) {
        try { agentSignal.removeEventListener('abort', onAbort) } catch { /* ignore */ }
      }
      void cleanupAfterAsrtCommand(useAsrtCleanup)
      cleanupAfterSandboxCommand(cwd)

      if (settled) return

      const exitCode = code ?? 1
      const durationMs = Date.now() - startedAt

      // Annotate stderr with sandbox failure information
      const annotatedStderr = annotateStderrWithSandboxFailures(cmd, stderr)
      if (annotatedStderr !== stderr) {
        violations.push('Sandbox execution violations detected')
      }

      const output = stdout.trim() || stderr.trim() || '(no output)'

      if (exitCode === 0) {
        taskRuntimeStore.markCompleted(taskId, { exitCode })
      } else {
        taskRuntimeStore.markFailed(taskId, `Exit code ${exitCode}`)
      }
      completeShellTask(taskId, exitCode)

      if (exitCode === 0) {
        resolveOnce({
          success: true,
          output: `Task ID: ${taskId}\n${output}`,
          sandboxed: true,
          violations: violations.length > 0 ? violations : undefined,
        })
      } else {
        resolveOnce({
          success: false,
          ...formatShellFailure({
            taskId,
            exitCode,
            signal,
            stderr: annotatedStderr,
            stdout,
            commandEcho,
            durationMs,
          }),
          sandboxed: true,
          violations: violations.length > 0 ? violations : undefined,
        })
      }
    })

    child.on('error', (error) => {
      clearTimeout(killTimer)
      taskRuntimeStore.clearStopHandler(taskId)
      void cleanupAfterAsrtCommand(useAsrtCleanup)
      cleanupAfterSandboxCommand(cwd)
      recordViolation({
        command,
        violationType: 'policy',
        details: `Execution error: ${error.message}`,
      })
      if (!settled) {
        taskRuntimeStore.markFailed(taskId, error.message)
        failShellTask(taskId, error.message)
        resolveOnce({
          success: false,
          ...formatShellSpawnError({ taskId, error, commandEcho }),
          sandboxed: true,
        })
      }
    })
  })
}

/**
 * Annotate stderr with sandbox-specific failure information.
 * Analogous to upstream's annotateStderrWithSandboxFailures().
 *
 * Parses common sandbox failure patterns and adds human-readable context.
 */
export function annotateStderrWithSandboxFailures(
  command: string,
  stderr: string,
): string {
  if (!stderr) return stderr

  const annotations: string[] = []

  // Linux bubblewrap failure patterns
  if (stderr.includes('bwrap:')) {
    if (stderr.includes('permissions')) {
      annotations.push('[sandbox] Operation blocked by filesystem policy')
    }
    if (stderr.includes('Network')) {
      annotations.push('[sandbox] Operation blocked by network policy')
    }
  }

  // Windows path outside workspace
  if (stderr.includes('outside') && stderr.includes('workspace')) {
    annotations.push('[sandbox] Path is outside allowed workspace')
  }

  // Permission denied
  if (stderr.includes('Permission denied') || stderr.includes('Access is denied')) {
    const config = getSandboxConfig()
    if (config.enabled) {
      annotations.push('[sandbox] Access denied by sandbox policy — check allowWrite/denyWrite config')
    }
  }

  if (annotations.length > 0) {
    return `${stderr}\n\n${annotations.join('\n')}`
  }

  return stderr
}

/**
 * Cleanup after a sandboxed command completes.
 * Analogous to upstream's cleanupAfterCommand() which scrubs bare git files.
 */
export function cleanupAfterSandboxCommand(cwd?: string): void {
  if (!cwd) return

  // Check for planted bare git repo files (sandbox escape vector)
  // See upstream bareGitRepoScrubPaths logic
  const gitFiles = ['HEAD', 'objects', 'refs']
  try {
    for (const gitFile of gitFiles) {
      const filePath = path.join(cwd, gitFile)
      try {
        const stat = fs.statSync(filePath)
        // Only remove if it's a file (not a directory — real .git is a dir)
        if (stat.isFile()) {
          fs.unlinkSync(filePath)
        }
      } catch {
        // File doesn't exist, nothing to clean
      }
    }
  } catch {
    // fs not available, skip cleanup
  }
}
