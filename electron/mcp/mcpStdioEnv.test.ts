import { describe, it, expect, afterEach } from 'vitest'
import {
  approximateWin32EnvBlockUnits,
  copyProcessEnvForMcpStdioChild,
  ensureNodeToolingBinDirsOnPath,
  shrinkMcpStdioEnvIfNeeded,
} from './mcpStdioEnv'

describe('copyProcessEnvForMcpStdioChild', () => {
  afterEach(() => {
    delete process.env.NODE_OPTIONS
    delete process.env.ELECTRON_RUN_AS_NODE
  })

  it('drops NODE_OPTIONS and ELECTRON_RUN_AS_NODE from parent', () => {
    process.env.NODE_OPTIONS = '--inspect'
    process.env.ELECTRON_RUN_AS_NODE = '1'
    const e = copyProcessEnvForMcpStdioChild()
    expect(e.NODE_OPTIONS).toBeUndefined()
    expect(e.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(typeof e.PATH === 'string' || typeof e.Path === 'string' || e.PATH !== undefined || e.Path !== undefined).toBe(
      true,
    )
  })

  it('minimal mode only keeps a small allowlist', () => {
    process.env.MY_CUSTOM_DEV_VAR = 'x'
    const e = copyProcessEnvForMcpStdioChild({ minimal: true })
    expect(e.MY_CUSTOM_DEV_VAR).toBeUndefined()
    expect(e.PATH !== undefined || e.Path !== undefined).toBe(true)
    delete process.env.MY_CUSTOM_DEV_VAR
  })
})

describe('approximateWin32EnvBlockUnits', () => {
  it('counts key/value pairs', () => {
    const n = approximateWin32EnvBlockUnits({ a: 'b', cd: 'ef' })
    expect(n).toBeGreaterThan(4)
  })
})

describe('shrinkMcpStdioEnvIfNeeded', () => {
  it('returns same object when small', () => {
    const env = { PATH: '/bin', _: 'x' }
    const out = shrinkMcpStdioEnvIfNeeded(env, {})
    expect(out).toBe(env)
  })
})

describe('ensureNodeToolingBinDirsOnPath', () => {
  it('does not throw on minimal env', () => {
    expect(() => ensureNodeToolingBinDirsOnPath({ PATH: process.platform === 'win32' ? 'C:\\Windows' : '/bin' })).not.toThrow()
  })
})
