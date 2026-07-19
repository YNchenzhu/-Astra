import { describe, it, expect } from 'vitest'
import { normalizeWebFetchUrlInput } from './webFetchNormalize'

describe('normalizeWebFetchUrlInput', () => {
  it('accepts https URLs', () => {
    expect(normalizeWebFetchUrlInput('  https://example.com/x  ')).toEqual({
      ok: true,
      url: 'https://example.com/x',
    })
  })

  it('accepts domain:hostname as https', () => {
    expect(normalizeWebFetchUrlInput('domain:example.com')).toEqual({
      ok: true,
      url: 'https://example.com',
    })
  })

  it('accepts domain: with full URL', () => {
    expect(normalizeWebFetchUrlInput('domain:http://localhost:8080/')).toEqual({
      ok: true,
      url: 'http://localhost:8080/',
    })
  })

  it('rejects bare host without domain prefix', () => {
    const r = normalizeWebFetchUrlInput('example.com')
    expect(r.ok).toBe(false)
  })

  it('rejects empty domain: and host/path with whitespace', () => {
    expect(normalizeWebFetchUrlInput('domain:  ').ok).toBe(false)
    expect(normalizeWebFetchUrlInput('domain:foo bar').ok).toBe(false)
  })
})
