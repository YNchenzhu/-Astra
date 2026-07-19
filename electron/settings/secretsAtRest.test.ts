import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8'),
  },
}))

describe('secretsAtRest', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('encryptSettingsSecretsForDisk round-trips nested api keys', async () => {
    const {
      encryptSettingsSecretsForDisk,
      decryptSettingsSecretsInPlace,
      SETTINGS_SECRET_PREFIX,
    } = await import('./secretsAtRest')

    const plain = {
      apiKey: 'sk-top',
      webSearchBraveApiKey: 'brave-xx',
      manualConfig: { apiKey: 'sk-manual', baseUrl: '' },
      apiConfigs: [{ id: '1', apiKey: 'sk-cfg', providerId: 'x' }],
      theme: 'dark',
    }
    const enc = encryptSettingsSecretsForDisk(plain)
    expect(enc.apiKey).toContain(SETTINGS_SECRET_PREFIX)
    expect(enc.theme).toBe('dark')

    decryptSettingsSecretsInPlace(enc as Record<string, unknown>)
    expect(enc.apiKey).toBe('sk-top')
    expect(enc.webSearchBraveApiKey).toBe('brave-xx')
    expect((enc.manualConfig as { apiKey: string }).apiKey).toBe('sk-manual')
    expect((enc.apiConfigs as { apiKey: string }[])[0].apiKey).toBe('sk-cfg')
  })
})
