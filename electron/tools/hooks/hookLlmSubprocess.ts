/**
 * Runs `prompt` / `agent` hooks in a separate Node/Electron-as-Node process (§9.2 parity).
 * Falls back to in-process execution when the worker bundle is missing or
 * `ASTRA_HOOK_LLM_IN_PROCESS=1` is set (tests / emergency).
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAgentContext } from '../../agents/agentContext'
import type { CommandHookInput } from './execCommand'
import type { HookResult } from './types'
import { HOOK_EXIT_BLOCKING } from './types'
import { trackAppOwnedChildProcess } from '../../lifecycle/appOwnedChildProcesses'

const WORKER_FILENAME = 'hookLlmWorkerEntry.js'
const MAX_STDOUT_BYTES = 12 * 1024 * 1024

function thisDir(): string {
  try {
    return typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
}

export function resolveHookLlmWorkerPath(): string {
  return path.join(thisDir(), WORKER_FILENAME)
}

function augmentEnvWithParentAgent(env: Record<string, string>): Record<string, string> {
  const parent = getAgentContext()
  if (!parent) return env
  const next = { ...env }
  if (parent.agentId) next.CLAUDE_HOOK_PARENT_AGENT_ID = parent.agentId
  if (parent.streamConversationId) {
    next.CLAUDE_HOOK_PARENT_STREAM_CONVERSATION_ID = parent.streamConversationId
  }
  return next
}

function nodeLikeSpawnEnv(): NodeJS.ProcessEnv {
  const base = { ...process.env }
  if (process.versions.electron) {
    base.ELECTRON_RUN_AS_NODE = '1'
    base.ELECTRON_NO_ATTACH_CONSOLE = '1'
  }
  return base
}

/**
 * @returns HookResult when subprocess completed; `null` to signal caller should run in-process.
 */
export async function runHookLlmInSubprocess(
  kind: 'prompt' | 'agent',
  input: CommandHookInput,
): Promise<HookResult | null> {
  if (process.env.ASTRA_HOOK_LLM_IN_PROCESS === '1') return null

  const workerPath = resolveHookLlmWorkerPath()
  if (!fs.existsSync(workerPath)) {
    return null
  }

  const payload = JSON.stringify({
    kind,
    input: {
      ...input,
      env: augmentEnvWithParentAgent({ ...input.env }),
    },
  })

  const timeoutMs = Math.max(1000, Math.min(900_000, input.timeoutMs ?? 120_000))

  return new Promise<HookResult>((resolve) => {
    const child = spawn(process.execPath, [workerPath], {
      env: nodeLikeSpawnEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    trackAppOwnedChildProcess(child)

    let stdoutBuf = Buffer.alloc(0)
    let stderrBuf = ''
    let settled = false
    const finish = (r: HookResult) => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      clearTimeout(timer)
      resolve(r)
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish({
        exitCode: HOOK_EXIT_BLOCKING,
        stdout: stdoutBuf.toString('utf8').slice(0, 20_000),
        stderr: `Hook subprocess timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)

    // Forward agent abort (main stream cancel) so hook subprocess stops
    // immediately instead of running to the full timeout on cancel.
    const agentSignal = getAgentContext()?.signal
    const onAbort = () => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      finish({
        exitCode: HOOK_EXIT_BLOCKING,
        stdout: stdoutBuf.toString('utf8').slice(0, 20_000),
        stderr: 'Hook subprocess aborted by parent agent',
      })
    }
    if (agentSignal) {
      if (agentSignal.aborted) onAbort()
      else agentSignal.addEventListener('abort', onAbort, { once: true })
    }
    child.on('close', () => {
      if (agentSignal) {
        try { agentSignal.removeEventListener('abort', onAbort) } catch { /* ignore */ }
      }
    })

    child.stdout?.on('data', (d: Buffer) => {
      if (stdoutBuf.length + d.length > MAX_STDOUT_BYTES) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        finish({
          exitCode: HOOK_EXIT_BLOCKING,
          stdout: '',
          stderr: 'Hook subprocess stdout exceeded cap',
        })
        return
      }
      stdoutBuf = Buffer.concat([stdoutBuf, d])
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString('utf8')
      if (stderrBuf.length > 200_000) stderrBuf = `${stderrBuf.slice(0, 200_000)}…`
    })

    child.on('error', (err) => {
      finish({
        exitCode: HOOK_EXIT_BLOCKING,
        stdout: '',
        stderr: `Hook subprocess spawn failed: ${err.message}`,
      })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      const text = stdoutBuf.toString('utf8').trim()
      if (!text) {
        resolve({
          exitCode: code === 0 ? 0 : HOOK_EXIT_BLOCKING,
          stdout: '',
          stderr: stderrBuf.trim() || 'Hook subprocess produced no stdout',
        })
        return
      }
      try {
        const parsed = JSON.parse(text) as HookResult
        if (typeof parsed.exitCode !== 'number') {
          resolve({
            exitCode: HOOK_EXIT_BLOCKING,
            stdout: text.slice(0, 8000),
            stderr: 'Hook subprocess stdout is not a valid HookResult JSON',
          })
          return
        }
        resolve(parsed)
      } catch {
        resolve({
          exitCode: HOOK_EXIT_BLOCKING,
          stdout: text.slice(0, 8000),
          stderr: stderrBuf.trim() || 'Failed to parse HookResult JSON from subprocess',
        })
      }
    })

    try {
      child.stdin?.write(payload, 'utf8')
      child.stdin?.end()
    } catch (e) {
      finish({
        exitCode: HOOK_EXIT_BLOCKING,
        stdout: '',
        stderr: `Hook subprocess stdin failed: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  })
}
