import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearPermissionRemoteKillFileCache } from './permissionRemoteKillConfig'
import {
  applyChatPermissionKillswitches,
  applyDiffPermissionKillswitch,
  isAutoStylePermissionKillswitchActive,
  isBypassPermissionsKillswitchActive,
} from './permissionRuntimeKillswitch'

describe('permissionRuntimeKillswitch', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    clearPermissionRemoteKillFileCache()
  })

  it('isBypassPermissionsKillswitchActive reads ASTRA_KILL_BYPASS_PERMISSIONS', () => {
    expect(isBypassPermissionsKillswitchActive()).toBe(false)
    vi.stubEnv('ASTRA_KILL_BYPASS_PERMISSIONS', '1')
    expect(isBypassPermissionsKillswitchActive()).toBe(true)
  })

  it('applyChatPermissionKillswitches downgrades bypass when kill switch on', () => {
    vi.stubEnv('ASTRA_KILL_BYPASS_PERMISSIONS', 'true')
    expect(applyChatPermissionKillswitches('bypassPermissions')).toBe('default')
    expect(applyChatPermissionKillswitches('plan')).toBe('plan')
  })

  it('applyChatPermissionKillswitches downgrades acceptEdits/dontAsk/auto when auto kill on', () => {
    vi.stubEnv('ASTRA_KILL_AUTO_PERMISSION_MODES', 'yes')
    expect(applyChatPermissionKillswitches('acceptEdits')).toBe('default')
    expect(applyChatPermissionKillswitches('dontAsk')).toBe('default')
    expect(applyChatPermissionKillswitches('auto')).toBe('default')
    expect(applyChatPermissionKillswitches('plan')).toBe('plan')
  })

  it('applyDiffPermissionKillswitch clears diff bypass when bypass kill on', () => {
    vi.stubEnv('ASTRA_KILL_BYPASS_PERMISSIONS', 'on')
    expect(applyDiffPermissionKillswitch('bypassPermissions')).toBe('default')
    expect(applyDiffPermissionKillswitch('default')).toBe('default')
  })

  it('ASTRA_PERMISSION_KILL_CONFIG_JSON activates killswitches like env', () => {
    vi.stubEnv(
      'ASTRA_PERMISSION_KILL_CONFIG_JSON',
      JSON.stringify({ killBypassPermissions: true, killAutoPermissionModes: true }),
    )
    expect(isBypassPermissionsKillswitchActive()).toBe(true)
    expect(isAutoStylePermissionKillswitchActive()).toBe(true)
    expect(applyChatPermissionKillswitches('bypassPermissions')).toBe('default')
    expect(applyChatPermissionKillswitches('acceptEdits')).toBe('default')
  })

  it('ASTRA_PERMISSION_KILL_CONFIG_PATH file toggles killswitch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-kill-file-'))
    const fp = path.join(dir, 'remote.json')
    fs.writeFileSync(fp, JSON.stringify({ killAutoPermissionModes: true }), 'utf-8')
    vi.stubEnv('ASTRA_PERMISSION_KILL_CONFIG_PATH', fp)
    expect(isAutoStylePermissionKillswitchActive()).toBe(true)
    expect(applyChatPermissionKillswitches('dontAsk')).toBe('default')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
