import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ data: {} as Record<string, unknown> }))

vi.mock('../settings/settingsStore', () => ({
  loadSettings: () => store.data,
  saveSettings: (s: Record<string, unknown>) => {
    store.data = s
  },
}))

import { getBrowserSettings, saveBrowserSettings } from './h5SettingsApi'

beforeEach(() => {
  store.data = {}
})
afterEach(() => vi.clearAllMocks())

describe('getBrowserSettings (secret masking)', () => {
  it('masks top-level + apiConfigs + manualConfig + envVars secrets', () => {
    store.data = {
      apiKey: 'sk-1234567890abcdef',
      model: 'claude',
      apiConfigs: [{ id: 'c1', apiKey: 'sk-config-secret-xyz', model: 'm' }],
      manualConfig: { apiKey: 'sk-manual-secret-xyz', baseUrl: 'https://x' },
      envVars: [
        { id: 'e1', key: 'GH_TOKEN', value: 'ghp_supersecretvalue', enabled: true },
        { id: 'e2', key: 'EMPTY', value: '', enabled: true },
      ],
    }
    const view = getBrowserSettings()
    expect(String(view.apiKey)).toContain('••••')
    expect(String(view.apiKey)).not.toBe('sk-1234567890abcdef')
    expect(String((view.apiConfigs as Array<Record<string, unknown>>)[0].apiKey)).toContain('••••')
    expect(String((view.manualConfig as Record<string, unknown>).apiKey)).toContain('••••')
    const envVars = view.envVars as Array<Record<string, unknown>>
    expect(String(envVars[0].value)).toContain('••••')
    expect(String(envVars[0].value)).not.toContain('supersecret')
    expect(envVars[1].value).toBe('') // empty stays empty
    // non-secret fields are untouched
    expect(view.model).toBe('claude')
    expect(String(JSON.stringify(view))).not.toContain('ghp_supersecretvalue')
  })
})

describe('h5Access is desktop-only (never read/written via browser)', () => {
  it('strips h5Access (incl. tokenHash) from the browser view', () => {
    store.data = {
      model: 'claude',
      h5Access: { enabled: true, tokenHash: 'a'.repeat(64), allowedOrigins: ['https://x'] },
    }
    const view = getBrowserSettings()
    expect(view.h5Access).toBeUndefined()
    expect(JSON.stringify(view)).not.toContain('a'.repeat(64))
  })

  it('ignores an h5Access payload sent from the browser (no remote takeover)', () => {
    store.data = {
      h5Access: { enabled: false, tokenHash: 'real', allowedOrigins: [] },
    }
    saveBrowserSettings({
      model: 'm',
      h5Access: { enabled: true, tokenHash: 'attacker', allowedOrigins: ['https://evil.example.com'] },
    })
    expect(store.data.h5Access).toEqual({ enabled: false, tokenHash: 'real', allowedOrigins: [] })
    expect(store.data.model).toBe('m')
  })

  it('does not introduce h5Access when none existed', () => {
    store.data = {}
    saveBrowserSettings({ h5Access: { enabled: true } })
    expect('h5Access' in store.data).toBe(false)
  })
})

describe('saveBrowserSettings (secret preservation)', () => {
  it('restores real secrets when the phone echoes the masked placeholder', () => {
    store.data = {
      apiKey: 'sk-real-top',
      apiConfigs: [{ id: 'c1', apiKey: 'sk-real-config' }],
      manualConfig: { apiKey: 'sk-real-manual' },
      envVars: [{ id: 'e1', key: 'GH_TOKEN', value: 'ghp_real_value', enabled: true }],
    }
    // Phone sends back the masked view (as getBrowserSettings would have given it).
    saveBrowserSettings({
      apiKey: 'sk-r••••op',
      model: 'updated-model',
      apiConfigs: [{ id: 'c1', apiKey: 'sk-r••••ig' }],
      manualConfig: { apiKey: 'sk-r••••al' },
      envVars: [{ id: 'e1', key: 'GH_TOKEN', value: 'ghp••••ue', enabled: false }],
    })
    expect(store.data.apiKey).toBe('sk-real-top')
    expect((store.data.apiConfigs as Array<Record<string, unknown>>)[0].apiKey).toBe('sk-real-config')
    expect((store.data.manualConfig as Record<string, unknown>).apiKey).toBe('sk-real-manual')
    const envVars = store.data.envVars as Array<Record<string, unknown>>
    expect(envVars[0].value).toBe('ghp_real_value') // restored
    expect(envVars[0].enabled).toBe(false) // non-secret change applied
    expect(store.data.model).toBe('updated-model')
  })

  it('persists a genuinely new (unmasked) secret', () => {
    store.data = { envVars: [{ id: 'e1', key: 'K', value: 'old', enabled: true }] }
    saveBrowserSettings({ envVars: [{ id: 'e1', key: 'K', value: 'brand-new-secret', enabled: true }] })
    expect((store.data.envVars as Array<Record<string, unknown>>)[0].value).toBe('brand-new-secret')
  })
})
