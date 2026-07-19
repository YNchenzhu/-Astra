import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./settingsAccess', () => ({
  readDiskSettings: vi.fn(() => ({})),
}))

import { readDiskSettings } from './settingsAccess'
import {
  BRAVE_SEARCH_API_KEY_PLACEHOLDER,
  resolveBraveSearchApiKeyMeta,
} from './webSearchSettings'

describe('resolveBraveSearchApiKeyMeta', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.mocked(readDiskSettings).mockReturnValue({})
  })

  it('returns key from persisted webSearchBraveApiKey', () => {
    vi.mocked(readDiskSettings).mockReturnValue({ webSearchBraveApiKey: 'bsa-real' })
    const m = resolveBraveSearchApiKeyMeta()
    expect(m.key).toBe('bsa-real')
    expect(m.source).toBe('settings:webSearchBraveApiKey')
  })

  it('ignores process.env.BRAVE_API_KEY', () => {
    vi.stubEnv('BRAVE_API_KEY', 'env-only')
    vi.mocked(readDiskSettings).mockReturnValue({ webSearchBraveApiKey: '' })
    const m = resolveBraveSearchApiKeyMeta()
    expect(m.key).toBeUndefined()
    expect(m.source).toBe('none')
  })

  it('treats preset placeholder as unset', () => {
    vi.mocked(readDiskSettings).mockReturnValue({
      webSearchBraveApiKey: BRAVE_SEARCH_API_KEY_PLACEHOLDER,
    })
    const m = resolveBraveSearchApiKeyMeta()
    expect(m.key).toBeUndefined()
    expect(m.source).toBe('none')
  })
})
