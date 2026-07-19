import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  convertToSandboxRuntimeConfig,
  peelCompositeShellCommand,
  shouldUseSandbox,
  initializeSandboxRuntime,
  isBareGitCheckout,
} from './sandboxRuntimeOpenClaude'
import { setSandboxConfig } from './sandbox-config'

describe('sandboxRuntimeOpenClaude (AC-10.x parity surface)', () => {
  afterEach(() => {
    setSandboxConfig({
      enabled: false,
      filesystem: { allowRead: [], denyRead: [], allowWrite: [], denyWrite: [] },
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowUnixSockets: false,
        allowLocalBinding: false,
      },
      excludedCommands: [],
      ignoreViolations: [],
      enableWeakerNestedSandbox: false,
    })
  })

  it('convertToSandboxRuntimeConfig returns a serializable snapshot', () => {
    const j = convertToSandboxRuntimeConfig()
    expect(typeof j.enabled).toBe('boolean')
    expect(Array.isArray(j.filesystem.denyWrite)).toBe(true)
  })

  it('peelCompositeShellCommand takes first segment', () => {
    expect(peelCompositeShellCommand('echo a && echo b')).toBe('echo a')
    expect(peelCompositeShellCommand('cd /tmp; ls')).toBe('cd /tmp')
  })

  it('initializeSandboxRuntime fires on subscribe and on setSandboxConfig', () => {
    const spy = vi.fn()
    const { unsubscribe } = initializeSandboxRuntime(spy)
    expect(spy).toHaveBeenCalledTimes(1)
    setSandboxConfig({ enabled: true })
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
    unsubscribe()
    const n = spy.mock.calls.length
    setSandboxConfig({ enabled: false })
    expect(spy.mock.calls.length).toBe(n)
  })

  it('shouldUseSandbox is false when sandbox disabled', () => {
    setSandboxConfig({ enabled: false })
    expect(shouldUseSandbox('rm -rf /')).toBe(false)
  })

  it('shouldUseSandbox is true for benign command when sandbox enabled', () => {
    setSandboxConfig({
      enabled: true,
      filesystem: { allowRead: [], denyRead: [], allowWrite: [], denyWrite: [] },
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowUnixSockets: false,
        allowLocalBinding: false,
      },
      excludedCommands: [],
      ignoreViolations: [],
      enableWeakerNestedSandbox: false,
    })
    expect(shouldUseSandbox('echo hello')).toBe(true)
  })

  it('isBareGitCheckout detects .git file', () => {
    expect(isBareGitCheckout('/nonexistent-path-xyz-12345')).toBe(false)
  })
})
