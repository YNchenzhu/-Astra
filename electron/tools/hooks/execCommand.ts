/**
 * Command hook executor.
 *
 * Spawns a child process for a command-type hook, injects environment variables
 * with tool context, and parses stdout/stderr into a HookResult.
 *
 * Exit code conventions:
 *   0 — success (allow execution to continue)
 *   2 — blocking error (prevent execution)
 *   other — non-blocking failure (log but continue)
 */

import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { killProcessTree } from '../tasks/killProcessTree'
import { trackAppOwnedChildProcess } from '../../lifecycle/appOwnedChildProcesses'
import { shellSpawnEnv } from '../../utils/shellSpawn'
import { readDefaultShellId } from '../../settings/settingsAccess'
import { getToolShellSpawnSpec } from '../../utils/defaultShellSpawn'
import type { HookEvent, HookExecutionKind, HookResult, HookResponse } from './types'
import { HOOK_EXIT_BLOCKING } from './types'
import { hookStdoutToResponse } from './hookNormalize'
import { execAgentHookModel, execPromptHookModel } from './hookLlmExecution'

/** upstream default timeouts (seconds → ms): command/http 600, prompt 30, agent 60. */
export const DEFAULT_HOOK_TIMEOUT_MS = {
  command: 600_000,
  http: 600_000,
  prompt: 30_000,
  agent: 60_000,
} as const

export function defaultTimeoutMsForHookKind(kind: HookExecutionKind | undefined): number {
  switch (kind ?? 'command') {
    case 'http':
      return DEFAULT_HOOK_TIMEOUT_MS.http
    case 'prompt':
      return DEFAULT_HOOK_TIMEOUT_MS.prompt
    case 'agent':
      return DEFAULT_HOOK_TIMEOUT_MS.agent
    default:
      return DEFAULT_HOOK_TIMEOUT_MS.command
  }
}

/** upstream §9.3 — SessionEnd hooks use a short default so shutdown does not hang on slow scripts. */
export const SESSION_END_HOOK_TIMEOUT_MS = 1500

export function resolveHookTimeoutMs(
  event: HookEvent,
  kind: HookExecutionKind | undefined,
): number {
  if (event === 'SessionEnd') return SESSION_END_HOOK_TIMEOUT_MS
  return defaultTimeoutMsForHookKind(kind)
}

export interface CommandHookInput {
  /** The shell command to execute, or an http(s) URL when executionKind is `http` */
  command: string
  /** Environment variables to pass to the process */
  env: Record<string, string>
  /** Working directory */
  cwd: string
  /** Timeout in milliseconds (defaults follow upstream: command/http 600s, prompt 30s, agent 60s) */
  timeoutMs?: number
  /** Run in background without blocking the main loop */
  async?: boolean
  /** Wait for completion but notify model on exit code 2 */
  asyncRewake?: boolean
  /** upstream §9.2 — default `command` spawns shell; `http` uses fetch. */
  executionKind?: HookExecutionKind
}

/**
 * Result when a hook is running in async mode.
 */
export interface AsyncHookResult {
  /** The child process */
  process: ChildProcess
  /** Process ID */
  pid?: number
  /** Promise that resolves when the process completes */
  onComplete: Promise<HookResult>
}

/**
 * SSRF guard for http hooks (audit B-P0-1 hooks): hook config URLs are
 * attacker-influencable data (a poisoned `.claude/settings.json` or hooks
 * file), and the fetch runs from the privileged main process. Deny loopback,
 * private / link-local ranges and cloud metadata endpoints by default.
 *
 * Users who intentionally hook a local webhook server can opt out with
 * `POLE_HOOK_HTTP_ALLOW_PRIVATE=1`.
 *
 * Static-only: hostnames that resolve to private IPs via DNS (rebinding)
 * are out of scope here — this closes the direct-literal cases.
 */
export const HOOK_HTTP_ALLOW_PRIVATE_ENV = 'POLE_HOOK_HTTP_ALLOW_PRIVATE'

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true // unparseable dotted quad — fail closed
  }
  const [a, b] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase()
  if (h === '::' || h === '::1') return true
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)
  if (mapped) return isPrivateIpv4(mapped[1]!)
  return false
}

/** Returns a human-readable deny reason, or null when the URL is allowed. */
export function hookHttpUrlDenyReason(rawUrl: string): string | null {
  if (process.env[HOOK_HTTP_ALLOW_PRIVATE_ENV] === '1') return null
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return 'URL 无法解析'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `不支持的协议 ${u.protocol}`
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) return '空主机名'
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'localhost 目标默认被禁止'
  }
  if (host === 'metadata.google.internal' || host === 'metadata') {
    return '云 metadata 端点被禁止'
  }
  const ipVer = net.isIP(host)
  if (ipVer === 4 && isPrivateIpv4(host)) return `私有/环回 IPv4 地址 ${host} 被禁止`
  if (ipVer === 6 && isPrivateIpv6(host)) return `私有/环回 IPv6 地址 ${host} 被禁止`
  // Decimal / hex / octal single-token IP obfuscation (http://2130706433/)
  if (!ipVer && /^(?:\d+|0x[0-9a-f]+)$/i.test(host)) {
    return `无法静态验证的数字型主机名 ${host} 被禁止`
  }
  return null
}

/**
 * Execute a command hook and return the result.
 * When async=true, returns immediately with AsyncHookResult.
 */
async function execHttpHook(
  url: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<HookResult> {
  const method = (env.CLAUDE_HOOK_HTTP_METHOD || 'POST').toUpperCase()
  const bodySource =
    env.CLAUDE_HOOK_STDIN_JSON || env.CLAUDE_TOOL_INPUT || env.CLAUDE_HOOK_HTTP_BODY || ''
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/plain;q=0.9,*/*;q=0.8',
  }
  if (env.CLAUDE_HOOK_HTTP_HEADERS) {
    try {
      const h = JSON.parse(env.CLAUDE_HOOK_HTTP_HEADERS) as Record<string, string>
      for (const [k, v] of Object.entries(h)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v
      }
    } catch {
      /* ignore bad headers */
    }
  }

  const ac = new AbortController()
  // Cap aligned with DEFAULT_HOOK_TIMEOUT_MS.http (audit B-P1-2: the old
  // 300s hard cap silently halved the documented 600s default).
  const tid = setTimeout(() => ac.abort(), Math.max(1000, Math.min(600_000, timeoutMs)))
  try {
    const init: RequestInit = {
      method: method === 'GET' || method === 'HEAD' ? method : 'POST',
      headers,
      signal: ac.signal,
    }
    if (init.method !== 'GET' && init.method !== 'HEAD') {
      init.body = bodySource
    }
    const res = await fetch(url, init)
    const text = await res.text()
    if (!res.ok) {
      const nonBlocking =
        env.CLAUDE_HOOK_HTTP_NONBLOCKING_ERRORS === '1' ||
        env.CLAUDE_HOOK_HTTP_NONBLOCKING_ERRORS === 'true'
      if (nonBlocking) {
        return {
          exitCode: 1,
          stdout: text.trim(),
          stderr: `HTTP ${res.status} ${res.statusText} (non-blocking)`,
        }
      }
      return {
        exitCode: HOOK_EXIT_BLOCKING,
        stdout: text.trim(),
        stderr: `HTTP ${res.status} ${res.statusText}`,
      }
    }
    return {
      exitCode: 0,
      stdout: text.trim(),
      stderr: '',
      parsedOutput: hookStdoutToResponse(text) ?? undefined,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const nonBlocking =
      env.CLAUDE_HOOK_HTTP_NONBLOCKING_ERRORS === '1' ||
      env.CLAUDE_HOOK_HTTP_NONBLOCKING_ERRORS === 'true'
    return {
      exitCode: nonBlocking ? 1 : HOOK_EXIT_BLOCKING,
      stdout: '',
      stderr: `HTTP hook failed: ${msg}`,
    }
  } finally {
    clearTimeout(tid)
  }
}

/**
 * Dispatch hook by {@link HookExecutionKind}:
 * - `http` — fetch
 * - `prompt` — single LLM turn (no shell); see {@link execPromptHookModel}
 * - `agent` — short read-only agentic loop; see {@link execAgentHookModel}
 * - `command` — shell (legacy shims may read `CLAUDE_HOOK_EXECUTION_KIND`)
 */
export async function execHook(input: CommandHookInput): Promise<HookResult | AsyncHookResult> {
  const kind = input.executionKind ?? 'command'
  const cmd = input.command.trim()

  if (kind === 'http') {
    if (!/^https?:\/\//i.test(cmd)) {
      return {
        exitCode: HOOK_EXIT_BLOCKING,
        stdout: '',
        stderr: 'HTTP hook requires command to be an http(s) URL',
      }
    }
    const ssrfDeny = hookHttpUrlDenyReason(cmd)
    if (ssrfDeny) {
      return {
        exitCode: HOOK_EXIT_BLOCKING,
        stdout: '',
        stderr: `HTTP hook URL blocked (SSRF guard): ${ssrfDeny}. Set ${HOOK_HTTP_ALLOW_PRIVATE_ENV}=1 to allow private endpoints.`,
      }
    }
    return execHttpHook(cmd, input.env, input.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS.http)
  }

  if (kind === 'prompt' || kind === 'agent') {
    if (input.async || input.asyncRewake) {
      return {
        exitCode: HOOK_EXIT_BLOCKING,
        stdout: '',
        stderr: 'prompt/agent hooks do not support async or asyncRewake; use executionKind command + shell wrapper',
      }
    }
    const { runHookLlmInSubprocess } = await import('./hookLlmSubprocess')
    const isolated = await runHookLlmInSubprocess(kind, input)
    if (isolated) return isolated
    return kind === 'prompt' ? execPromptHookModel(input) : execAgentHookModel(input)
  }

  return execCommandHook(input)
}

export async function execCommandHook(input: CommandHookInput): Promise<HookResult | AsyncHookResult> {
  const { command, env, cwd, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS.command, async: isAsync } = input

  const spec = getToolShellSpawnSpec(readDefaultShellId(), command)

  const mergedEnv: Record<string, string> = {
    ...shellSpawnEnv(),
    ...env,
  }

  // Cap aligned with DEFAULT_HOOK_TIMEOUT_MS.command (audit B-P1-2: the old
  // 300s hard cap silently halved the documented 600s default).
  const timeout = Math.max(1000, Math.min(600_000, timeoutMs))

  const child = spawn(spec.file, spec.args, {
    cwd,
    shell: false,
    env: mergedEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout,
  })
  trackAppOwnedChildProcess(child)

  let stdout = ''
  let stderr = ''
  // Audit B-P1-1: unbounded `+=` accumulation let a chatty hook OOM the
  // main process. Hook stdout is a JSON response (or short log lines), so
  // a 2 MB tail cap is far beyond any legitimate payload.
  const HOOK_OUTPUT_MAX_CHARS = 2 * 1024 * 1024
  const capTail = (s: string): string =>
    s.length <= HOOK_OUTPUT_MAX_CHARS ? s : s.slice(-HOOK_OUTPUT_MAX_CHARS)

  const stdinBody = mergedEnv.CLAUDE_HOOK_STDIN_JSON || ''
  if (child.stdin) {
    try {
      if (stdinBody) child.stdin.write(stdinBody, 'utf8')
      child.stdin.end()
    } catch {
      try {
        child.stdin.end()
      } catch {
        /* ignore */
      }
    }
  }

  child.stdout?.on('data', (data: Buffer) => {
    stdout = capTail(stdout + data.toString('utf-8'))
  })

  child.stderr?.on('data', (data: Buffer) => {
    stderr = capTail(stderr + data.toString('utf-8'))
  })

  const onComplete = new Promise<HookResult>((resolve) => {
    let settled = false
    const resolveOnce = (result: HookResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    child.on('close', (code) => {
      const exitCode = code ?? 1
      const result: HookResult = {
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      }

      // Try to parse JSON from stdout → normalized HookResponse
      if (result.stdout) {
        const norm = hookStdoutToResponse(result.stdout)
        if (norm) {
          result.parsedOutput = norm
        } else {
          try {
            result.parsedOutput = JSON.parse(result.stdout) as HookResponse
          } catch {
            // Not JSON — that's fine
          }
        }
      }

      resolveOnce(result)
    })

    child.on('error', (error) => {
      resolveOnce({
        exitCode: HOOK_EXIT_BLOCKING,
        stdout: '',
        stderr: `Hook command failed: ${error.message}`,
      })
    })

    child.on('timeout', () => {
      // Audit #9 — if close already settled this promise, do not SIGKILL a
      // (possibly already-exited) process again. `settled` is flipped before
      // resolve, so we read it here to short-circuit.
      if (settled) return
      // Audit B-P1-1: tree kill, not bare SIGKILL — a hook script that
      // spawned its own children (npm scripts, watchers) used to leak them.
      killProcessTree(child)
      resolveOnce({
        exitCode: HOOK_EXIT_BLOCKING,
        stdout: stdout.trim(),
        stderr: `Hook timed out after ${timeoutMs}ms`,
      })
    })
  })

  // Async mode: return immediately with process reference
  if (isAsync) {
    return {
      process: child,
      pid: child.pid,
      onComplete,
    } as AsyncHookResult
  }

  // asyncRewake or sync mode: wait for completion
  return onComplete
}

/**
 * Parse a HookResult into a HookResponse.
 */
export function resultToResponse(result: HookResult): HookResponse | undefined {
  if (result.parsedOutput && typeof result.parsedOutput === 'object') {
    return result.parsedOutput
  }

  // If no JSON, derive basic response from exit code
  if (result.exitCode === 2) {
    return {
      continue: false,
      preventContinuation: true,
      reason: result.stderr || result.stdout || 'Hook blocked execution',
    }
  }

  return undefined
}
