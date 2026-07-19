/**
 * upstream report §10.x — named entrypoints for sandbox parity (this app uses
 * `sandbox-config` + `sandbox-command` / `wrapWithSandbox` instead of npm `@anthropic-ai/sandbox-runtime`).
 */

import fs from 'node:fs'
import path from 'node:path'
import { getSandboxConfig, isSandboxEnabled, isCommandExcluded, subscribeSandboxConfig } from './sandbox-config'
import { validateSandboxCommand } from './sandbox-command'

export type SandboxRuntimeConfigJson = {
  enabled: boolean
  filesystem: {
    allowRead: string[]
    denyRead: string[]
    allowWrite: string[]
    denyWrite: string[]
  }
  network: {
    allowedDomains: string[]
    deniedDomains: string[]
    allowUnixSockets: boolean
    allowLocalBinding: boolean
  }
  excludedCommands: string[]
  ignoreViolations: string[]
  enableWeakerNestedSandbox: boolean
}

/** upstream `convertToSandboxRuntimeConfig` analogue — JSON-friendly snapshot of current policy. */
export function convertToSandboxRuntimeConfig(): SandboxRuntimeConfigJson {
  const c = getSandboxConfig()
  return {
    enabled: c.enabled,
    filesystem: { ...c.filesystem },
    network: { ...c.network },
    excludedCommands: [...c.excludedCommands],
    ignoreViolations: [...c.ignoreViolations],
    enableWeakerNestedSandbox: c.enableWeakerNestedSandbox,
  }
}

/**
 * First "executable" segment of a compound shell line (upstream `shouldUseSandbox` analogue).
 * Used only for policy checks — does not rewrite the command.
 */
export function peelCompositeShellCommand(command: string): string {
  const t = command.trim()
  if (!t) return t
  const cut = (sep: string, slice: string) => {
    const i = slice.indexOf(sep)
    return i >= 0 ? slice.slice(0, i).trim() : slice
  }
  let head = cut('&&', t)
  head = cut('||', head)
  head = cut(';', head)
  head = head.split('\n')[0]?.trim() ?? head
  return head
}

/**
 * Whether OS-level / app-level sandbox wrapping should apply to this command string.
 * Aligns intent with report §10.3 — gated by enable flag, exclusions, blocked patterns, and peel.
 */
export function shouldUseSandbox(command: string): boolean {
  if (!isSandboxEnabled()) return false
  const head = peelCompositeShellCommand(command)
  if (!head) return false
  if (isCommandExcluded(head) || isCommandExcluded(command)) return false
  const v = validateSandboxCommand(head)
  return v.ok
}

export { wrapWithSandbox } from './sandboxPrimitiveWrap'

export type SandboxRuntimeInitHandle = { unsubscribe: () => void }

/**
 * upstream §10.4 `initialize` + subscription — invokes `onConfig` immediately and after each `setSandboxConfig`.
 */
export function initializeSandboxRuntime(
  onConfig: (cfg: SandboxRuntimeConfigJson) => void,
): SandboxRuntimeInitHandle {
  onConfig(convertToSandboxRuntimeConfig())
  const unsubscribe = subscribeSandboxConfig(() => {
    onConfig(convertToSandboxRuntimeConfig())
  })
  return { unsubscribe }
}

/**
 * Best-effort bare-repo guard for mutating git operations (subset of report "裸 Git" notes).
 */
export function isBareGitCheckout(dir: string): boolean {
  try {
    const gitMeta = path.join(dir, '.git')
    if (!fs.existsSync(gitMeta)) return false
    const st = fs.statSync(gitMeta)
    return st.isFile()
  } catch {
    return false
  }
}
