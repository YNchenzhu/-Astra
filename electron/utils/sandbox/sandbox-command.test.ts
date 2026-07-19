import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock shellRunner BEFORE importing sandbox-command so the latter picks up the spy.
const runPosixShellCommandSpy = vi.fn(async () => ({ success: true, output: 'ok' }))
vi.mock('../../tools/shellRunner', () => ({
  rewriteWindowsNullRedirectForShell: (s: string) => s,
  runPosixShellCommand: runPosixShellCommandSpy,
}))

// Avoid pulling in `electron` at test time via sandbox-config -> getProtectedPaths.
vi.mock('../../security/workspaceAccess', () => ({
  getPrimaryWorkspaceRoot: () => null,
  getSecurityWorkspaceRoots: () => [],
  hasSecurityWorkspaceRoot: () => false,
}))

const { runSandboxedCommand } = await import('./sandbox-command')
const { setSandboxConfig } = await import('./sandbox-config')

describe('runSandboxedCommand on win32 (regression: silent cmd.exe failure)', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
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
    runPosixShellCommandSpy.mockClear()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    setSandboxConfig({ enabled: false })
  })

  it('foreground sandboxed POSIX command delegates to runPosixShellCommand (not cmd.exe via shell:true)', async () => {
    const result = await runSandboxedCommand('grep -rn "x" electron 2>/dev/null | head -30', {
      cwd: undefined,
      label: 'bash',
    })

    expect(runPosixShellCommandSpy).toHaveBeenCalledTimes(1)
    expect(runPosixShellCommandSpy.mock.calls[0]?.[0]).toContain('grep -rn')
    expect(result.success).toBe(true)
    expect((result as { sandboxed: boolean }).sandboxed).toBe(true)
  })

  it('background sandboxed command also delegates to runPosixShellCommand', async () => {
    await runSandboxedCommand('npm run build', {
      cwd: undefined,
      label: 'bash',
      runInBackground: true,
    })

    expect(runPosixShellCommandSpy).toHaveBeenCalledTimes(1)
    expect(runPosixShellCommandSpy.mock.calls[0]?.[2]).toMatchObject({ runInBackground: true })
  })
})
