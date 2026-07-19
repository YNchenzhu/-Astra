/**
 * Coverage for the Baidu API key normaliser + mask.
 *
 * Baidu keys have the form `bce-v3/ALTAK-<token>`; the normaliser's job is
 * to survive the same paste pathologies we see for Brave (quotes / Bearer
 * prefix / Authorization header / whitespace) while preserving the critical
 * `/` and `-` characters that make the key valid.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./settingsAccess', () => ({
  readDiskSettings: vi.fn(() => ({})),
}))

import { readDiskSettings } from './settingsAccess'
import {
  BAIDU_API_KEY_PREFIX,
  maskBaiduApiKeyForDiagnostics,
  normalizeBaiduApiKey,
  resolveBaiduSearchApiKeyMeta,
} from './webSearchSettings'

describe('normalizeBaiduApiKey', () => {
  const SAMPLE_KEY = BAIDU_API_KEY_PREFIX + 'sample-key-material'

  it('passes a clean key through unchanged', () => {
    expect(normalizeBaiduApiKey(SAMPLE_KEY)).toBe(SAMPLE_KEY)
  })

  it('handles non-string inputs gracefully', () => {
    expect(normalizeBaiduApiKey(undefined)).toBe('')
    expect(normalizeBaiduApiKey(null)).toBe('')
    expect(normalizeBaiduApiKey(12345)).toBe('12345')
  })

  it('preserves the critical `/` and `-` inside the key', () => {
    // Regression guard: an earlier version stripped non-alphanumerics.
    const out = normalizeBaiduApiKey(SAMPLE_KEY)
    expect(out).toContain('bce-v3/ALTAK-')
    expect(out).toBe(SAMPLE_KEY)
  })

  it('strips surrounding ASCII quotes', () => {
    expect(normalizeBaiduApiKey(`"${SAMPLE_KEY}"`)).toBe(SAMPLE_KEY)
    expect(normalizeBaiduApiKey(`'${SAMPLE_KEY}'`)).toBe(SAMPLE_KEY)
    expect(normalizeBaiduApiKey(`\`${SAMPLE_KEY}\``)).toBe(SAMPLE_KEY)
  })

  it('strips surrounding Unicode curly quotes', () => {
    expect(normalizeBaiduApiKey(`\u201C${SAMPLE_KEY}\u201D`)).toBe(SAMPLE_KEY)
    expect(normalizeBaiduApiKey(`\u2018${SAMPLE_KEY}\u2019`)).toBe(SAMPLE_KEY)
  })

  it('strips `Bearer ` prefix (case-insensitive)', () => {
    expect(normalizeBaiduApiKey(`Bearer ${SAMPLE_KEY}`)).toBe(SAMPLE_KEY)
    expect(normalizeBaiduApiKey(`bearer ${SAMPLE_KEY}`)).toBe(SAMPLE_KEY)
    expect(normalizeBaiduApiKey(`BEARER   ${SAMPLE_KEY}`)).toBe(SAMPLE_KEY)
  })

  it('strips `Authorization:` HTTP-header prefix (case-insensitive)', () => {
    expect(normalizeBaiduApiKey(`Authorization: Bearer ${SAMPLE_KEY}`)).toBe(SAMPLE_KEY)
    expect(normalizeBaiduApiKey(`authorization:bearer ${SAMPLE_KEY}`)).toBe(SAMPLE_KEY)
  })

  it('unwraps quotes THEN strips header prefix (order matters)', () => {
    // Real-world curl paste: wrapped in quotes PLUS has `Authorization:` header.
    const paste = `"Authorization: Bearer ${SAMPLE_KEY}"`
    expect(normalizeBaiduApiKey(paste)).toBe(SAMPLE_KEY)
  })

  it('strips interior whitespace (Notepad roundtrip / NBSP / Tab)', () => {
    expect(normalizeBaiduApiKey('bce-v3/ALTAK\r\n-abcdefg')).toBe(
      'bce-v3/ALTAK-abcdefg',
    )
    expect(normalizeBaiduApiKey('bce-v3/ALTAK\t-abcdefg')).toBe(
      'bce-v3/ALTAK-abcdefg',
    )
    expect(normalizeBaiduApiKey('bce-v3/ALTAK \u00A0-abcdefg')).toBe(
      'bce-v3/ALTAK-abcdefg',
    )
  })

  it('still strips zero-width / BOM (parity with generic normalizer)', () => {
    expect(normalizeBaiduApiKey(`\uFEFF${SAMPLE_KEY}\u200B`)).toBe(SAMPLE_KEY)
  })

  it('empty / whitespace-only input returns ""', () => {
    expect(normalizeBaiduApiKey('')).toBe('')
    expect(normalizeBaiduApiKey('   ')).toBe('')
    expect(normalizeBaiduApiKey('\r\n')).toBe('')
  })

  it('worst-case paste from Baidu docs cURL block round-trips clean', () => {
    // "Authorization: Bearer bce-v3/ALTAK-xxx" enclosed in outer quotes.
    const paste = `"Authorization: Bearer ${SAMPLE_KEY}"`
    expect(normalizeBaiduApiKey(paste)).toBe(SAMPLE_KEY)
  })
})

describe('maskBaiduApiKeyForDiagnostics', () => {
  it('returns "(none)" for empty / missing', () => {
    expect(maskBaiduApiKeyForDiagnostics('')).toBe('(none)')
    expect(maskBaiduApiKeyForDiagnostics(undefined)).toBe('(none)')
    expect(maskBaiduApiKeyForDiagnostics(null)).toBe('(none)')
  })

  it('hides short keys (too little entropy to safely preview)', () => {
    expect(maskBaiduApiKeyForDiagnostics('short')).toBe('(hidden, 5 chars)')
  })

  it('shows the full prefix when available (proves key shape to user)', () => {
    const k = BAIDU_API_KEY_PREFIX + 'abcdefghij1234'
    expect(maskBaiduApiKeyForDiagnostics(k)).toBe(
      `bce-v3/ALTAK-…1234 (${k.length} chars)`,
    )
  })

  it('never leaks more than the 13-char prefix + 4-char tail', () => {
    const k = BAIDU_API_KEY_PREFIX + 'x'.repeat(80) + 'abcd'
    const masked = maskBaiduApiKeyForDiagnostics(k)
    // Exactly 13 chars head + '…' + 4 chars tail + metadata
    expect(masked).toMatch(/^bce-v3\/ALTAK-…abcd \(\d+ chars\)$/)
  })
})

describe('resolveBaiduSearchApiKeyMeta', () => {
  beforeEach(() => {
    vi.mocked(readDiskSettings).mockReturnValue({})
  })

  it('returns key from persisted webSearchBaiduApiKey', () => {
    const sampleKey = BAIDU_API_KEY_PREFIX + 'persisted-sample'
    vi.mocked(readDiskSettings).mockReturnValue({
      webSearchBaiduApiKey: sampleKey,
    })
    const m = resolveBaiduSearchApiKeyMeta()
    expect(m.key).toBe(sampleKey)
    expect(m.source).toBe('settings:webSearchBaiduApiKey')
  })

  it('returns none when key is unset', () => {
    vi.mocked(readDiskSettings).mockReturnValue({ webSearchBaiduApiKey: '' })
    const m = resolveBaiduSearchApiKeyMeta()
    expect(m.key).toBeUndefined()
    expect(m.source).toBe('none')
  })

  it('passes the stored key through the normaliser (quotes get stripped)', () => {
    vi.mocked(readDiskSettings).mockReturnValue({
      webSearchBaiduApiKey: '"bce-v3/ALTAK-quoted"',
    })
    expect(resolveBaiduSearchApiKeyMeta().key).toBe('bce-v3/ALTAK-quoted')
  })
})
