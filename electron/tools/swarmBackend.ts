/**
 * AC-7.2 — Swarm / team transport detection (upstream tmux/iTerm vs in-process).
 *
 * 星构Astra coordinates in the Electron main process; optional env / probes describe
 * whether external pane backends exist on the host (parity with upstream metadata).
 */

import { spawn, spawnSync } from 'node:child_process'
import { getTeamFilePath } from './teamFileShared'
import type { SwarmBackendKind } from './teamFileShared'

export type { SwarmBackendKind }

function forcedBackendFromEnv(): SwarmBackendKind | undefined {
  const raw = process.env.ASTRA_SWARM_FORCE_BACKEND?.trim().toLowerCase()
  if (raw === 'in-process' || raw === 'tmux' || raw === 'iterm2') {
    return raw as SwarmBackendKind
  }
  return undefined
}

// Detection cost: 2× `spawn` with 1500ms timeout each. Cache the result —
// it can't change within a session (tmux/iTerm2 CLIs don't appear or
// disappear at runtime), so repeated team-create calls would otherwise
// pay up to 3s of spawn cost every time.
let cachedBackend: SwarmBackendKind | null = null

function probeBackendSync(): SwarmBackendKind {
  if (process.platform === 'win32') return 'in-process'
  try {
    const it2 = spawnSync('it2', ['version'], { encoding: 'utf8', timeout: 1500 })
    if (it2.status === 0) return 'iterm2'
  } catch {
    /* no iterm2 cli */
  }
  try {
    const tm = spawnSync('tmux', ['-V'], { encoding: 'utf8', timeout: 1500 })
    if (tm.status === 0 || String(tm.stdout ?? '').toLowerCase().includes('tmux')) {
      return 'tmux'
    }
  } catch {
    /* no tmux */
  }
  return 'in-process'
}

function probeOnceAsync(bin: string): Promise<{ stdout: string; status: number }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, bin === 'it2' ? ['version'] : ['-V'], {
        windowsHide: true,
      })
    } catch {
      resolve({ stdout: '', status: -1 })
      return
    }
    const chunks: Buffer[] = []
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* already exited */
      }
    }, 1500)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout?.on('data', (c: Buffer) => chunks.push(c))
    child.stderr?.resume()
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ stdout: '', status: -1 })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout: killed ? '' : Buffer.concat(chunks).toString('utf8'),
        status: killed ? -1 : code ?? -1,
      })
    })
  })
}

async function probeBackendAsync(): Promise<SwarmBackendKind> {
  if (process.platform === 'win32') return 'in-process'
  const it2 = await probeOnceAsync('it2')
  if (it2.status === 0) return 'iterm2'
  const tm = await probeOnceAsync('tmux')
  if (tm.status === 0 || tm.stdout.toLowerCase().includes('tmux')) {
    return 'tmux'
  }
  return 'in-process'
}

/**
 * Best-effort probe: Windows → in-process; Unix may report tmux or iTerm2 when CLIs exist.
 * Tests should set `ASTRA_SWARM_FORCE_BACKEND=in-process` for determinism.
 *
 * Result is cached after the first non-forced call. Prefer
 * {@link detectSwarmBackendAsync} from new callers — the sync variant
 * blocks the Electron main process for up to 3 s on the first call.
 */
export function detectSwarmBackend(): SwarmBackendKind {
  const forced = forcedBackendFromEnv()
  if (forced) return forced
  if (cachedBackend !== null) return cachedBackend
  cachedBackend = probeBackendSync()
  return cachedBackend
}

/**
 * Non-blocking variant of {@link detectSwarmBackend}. Performs probes via
 * `child_process.spawn` so the renderer/main event loop stays responsive
 * during team creation.
 */
export async function detectSwarmBackendAsync(): Promise<SwarmBackendKind> {
  const forced = forcedBackendFromEnv()
  if (forced) return forced
  if (cachedBackend !== null) return cachedBackend
  cachedBackend = await probeBackendAsync()
  return cachedBackend
}

export function isExternalSwarmBackendAvailable(): boolean {
  return detectSwarmBackend() !== 'in-process'
}

export async function isExternalSwarmBackendAvailableAsync(): Promise<boolean> {
  return (await detectSwarmBackendAsync()) !== 'in-process'
}

export function buildTeamSwarmMetadata(workspaceRoot: string, teamName: string): {
  swarmBackend: SwarmBackendKind
  teamFilePath: string
} {
  return {
    swarmBackend: detectSwarmBackend(),
    teamFilePath: getTeamFilePath(workspaceRoot, teamName),
  }
}

/** Async variant — preferred for tools called from the agentic loop. */
export async function buildTeamSwarmMetadataAsync(
  workspaceRoot: string,
  teamName: string,
): Promise<{ swarmBackend: SwarmBackendKind; teamFilePath: string }> {
  return {
    swarmBackend: await detectSwarmBackendAsync(),
    teamFilePath: getTeamFilePath(workspaceRoot, teamName),
  }
}
