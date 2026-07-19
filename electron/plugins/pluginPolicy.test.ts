import { describe, it, expect, beforeEach } from 'vitest'
import {
  isPluginBlockedByPolicy,
  detectDelistedPlugins,
  isSourceInBlocklist,
} from './pluginPolicy'
import { setDiskSettingsLoader } from '../settings/settingsAccess'

describe('pluginPolicy', () => {
  beforeEach(() => {
    setDiskSettingsLoader(() => ({}))
  })

  it('isPluginBlockedByPolicy when enabledPlugins[id]===false', () => {
    setDiskSettingsLoader(() => ({
      enabledPlugins: { demo: false, other: true },
    }))
    expect(isPluginBlockedByPolicy('demo')).toBe(true)
    expect(isPluginBlockedByPolicy('other')).toBe(false)
    expect(isPluginBlockedByPolicy('missing')).toBe(false)
  })

  it('detectDelistedPlugins', () => {
    expect(detectDelistedPlugins(['a', 'b'], ['a'])).toEqual(['b'])
    expect(detectDelistedPlugins(['a'], [])).toEqual([])
  })

  it('isSourceInBlocklist', () => {
    setDiskSettingsLoader(() => ({
      pluginSourceBlocklist: ['evil.com'],
    }))
    expect(isSourceInBlocklist('https://evil.com/pkg')).toBe(true)
    expect(isSourceInBlocklist('https://good.com/pkg')).toBe(false)
  })
})
