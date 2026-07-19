/**
 * Central shell execution (upstream-style spawn, windowsHide, task tracking).
 * Bash uses the default system shell; PowerShell uses `powershell.exe` on Windows.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { ToolResult } from './types'
import { killProcessTree } from './tasks/killProcessTree'
import { getAgentContext } from '../agents/agentContext'
import { getToolUseExecutionContext } from '../agents/toolUseContext'
import { taskRuntimeStore } from './TaskRuntimeStore'
import { getWorkspacePath } from './workspaceState'
import {
  getToolShellSpawnSpec,
  WINDOWS_POWERSHELL_UTF8_SESSION,
  encodePowerShellCommand,
} from '../utils/defaultShellSpawn'
import { readDefaultShellId } from '../settings/settingsAccess'
import {
  registerForegroundShell,
  registerBackgroundShellTask,
  trackShellProcess,
  completeShellTask,
  failShellTask,
  completeBackgroundShellTask,
  failBackgroundShellTask,
  startShellStallWatchdog,
} from './tasks/ShellTaskManager'
import { formatShellFailure, formatShellSpawnError } from './shellErrorFormat'
import { buildToolFailure } from './toolErrorFormat'
import { recordToolResourceDelta } from '../orchestration/toolRuntime/state'

/**
 * Cap on the LOCAL stdout/stderr accumulators (audit A-P1-2). The
 * TaskRuntimeStore keeps its own ring-buffered copy for TaskOutput; these
 * strings only feed the final ToolResult / error formatting, so keeping
 * the most recent 4 MB tail is lossless in practice for that purpose.
 */
export const SHELL_LOCAL_BUFFER_MAX_CHARS = 4 * 1024 * 1024

/** CMD-style null redirect breaks POSIX shells on Windows (creates `nul` file). */
export function rewriteWindowsNullRedirectForShell(command: string): string {
  return command
    .replace(/\b2>nul\b/gi, '2>/dev/null')
    .replace(/\b1>nul\b/gi, '1>/dev/null')
}

/**
 * Build a safe environment for shell subprocesses.
 * Windows: inject UTF-8 encoding env vars to prevent mojibake for zh-CN OEM/ANSI code pages.
 */
function subprocessShellEnv(): Record<string, string> {
  const base = process.env as Record<string, string>
  if (process.env.ASTRA_SHELL_SANDBOX === '1') {
    const minimal: Record<string, string> = {
      PATH: base.PATH || base.Path || '/usr/bin:/bin',
      PATHEXT: base.PATHEXT || '',
      SystemRoot: base.SystemRoot || '',
      TEMP: base.TEMP || base.TMP || '/tmp',
      TMP: base.TMP || base.TEMP || '/tmp',
      HOME: base.HOME || base.USERPROFILE || '',
      USERPROFILE: base.USERPROFILE || '',
    }
    minimal.GIT_EDITOR = 'true'
    minimal.CLAUDECODE = '1'
    minimal.ASTRA = '1'
    if (process.platform === 'win32') {
      // Force UTF-8 encoding for all subprocesses
      minimal.PYTHONIOENCODING = minimal.PYTHONIOENCODING || 'utf-8'
      minimal.PYTHONUTF8 = minimal.PYTHONUTF8 || '1'
      // Bash/Git Bash locale settings for Chinese character support
      minimal.LANG = minimal.LANG || 'en_US.UTF-8'
      minimal.LC_ALL = minimal.LC_ALL || 'en_US.UTF-8'
      minimal.LC_CTYPE = minimal.LC_CTYPE || 'UTF-8'
      // Node.js default encoding for stdio
      minimal.NODE_OPTIONS = minimal.NODE_OPTIONS
        ? `${minimal.NODE_OPTIONS} --input-type=module`
        : '--input-type=module'
    }
    return minimal
  }
  const merged: Record<string, string> = {
    ...base,
    GIT_EDITOR: 'true',
    CLAUDECODE: '1',
    ASTRA: '1',
  }
  if (process.platform === 'win32') {
    // Force UTF-8 encoding for all subprocesses — prevents zh-CN GBK mojibake
    if (merged.PYTHONIOENCODING === undefined) merged.PYTHONIOENCODING = 'utf-8'
    if (merged.PYTHONUTF8 === undefined) merged.PYTHONUTF8 = '1'
    // Git Bash / WSL / MSYS2 locale for Chinese character support
    if (merged.LANG === undefined) merged.LANG = 'en_US.UTF-8'
    if (merged.LC_ALL === undefined) merged.LC_ALL = 'en_US.UTF-8'
    if (merged.LC_CTYPE === undefined) merged.LC_CTYPE = 'UTF-8'
    // Java / Go / Ruby default encoding
    if (merged.JAVA_TOOL_OPTIONS === undefined) merged.JAVA_TOOL_OPTIONS = '-Dfile.encoding=UTF-8'
    if (merged.GOPROXY === undefined && process.env.GOPROXY) merged.GOPROXY = process.env.GOPROXY
  }
  return merged
}

export type ShellRunnerOptions = {
  cwd?: string
  runInBackground?: boolean
  timeoutMs?: number
  /** When set, used as the full spawn `env` (e.g. sandbox minimal env). */
  envOverride?: Record<string, string>
  /** Prefix for TaskRuntimeStore task id */
  taskKind?: 'bash' | 'powershell'
}

function runTrackedShell(
  label: string,
  spawnFn: () => ChildProcess,
  commandEcho: string,
  options?: ShellRunnerOptions,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const kind = options?.taskKind ?? 'bash'
    // Prefer the enclosing tool_use id so stop/retry keyed by toolUseId
    // reach this shell's stop handler. Background tasks don't set a
    // tool_use context, so they keep the generated id.
    const toolUseId = !options?.runInBackground
      ? (getToolUseExecutionContext()?.toolUseId ?? null)
      : null
    const taskId = toolUseId || `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const timeout = Math.max(1000, Math.min(600_000, options?.timeoutMs ?? 120_000))
    let settled = false

    const resolveOnce = (result: ToolResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    taskRuntimeStore.start(taskId, 'bash')
    taskRuntimeStore.append(taskId, 'meta', `${label}: ${commandEcho}\n`)

    const startedAt = Date.now()
    const ownerAgentId = getAgentContext()?.agentId

    // Register with the new task system (foreground or background)
    if (!options?.runInBackground) {
      registerForegroundShell(taskId, commandEcho, ownerAgentId)
    } else {
      registerBackgroundShellTask(taskId, commandEcho, ownerAgentId)
    }

    let child: ChildProcess
    try {
      child = spawnFn()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      taskRuntimeStore.markFailed(taskId, msg)
      if (!options?.runInBackground) {
        failShellTask(taskId, msg)
      } else {
        failBackgroundShellTask(taskId, msg)
      }
      return resolveOnce({
        success: false,
        ...formatShellSpawnError({ taskId, error: msg, commandEcho }),
      })
    }

    // Track process for kill support
    trackShellProcess(taskId, child)

    // Audit A-3 wire-up — record this shell child into the per-tool resource
    // delta. Counts one child per successful spawn; future hooks could add
    // sub-spawns when this child fork-execs further (Bash `&` chains spawn
    // descendants, but those aren't visible to Node's spawn surface). Gated
    // on a foreground `toolUseId` because background tasks aren't owned by
    // a particular tool_use slot — recording for them would pollute the
    // delta of whichever tool_use happened to be active when the task was
    // backgrounded.
    if (toolUseId) {
      try {
        recordToolResourceDelta(toolUseId, { shellChildCount: 1 })
      } catch (e) {
        console.warn('[shellRunner] recordToolResourceDelta failed:', e)
      }
    }

    // Start stall watchdog for foreground tasks
    if (!options?.runInBackground) {
      startShellStallWatchdog(taskId, commandEcho)
    }

    // Foreground-only: fires `timeout` after the promise is long-returned
    // for background tasks, killing the long-running job the user
    // explicitly moved to background (audit Bug A5). Background tasks are
    // stoppable via `taskRuntimeStore.setStopHandler` (set below).
    const killTimer: NodeJS.Timeout | null = options?.runInBackground
      ? null
      : setTimeout(() => {
          killProcessTree(child)
        }, timeout)

    taskRuntimeStore.setStopHandler(taskId, () => {
      killProcessTree(child)
    })

    // Forward agent-level abort (main chat cancel / sibling failure abort)
    // to the child shell.
    const agentSignal = getAgentContext()?.signal
    const onAbort = () => {
      killProcessTree(child)
    }
    if (agentSignal && !options?.runInBackground) {
      if (agentSignal.aborted) {
        onAbort()
      } else {
        agentSignal.addEventListener('abort', onAbort, { once: true })
      }
    }
    const detachAgentSignal = () => {
      if (agentSignal && !options?.runInBackground) {
        try { agentSignal.removeEventListener('abort', onAbort) } catch { /* ignore */ }
      }
    }

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false

    // Audit A-P1-2: these local accumulators were unbounded — a chatty
    // long-running command (dev server, verbose build) grew them without
    // limit even though `taskRuntimeStore` ring-buffers its own copy.
    // Keep the TAIL (most recent output is what error formatting needs).
    const appendCapped = (
      current: string,
      text: string,
    ): { value: string; truncated: boolean } => {
      const next = current + text
      if (next.length <= SHELL_LOCAL_BUFFER_MAX_CHARS) {
        return { value: next, truncated: false }
      }
      return { value: next.slice(-SHELL_LOCAL_BUFFER_MAX_CHARS), truncated: true }
    }

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8')
      const r = appendCapped(stdout, text)
      stdout = r.value
      stdoutTruncated = stdoutTruncated || r.truncated
      taskRuntimeStore.append(taskId, 'stdout', text)
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8')
      const r = appendCapped(stderr, text)
      stderr = r.value
      stderrTruncated = stderrTruncated || r.truncated
      taskRuntimeStore.append(taskId, 'stderr', text)
    })

    child.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer)
      taskRuntimeStore.clearStopHandler(taskId)
      detachAgentSignal()
      const exitCode = code ?? 1
      const durationMs = Date.now() - startedAt
      if (exitCode === 0) {
        taskRuntimeStore.markCompleted(taskId, { exitCode })
      } else {
        taskRuntimeStore.markFailed(taskId, `Exit code ${exitCode}`)
      }

      // Update new task system state
      if (!options?.runInBackground) {
        completeShellTask(taskId, exitCode)
      } else {
        completeBackgroundShellTask(taskId, exitCode)
      }

      if (options?.runInBackground) {
        return
      }

      const truncNote =
        stdoutTruncated || stderrTruncated
          ? `\n[note: output exceeded ${SHELL_LOCAL_BUFFER_MAX_CHARS} chars — showing the tail; use TaskOutput(${taskId}) for the buffered history]`
          : ''
      const output = (stdout.trim() || stderr.trim() || '(no output)') + truncNote
      const outputWithTaskId = `Task ID: ${taskId}\n${output}`

      if (exitCode === 0) {
        resolveOnce({
          success: true,
          output: outputWithTaskId,
        })
      } else {
        resolveOnce({
          success: false,
          ...formatShellFailure({
            taskId,
            exitCode,
            signal,
            stderr,
            stdout,
            commandEcho,
            durationMs,
          }),
        })
      }
    })

    child.on('error', (error) => {
      if (killTimer) clearTimeout(killTimer)
      taskRuntimeStore.clearStopHandler(taskId)
      detachAgentSignal()
      taskRuntimeStore.markFailed(taskId, error.message)
      if (!options?.runInBackground) {
        failShellTask(taskId, error.message)
      } else {
        failBackgroundShellTask(taskId, error.message)
      }
      if (options?.runInBackground) {
        return
      }
      resolveOnce({
        success: false,
        ...formatShellSpawnError({ taskId, error, commandEcho }),
      })
    })

    if (options?.runInBackground) {
      resolveOnce({
        success: true,
        output: `Started background task ${taskId}. Use TaskOutput with task_id=${taskId} to read output.`,
      })
    }
  })
}

/**
 * Resolve the effective working directory for shell tools.
 * Priority: explicit cwd → workspace root → process.cwd().
 * process.cwd() in a packaged Electron app is the install dir (e.g. E:\Program Files\astra\)
 * which is almost never what the AI intends — so workspace must be checked first.
 */
function resolveEffectiveShellCwd(explicitCwd?: string): string {
  if (explicitCwd && explicitCwd.trim()) return explicitCwd.trim()
  const ws = getWorkspacePath()
  if (ws && ws.trim()) return ws.trim()
  console.warn('[shellRunner] Falling back to process.cwd() — no workspace is open')
  return process.cwd()
}

/**
 * Bash tool execution — same routing as `terminal:exec` / hooks: `getToolShellSpawnSpec` so Windows
 * respects Settings → default terminal and can use Git Bash for POSIX pipelines (`| head`, GNU find, …).
 */
export function runPosixShellCommand(
  command: string,
  cwd?: string,
  options?: ShellRunnerOptions,
): Promise<ToolResult> {
  // Route to getToolShellSpawnSpec (handles per-shell encoding — no CMD wrapper needed here).
  const cmd = rewriteWindowsNullRedirectForShell(command)
  const env = options?.envOverride ?? subprocessShellEnv()
  const spec = getToolShellSpawnSpec(readDefaultShellId(), cmd)
  const effectiveCwd = resolveEffectiveShellCwd(cwd)
  return runTrackedShell(
    'Bash',
    () =>
      spawn(spec.file, spec.args, {
        cwd: effectiveCwd,
        shell: false,
        env,
        windowsHide: true,
      }),
    cmd,
    { ...options, taskKind: 'bash' },
  )
}

/** Windows PowerShell (`-NoProfile -NonInteractive`). No-op fallback message on non-Windows. */
export function runPowerShellCommand(
  command: string,
  cwd?: string,
  options?: ShellRunnerOptions,
): Promise<ToolResult> {
  if (process.platform !== 'win32') {
    return Promise.resolve({
      success: false,
      ...buildToolFailure(
        {
          what: 'PowerShell tool is only available on Windows.',
          context: { platform: process.platform },
          next: 'Use the `bash` tool instead — POSIX shells are available on all platforms.',
        },
        'validation',
      ),
    })
  }
  const exe = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'
  const env = options?.envOverride ?? subprocessShellEnv()
  const psBody = `${WINDOWS_POWERSHELL_UTF8_SESSION}; ${command}`
  // Use `-EncodedCommand` (UTF-16-LE base64) instead of `-Command`. With
  // `-Command`, Node's Windows spawn wraps the argument in double quotes,
  // which causes PowerShell to expand `$_` / `$var` at the outer scope
  // BEFORE running the script — stripping `$_.LineNumber` down to
  // `.LineNumber` inside any ForEach-Object / Where-Object pipeline the
  // caller or AI writes. `-EncodedCommand` bypasses that tokenizer
  // entirely and delivers the script bytes verbatim.
  const encoded = encodePowerShellCommand(psBody)
  const effectiveCwd = resolveEffectiveShellCwd(cwd)
  return runTrackedShell(
    'PowerShell',
    () =>
      spawn(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        cwd: effectiveCwd,
        env,
        windowsHide: true,
      }),
    command,
    { ...options, taskKind: 'powershell' },
  )
}
