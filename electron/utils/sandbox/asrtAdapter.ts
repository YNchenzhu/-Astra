/**
 * Bridge to npm `@anthropic-ai/sandbox-runtime` (ASRT) on **macOS / Linux** (non-WSL1).
 * Windows is unsupported by ASRT — callers keep app-layer policy + optional WSL (future).
 */

import { getSandboxConfig, isSandboxEnabled } from './sandbox-config'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { wrapWithSandbox as astraPrimitiveWrap } from './sandboxPrimitiveWrap'
import { resolveRipgrepBin } from '../ripgrepBin'

let lastFingerprint: string | null = null

function astraToRuntimeConfig(): SandboxRuntimeConfig {
  const c = getSandboxConfig()
  const allowUnix = c.network.allowUnixSockets === true
  return {
    network: {
      allowedDomains:
        c.network.allowedDomains.length > 0
          ? [...c.network.allowedDomains]
          : c.network.allowLocalBinding
            ? ['*']
            : [],
      deniedDomains: [...c.network.deniedDomains],
      allowLocalBinding: c.network.allowLocalBinding,
      allowAllUnixSockets: allowUnix,
    },
    filesystem: {
      denyRead: [...c.filesystem.denyRead],
      allowRead: c.filesystem.allowRead.length > 0 ? [...c.filesystem.allowRead] : undefined,
      allowWrite: [...c.filesystem.allowWrite],
      denyWrite: [...c.filesystem.denyWrite],
    },
    enableWeakerNestedSandbox: c.enableWeakerNestedSandbox,
    ripgrep: c.ripgrep ?? { command: resolveRipgrepBin() },
  }
}

function fingerprint(): string {
  try {
    return JSON.stringify(astraToRuntimeConfig())
  } catch {
    return String(Math.random())
  }
}

/**
 * Returns a shell command line ready for `spawn(..., { shell: true })`.
 * Uses ASRT when supported; otherwise primitive bwrap / sandbox-exec string wrap or raw on Windows.
 */
export async function resolveSandboxWrappedCommandLine(command: string): Promise<{
  cmdLine: string
  useAsrtCleanup: boolean
}> {
  const cmd = command
  if (!isSandboxEnabled()) {
    return { cmdLine: cmd, useAsrtCleanup: false }
  }

  try {
    const mod = await import('@anthropic-ai/sandbox-runtime')
    const { SandboxManager } = mod

    if (!SandboxManager.isSupportedPlatform()) {
      return { cmdLine: astraPrimitiveWrap(cmd), useAsrtCleanup: false }
    }

    const fp = fingerprint()
    if (!SandboxManager.isSandboxingEnabled() || fp !== lastFingerprint) {
      await SandboxManager.reset().catch(() => {
        /* first run */
      })
      await SandboxManager.initialize(astraToRuntimeConfig())
      lastFingerprint = fp
    }

    const wrapped = await SandboxManager.wrapWithSandbox(cmd)
    return { cmdLine: wrapped, useAsrtCleanup: true }
  } catch (e) {
    console.warn('[ASRT] falling back to built-in wrap:', e instanceof Error ? e.message : e)
    lastFingerprint = null
    return { cmdLine: astraPrimitiveWrap(cmd), useAsrtCleanup: false }
  }
}

export async function cleanupAfterAsrtCommand(useAsrtCleanup: boolean): Promise<void> {
  if (!useAsrtCleanup) return
  try {
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
    SandboxManager.cleanupAfterCommand()
  } catch {
    /* ignore */
  }
}

/** Call when sandbox is turned off so SOCKS/HTTP proxies are released. */
export async function shutdownAsrtIfRunning(): Promise<void> {
  lastFingerprint = null
  try {
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
    if (SandboxManager.isSandboxingEnabled()) {
      await SandboxManager.reset()
    }
  } catch {
    /* package missing or never initialized */
  }
}
