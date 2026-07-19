import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { shellSpawnEnv } from '../utils/shellSpawn'
import { readDefaultShellId } from '../settings/settingsAccess'
import { getInteractiveShellSpec, getToolShellSpawnSpec } from '../utils/defaultShellSpawn'
import {
  getPrimaryWorkspaceRoot,
  hasSecurityWorkspaceRoot,
  resolvePathForWorkspaceAccess,
} from '../security/workspaceAccess'
import { getWorkspacePath } from '../tools/workspaceState'
import { validateTerminalExec } from '../security/terminalExecPolicy'
import { validatedHandle } from '../ipc/validatedHandle'
import { forceKillPidTree, forceKillProcessTree } from '../tools/tasks/killProcessTree'
import {
  terminalCloseArgs,
  terminalCreateArgs,
  terminalExecArgs,
  terminalResizeArgs,
  terminalWriteArgs,
} from '../ipc/schemas'

// node-pty: pseudo-terminal for integrated terminal (job control, TUI, resize).
// Loads on Windows too (requires @electron/rebuild for node-pty against Electron ABI).
// If require() or spawn() fails → child_process pipe fallback (see createFallbackSession).
//
// ConPTY vs winpty (Windows only): node-pty defaults to ConPTY on build >= 18309,
// but we force winpty on Windows 10 (build < 22000) — see windowsPtySpawnOptions().
// Win10's in-box ConPTY is frozen (fixes only land in Win11 / Windows Terminal) and
// killing a just-started shell through it crashes the shell host with a WER
// "powershell has stopped working" dialog (observed on 19045 whenever the welcome-
// page terminal is recycled on workspace selection). Env ASTRA_PTY_CONPTY=0/1
// still overrides in both directions.

/** Minimal structural view of the node-pty IPty process we rely on. Only
 *  fields we actually call are declared — additional members pass through
 *  the `Record<string, unknown>` intersection without leaking `any`. */
interface IPtyProcess {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  pid?: number
}

interface PtyModule {
  spawn(
    shell: string,
    args: string[],
    options: {
      name?: string
      cols?: number
      rows?: number
      cwd?: string
      env?: Record<string, string>
      useConpty?: boolean
    },
  ): IPtyProcess
}

let ptyModule: PtyModule | null = null
try {
  // node-pty is a native module; on unsupported platforms (or when the
  // prebuilt binary failed to install) the require throws. Swallow and
  // fall back to the child_process path so terminals degrade gracefully
  // instead of crashing the whole window.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ptyModule = require('node-pty') as PtyModule
} catch {
  console.warn('[terminal] node-pty not available, using child_process fallback')
}

const MAX_SESSIONS = 20
const sessions = new Map<number, PtySession>()
let nextSessionId = 1
let mainWindow: Electron.BrowserWindow | null = null

interface PtySession {
  id: number
  /** node-pty IPty (has .write) or child_process.ChildProcess (use .stdin.write) */
  process: IPtyProcess | ChildProcess
  onData: (data: string) => void
  onExit: (exitCode: number) => void
  cwd: string
  /** true when using spawn() pipe fallback (no node-pty or pty spawn failed) */
  isChildProcess?: boolean
}

export function registerTerminalHandlers(ipcMain: Electron.IpcMain, win: Electron.BrowserWindow): void {
  mainWindow = win

  validatedHandle('terminal:create', terminalCreateArgs, (_event, [cwd]) => {
    if (sessions.size >= MAX_SESSIONS) {
      console.warn(`[terminal:create] Max sessions limit (${MAX_SESSIONS}) reached`)
      return { error: `Max terminal sessions limit reached (${MAX_SESSIONS})` }
    }
    const sessionId = nextSessionId++
    const { file: shell, args: shellArgs } = getInteractiveShellSpec(readDefaultShellId())
    let workDir: string
    if (hasSecurityWorkspaceRoot()) {
      const primary = getPrimaryWorkspaceRoot()!
      const raw = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : primary
      const resolved = resolvePathForWorkspaceAccess(raw)
      workDir = resolved.ok ? resolved.resolved : primary
      if (!resolved.ok) {
        console.warn('[terminal:create] cwd outside workspace, using primary root:', resolved.reason)
      }
    } else {
      // When no security workspace root is set, try workspaceState first
      // (it may be set later than the security layer sync).
      // process.cwd() in a packaged Electron app is the install dir —
      // almost never what the user intends.
      const wsPath = getWorkspacePath()?.trim()
      if (wsPath) {
        workDir = wsPath
      } else {
        console.warn('[terminal:create] No workspace is open, falling back to process.cwd() or HOME')
        workDir = cwd || process.env.HOME || process.cwd()
      }
    }

    if (ptyModule) {
      try {
        return createPtySession(sessionId, shell, shellArgs, workDir)
      } catch (err) {
        console.log('node-pty spawn failed, falling back to child_process:', (err as Error).message)
        return createFallbackSession(sessionId, shell, shellArgs, workDir)
      }
    }
    return createFallbackSession(sessionId, shell, shellArgs, workDir)
  })

  validatedHandle('terminal:write', terminalWriteArgs, (_event, [sessionId, data]) => {
    const session = sessions.get(sessionId)
    if (!session) return
    if (session.isChildProcess) {
      const proc = session.process as ChildProcess
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(data, 'utf-8')
      }
      return
    }
    const proc = session.process as IPtyProcess
    if (typeof proc.write === 'function') {
      proc.write(data)
    }
  })

  validatedHandle('terminal:resize', terminalResizeArgs, (_event, [sessionId, cols, rows]) => {
    const session = sessions.get(sessionId)
    if (!session || session.isChildProcess) return
    const proc = session.process as IPtyProcess
    if (typeof proc.resize === 'function') {
      try {
        proc.resize(cols, rows)
      } catch {
        // ignore resize errors
      }
    }
  })

  validatedHandle('terminal:close', terminalCloseArgs, (_event, [sessionId]) => {
    const session = sessions.get(sessionId)
    if (!session) return
    sessions.delete(sessionId)
    killSessionProcess(session)
  })

  validatedHandle('terminal:exec', terminalExecArgs, async (_event, [command, cwd]) => {
    const v = validateTerminalExec(command, cwd)
    if (!v.ok) {
      return { success: false, stdout: '', stderr: v.error, exitCode: 1 }
    }
    return executeCommand(command, v.resolvedCwd)
  })
}

/** First Windows 11 build — ConPTY only receives fixes from here on. */
const WINDOWS_11_MIN_BUILD = 22000

function windowsBuildNumber(): number {
  // os.release() → "10.0.19045" on Win10 22H2, "10.0.22631" on Win11 23H2.
  const build = Number.parseInt(os.release().split('.')[2] ?? '', 10)
  return Number.isFinite(build) ? build : 0
}

function windowsPtySpawnOptions(): { useConpty?: boolean } {
  if (process.platform !== 'win32') return {}
  const v = process.env.ASTRA_PTY_CONPTY
  if (v === '0' || v === 'false') return { useConpty: false }
  if (v === '1' || v === 'true') return { useConpty: true }
  // Windows 10: default to winpty — its in-box ConPTY crashes the shell host
  // (WER dialog) when a freshly spawned shell is killed. See header comment.
  if (windowsBuildNumber() < WINDOWS_11_MIN_BUILD) return { useConpty: false }
  return {}
}

function createPtySession(
  sessionId: number,
  shell: string,
  args: string[],
  cwd: string
): { sessionId: number } {
  if (!ptyModule) {
    throw new Error('[terminal] node-pty module not available')
  }
  const ptyProcess = ptyModule.spawn(shell, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: {
      ...shellSpawnEnv(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } as Record<string, string>,
    ...windowsPtySpawnOptions(),
  })

  const session: PtySession = {
    id: sessionId,
    process: ptyProcess,
    onData: () => {},
    onExit: () => {},
    cwd,
  }

  ptyProcess.onData((data: string) => {
    try {
      mainWindow?.webContents.send('terminal:data', { sessionId, data })
    } catch {
      // ignore — window may be destroyed during shutdown
    }
  })

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    sessions.delete(sessionId)
    try {
      mainWindow?.webContents.send('terminal:exit', { sessionId, exitCode })
    } catch {
      // ignore
    }
  })

  sessions.set(sessionId, session)
  return { sessionId }
}

/**
 * Pipe-backed sessions (no PTY): bash with `-i` tries to set process groups / job control and
 * prints "cannot set terminal process group" + "no job control in this shell" to stderr.
 * Drop `-i` only for this backend; login profile still loads via `--login` / `-l`.
 */
function shellArgsForPipeBackend(shell: string, args: string[]): string[] {
  if (process.platform !== 'win32') return args
  const base = path.basename(shell.replace(/^"|"$/g, '')).toLowerCase()
  if (base !== 'bash.exe' && base !== 'bash') return args
  return args.filter((a) => a !== '-i' && a !== '--interactive')
}

function createFallbackSession(
  sessionId: number,
  shell: string,
  args: string[],
  cwd: string
): { sessionId: number; fallback: boolean } {
  const env = shellSpawnEnv(process.env as Record<string, string>) as Record<string, string>

  const spawnArgs = shellArgsForPipeBackend(shell, args)

  const childProcess = spawn(shell, spawnArgs, {
    cwd,
    env,
    shell: false,
    // On Windows, child_process stdio defaults reads as UTF-8 in Node.js.
    // When shellSpawnEnv sets LANG/LC_ALL, POSIX shells (Git Bash) will use UTF-8.
    // For cmd.exe/PowerShell, the shell args already include chcp 65001 / encoding setup.
  })

  const session: PtySession = {
    id: sessionId,
    process: childProcess,
    onData: () => {},
    onExit: () => {},
    cwd,
    isChildProcess: true,
  }

  // Decode stdout/stderr as UTF-8 (shellSpawnEnv ensures shells use UTF-8 output)
  childProcess.stdout?.on('data', (data: Buffer) => {
    try {
      // data.toString('utf-8') — Node.js default for Buffer.toString()
      mainWindow?.webContents.send('terminal:data', { sessionId, data: data.toString('utf-8') })
    } catch { /* window destroyed during shutdown */ }
  })

  childProcess.stderr?.on('data', (data: Buffer) => {
    try {
      mainWindow?.webContents.send('terminal:data', { sessionId, data: data.toString('utf-8') })
    } catch { /* window destroyed during shutdown */ }
  })

  childProcess.on('close', (code) => {
    sessions.delete(sessionId)
    try {
      mainWindow?.webContents.send('terminal:exit', { sessionId, exitCode: code ?? 0 })
    } catch { /* window destroyed during shutdown */ }
  })

  sessions.set(sessionId, session)
  return { sessionId, fallback: true }
}

/**
 * Execute a command and return stdout/stderr.
 * Used by AI Bash tool, not for interactive terminal.
 */
function executeCommand(command: string, cwd?: string): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const spec = getToolShellSpawnSpec(readDefaultShellId(), command)
    const child = spawn(spec.file, spec.args, {
      cwd: cwd || process.cwd(),
      shell: false,
      env: shellSpawnEnv(),
      timeout: 120_000,
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf-8')
    })

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString('utf-8')
    })

    child.on('close', (code) => {
      resolve({
        success: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
      })
    })

    child.on('error', (error) => {
      resolve({
        success: false,
        stdout: '',
        stderr: error.message,
        exitCode: 1,
      })
    })
  })
}

// Get session for streaming (called from main process directly)
export function getSession(sessionId: number): PtySession | undefined {
  return sessions.get(sessionId)
}

function killSessionProcess(session: PtySession): void {
  try {
    const proc = session.process
    if (session.isChildProcess) {
      const child = proc as ChildProcess
      // Skip if already exited — on Windows, kill() may shell out to taskkill and print
      // "ERROR: The process \"pid\" not found." to stderr when the PID is gone.
      if (child.exitCode !== null || child.signalCode !== null || child.killed) return
    }
    proc.kill()
  } catch {
    // ignore — process may already be dead
  }
}

// Kill all terminal sessions on app shutdown
export function killAllSessions() {
  for (const session of sessions.values()) {
    if (session.isChildProcess) {
      forceKillProcessTree(session.process as ChildProcess)
    } else {
      const pid = (session.process as IPtyProcess).pid
      if (pid != null) forceKillPidTree(pid)
      killSessionProcess(session)
    }
  }
  sessions.clear()
}
