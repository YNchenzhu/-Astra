import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable in-memory backing store so loadH5Settings/saveH5Settings round-trip
// without touching disk or Electron.
const store = vi.hoisted(() => ({ data: {} as Record<string, unknown> }))

vi.mock('../settings/settingsStore', () => ({
  loadSettings: () => store.data,
  saveSettings: (s: Record<string, unknown>) => {
    store.data = s
  },
}))

import {
  generateAndStoreH5Token,
  hashH5Token,
  loadH5Settings,
  normalizeAllowedOrigin,
  normalizeHost,
  normalizePublicBaseUrl,
  saveH5Settings,
  toH5StatusForRenderer,
  verifyH5Token,
} from './h5Settings'

beforeEach(() => {
  store.data = {}
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('normalizeAllowedOrigin', () => {
  it('returns the bare origin for valid http/https inputs', () => {
    expect(normalizeAllowedOrigin('https://cc.example.com/path')).toBe('https://cc.example.com')
    expect(normalizeAllowedOrigin('  http://192.168.1.20:5173  ')).toBe('http://192.168.1.20:5173')
  })

  it('rejects wildcards, credentials, non-http schemes and junk', () => {
    expect(normalizeAllowedOrigin('https://*.example.com')).toBeNull()
    expect(normalizeAllowedOrigin('https://user:pass@cc.example.com')).toBeNull()
    expect(normalizeAllowedOrigin('ftp://cc.example.com')).toBeNull()
    expect(normalizeAllowedOrigin('not a url')).toBeNull()
    expect(normalizeAllowedOrigin('')).toBeNull()
  })
})

describe('normalizePublicBaseUrl', () => {
  it('strips the trailing slash and keeps a custom path', () => {
    expect(normalizePublicBaseUrl('https://cc.example.com/')).toBe('https://cc.example.com')
    expect(normalizePublicBaseUrl('https://cc.example.com/app/')).toBe('https://cc.example.com/app')
  })

  it('rejects credentials / bad scheme / empty', () => {
    expect(normalizePublicBaseUrl('https://u:p@cc.example.com')).toBeNull()
    expect(normalizePublicBaseUrl('ws://cc.example.com')).toBeNull()
    expect(normalizePublicBaseUrl('')).toBeNull()
    expect(normalizePublicBaseUrl(null)).toBeNull()
    expect(normalizePublicBaseUrl(123)).toBeNull()
  })
})

describe('normalizeHost', () => {
  it('accepts a bare host/IP and extracts the hostname from a URL', () => {
    expect(normalizeHost('0.0.0.0')).toBe('0.0.0.0')
    expect(normalizeHost('  127.0.0.1 ')).toBe('127.0.0.1')
    expect(normalizeHost('http://192.168.1.5:5174')).toBe('192.168.1.5')
  })

  it('rejects values with paths / spaces / empties', () => {
    expect(normalizeHost('1.2.3.4/x')).toBeNull()
    expect(normalizeHost('a b')).toBeNull()
    expect(normalizeHost('')).toBeNull()
    expect(normalizeHost(undefined)).toBeNull()
  })
})

describe('hashH5Token / verifyH5Token', () => {
  it('hashes deterministically (sha256 hex)', () => {
    expect(hashH5Token('abc')).toBe(hashH5Token('abc'))
    expect(hashH5Token('abc')).toMatch(/^[a-f0-9]{64}$/)
    expect(hashH5Token('abc')).not.toBe(hashH5Token('abd'))
  })

  it('verifies the active token and rejects wrong / missing ones', () => {
    const { token } = generateAndStoreH5Token()
    expect(verifyH5Token(token)).toBe(true)
    expect(verifyH5Token('wrong')).toBe(false)
    expect(verifyH5Token(null)).toBe(false)
    expect(verifyH5Token('')).toBe(false)
  })

  it('returns false when no token has been generated', () => {
    expect(verifyH5Token('anything')).toBe(false)
  })
})

describe('saveH5Settings (coercion + persistence)', () => {
  it('drops invalid origins and clamps an out-of-range port', () => {
    const next = saveH5Settings({
      allowedOrigins: ['https://ok.example.com', 'https://*.bad.com', 'nonsense'],
      port: 70000,
    })
    expect(next.allowedOrigins).toEqual(['https://ok.example.com'])
    expect(next.port).toBe(5174) // default — 70000 is out of range
  })

  it('re-reads what it persisted', () => {
    saveH5Settings({ host: '0.0.0.0', port: 6000 })
    const loaded = loadH5Settings()
    expect(loaded.host).toBe('0.0.0.0')
    expect(loaded.port).toBe(6000)
  })

  it('clears the token hash when persisted as null (disable parity)', () => {
    generateAndStoreH5Token()
    expect(loadH5Settings().tokenHash).not.toBeNull()
    saveH5Settings({ enabled: false, tokenHash: null, tokenPreview: null })
    const after = loadH5Settings()
    expect(after.tokenHash).toBeNull()
    expect(after.tokenPreview).toBeNull()
    expect(after.enabled).toBe(false)
    expect(verifyH5Token('any')).toBe(false)
  })
})

describe('toH5StatusForRenderer', () => {
  it('strips the secret hash and exposes hasToken', () => {
    const { token } = generateAndStoreH5Token()
    const view = toH5StatusForRenderer(loadH5Settings())
    expect((view as Record<string, unknown>).tokenHash).toBeUndefined()
    expect(view.hasToken).toBe(true)
    expect(view.tokenPreview).toBeTypeOf('string')
    // sanity: the raw token never appears in the renderer view
    expect(JSON.stringify(view)).not.toContain(token)
  })
})
