/**
 * SpawnTeammate — external process / tmux pane orchestration (ARCHITECTURE.md spawnTeammate).
 */

import { spawn, exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildTool } from './buildTool'
import { getWorkspacePath } from './workspaceState'
import { spawnTeammateInputZod } from './toolInputZod'
import { trackAppOwnedChildProcess } from '../lifecycle/appOwnedChildProcesses'
import { trackAppOwnedTmuxPane } from '../lifecycle/appOwnedTmuxResources'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

// Cache the result — `command -v tmux` doesn't change within a session and
// running it on every SpawnTeammate call adds 30-100ms of process spawn cost.
let cachedTmuxAvailable: boolean | null = null

async function whichTmux(): Promise<boolean> {
  if (cachedTmuxAvailable !== null) return cachedTmuxAvailable
  if (process.platform === 'win32') {
    cachedTmuxAvailable = false
    return false
  }
  try {
    await execAsync('command -v tmux', { shell: '/bin/sh' })
    cachedTmuxAvailable = true
  } catch {
    cachedTmuxAvailable = false
  }
  return cachedTmuxAvailable
}

export const spawnTeammateTool = buildTool({
  name: 'SpawnTeammate',
  zInputSchema: spawnTeammateInputZod,
  description:
    'Start a teammate in an **external** environment: `tmux_split` opens a new tmux pane (Unix, tmux required), `detached_shell` runs a shell command in a detached OS process. Use for long-running CLIs or human-in-the-loop panes. Does not replace the in-process Agent tool.',
  inputSchema: [
    {
      name: 'mode',
      type: 'string',
      description: 'tmux_split | detached_shell',
      required: true,
    },
    {
      name: 'shell_command',
      type: 'string',
      description: 'Command to run (e.g. `npx @anthropic-ai/claude-code` or a project script)',
      required: true,
    },
    {
      name: 'tmux_session',
      type: 'string',
      description: 'Optional tmux target (-t name). If omitted, uses current session when inside tmux.',
    },
  ],
  isReadOnly: false,
  async call({ mode, shell_command, tmux_session }) {
    const cmd = (shell_command || '').trim()
    if (!cmd) {
      return { success: false, error: 'shell_command is required' }
    }
    const cwd = getWorkspacePath() || process.cwd()
    const m = (mode || '').trim().toLowerCase()

    if (m === 'tmux_split' || m === 'tmux') {
      if (process.platform === 'win32') {
        return {
          success: false,
          error: 'tmux_split is not supported on Windows. Use detached_shell.',
        }
      }
      if (!(await whichTmux())) {
        return { success: false, error: 'tmux not found in PATH.' }
      }
      const args: string[] = ['split-window']
      if (tmux_session?.trim()) {
        args.push('-t', tmux_session.trim())
      }
      args.push('-h', '-c', cwd, '-P', '-F', '#{pane_id}', 'bash', '-lc', cmd)
      try {
        const { stdout } = await execFileAsync('tmux', args, {
          cwd,
          encoding: 'utf8',
          timeout: 10_000,
        })
        const paneId = stdout.trim()
        trackAppOwnedTmuxPane(paneId)
        return {
          success: true,
          output: JSON.stringify({
            mode: 'tmux_split',
            paneId,
            cwd,
            message: 'tmux split-window started (detached).',
          }),
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { success: false, error: `tmux spawn failed: ${msg}` }
      }
    }

    if (m === 'detached_shell' || m === 'shell' || m === 'detached') {
      try {
        if (process.platform === 'win32') {
          const com = process.env.ComSpec || 'cmd.exe'
          const child = spawn(com, ['/c', 'start', '', '/wait', cmd], {
            cwd,
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
          })
          trackAppOwnedChildProcess(child)
        } else {
          const child = spawn('sh', ['-c', cmd], {
            cwd,
            detached: true,
            stdio: 'ignore',
          })
          trackAppOwnedChildProcess(child)
        }
        return {
          success: true,
          output: JSON.stringify({
            mode: 'detached_shell',
            cwd,
            message: 'Detached shell command started.',
          }),
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { success: false, error: `detached_shell failed: ${msg}` }
      }
    }

    return {
      success: false,
      error: `Unknown mode "${mode}". Use tmux_split or detached_shell.`,
    }
  },
})
