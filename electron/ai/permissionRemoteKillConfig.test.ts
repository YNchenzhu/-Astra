import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearPermissionRemoteKillFileCache,
  readPermissionRemoteKillPayload,
} from './permissionRemoteKillConfig'

describe('permissionRemoteKillConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    clearPermissionRemoteKillFileCache()
  })

  it('returns empty when no env', () => {
    expect(readPermissionRemoteKillPayload()).toEqual({})
  })

  it('reads ASTRA_PERMISSION_KILL_CONFIG_JSON', () => {
    vi.stubEnv(
      'ASTRA_PERMISSION_KILL_CONFIG_JSON',
      JSON.stringify({ killBypassPermissions: true }),
    )
    expect(readPermissionRemoteKillPayload()).toEqual({ killBypassPermissions: true })
  })

  it('merges file path with inline (OR for each flag)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-remote-kill-'))
    const fp = path.join(dir, 'kill.json')
    fs.writeFileSync(fp, JSON.stringify({ killAutoPermissionModes: true }), 'utf-8')
    vi.stubEnv('ASTRA_PERMISSION_KILL_CONFIG_PATH', fp)
    vi.stubEnv(
      'ASTRA_PERMISSION_KILL_CONFIG_JSON',
      JSON.stringify({ killBypassPermissions: true }),
    )
    expect(readPermissionRemoteKillPayload()).toEqual({
      killBypassPermissions: true,
      killAutoPermissionModes: true,
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
