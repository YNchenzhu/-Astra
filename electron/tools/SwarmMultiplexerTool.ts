/**
 * upstream §1.1 Swarm (tmux / multi-pane) — **equivalent surface** for desktop:
 * - macOS/Linux: when `tmux` is on PATH, create/list detached sessions bound to workspace cwd (terminal multiplexer parity).
 * - Windows: no tmux — return guidance to use `TeamCreate` + in-app `terminal` API / UI panes.
 */

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { buildTool } from './buildTool'
import { swarmMultiplexerInputZod } from './toolInputZod'
import { getWorkspacePath } from './workspaceState'
import { trackAppOwnedTmuxSession } from '../lifecycle/appOwnedTmuxResources'

const execFileAsync = promisify(execFile)

function tmuxOnPath(): boolean {
  if (process.platform === 'win32') return false
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore', timeout: 2000 })
    return true
  } catch {
    return false
  }
}

function sanitizeSessionName(raw: string): string | null {
  const s = raw.trim().slice(0, 64)
  if (!s) return null
  if (!/^[a-zA-Z0-9_.-]+$/.test(s)) return null
  return s
}

export const swarmMultiplexerTool = buildTool({
  name: 'SwarmMultiplexer',
  description:
    'Swarm / tmux lane (OpenClaude §1.1). On macOS/Linux with tmux: `create_session` starts a detached session; `list_sessions` lists tmux sessions. ' +
    'On Windows or without tmux: use `TeamCreate` + `SendMessage` and split editor terminals — this tool returns platform guidance.',
  inputSchema: [
    {
      name: 'operation',
      type: 'string',
      required: true,
      enum: ['create_session', 'list_sessions'],
      description: 'create_session | list_sessions',
    },
    {
      name: 'session_name',
      type: 'string',
      description: 'Required for create_session: [a-zA-Z0-9_.-]+, max 64 chars (e.g. astra-team-alpha)',
    },
    {
      name: 'command',
      type: 'string',
      description: 'Optional shell command for tmux to run inside the new session (non-interactive)',
    },
  ],
  zInputSchema: swarmMultiplexerInputZod,
  isReadOnly: true,
  isConcurrencySafe: true,
  async call({ operation, session_name, command }) {
    const op = String(operation ?? '').trim()
    const sessionRaw = String(session_name ?? '')
    const cmdOpt = String(command ?? '').trim()

    if (process.platform === 'win32' || !tmuxOnPath()) {
      return {
        success: true,
        output: JSON.stringify(
          {
            mode: 'in_app_equivalent',
            platform: process.platform,
            tmux: false,
            guidance:
              'Use TeamCreate for in-process multi-agent lanes and SendMessage for mailbox routing; open multiple Integrated Terminal tabs in the IDE for human-visible panes. ' +
              'Install tmux on macOS/Linux for OS-level multiplexer sessions via this tool.',
          },
          null,
          2,
        ),
      }
    }

    const cwd = getWorkspacePath() || process.cwd()

    if (op === 'list_sessions') {
      try {
        const { stdout } = await execFileAsync(
          'tmux',
          ['list-sessions', '-F', '#{session_name}'],
          { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 512 * 1024 },
        )
        const lines = stdout
          .split(/\r?\n/)
          .map((l: string) => l.trim())
          .filter(Boolean)
        return {
          success: true,
          output: JSON.stringify({ mode: 'tmux', sessions: lines }, null, 2),
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { success: false, error: `tmux list-sessions failed: ${msg}` }
      }
    }

    if (op === 'create_session') {
      const name = sanitizeSessionName(sessionRaw)
      if (!name) {
        return {
          success: false,
          error: 'session_name required; use only [a-zA-Z0-9_.-], max 64 chars',
        }
      }
      const args = ['new-session', '-d', '-s', name, '-c', cwd]
      if (cmdOpt) {
        args.push('sh', '-c', cmdOpt)
      }
      try {
        await execFileAsync('tmux', args, {
          cwd,
          timeout: 10_000,
          windowsHide: true,
        })
        trackAppOwnedTmuxSession(name)
        return {
          success: true,
          output: JSON.stringify(
            {
              mode: 'tmux',
              created: name,
              cwd,
              ranCommand: cmdOpt || null,
              hint: 'Attach locally with: tmux attach -t ' + name,
            },
            null,
            2,
          ),
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { success: false, error: `tmux spawn failed: ${msg}` }
      }
    }

    return { success: false, error: `Unknown operation: ${op}` }
  },
})
