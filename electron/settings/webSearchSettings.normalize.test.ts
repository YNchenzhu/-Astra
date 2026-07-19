/**
 * Coverage for {@link normalizeBraveApiKey} — the stricter normaliser added
 * in response to repeated `SUBSCRIPTION_TOKEN_INVALID` reports.
 *
 * Every case represents a real paste source observed in support tickets /
 * the Brave docs, so DO NOT remove items lightly — the table IS the spec.
 */

import { describe, it, expect } from 'vitest'
import {
  maskBraveApiKeyForDiagnostics,
  normalizeBraveApiKey,
} from './webSearchSettings'

describe('normalizeBraveApiKey', () => {
  it('passes a clean key through unchanged', () => {
    expect(normalizeBraveApiKey('BSAabcDEF1234567890')).toBe('BSAabcDEF1234567890')
  })

  it('handles non-string inputs gracefully', () => {
    expect(normalizeBraveApiKey(undefined)).toBe('')
    expect(normalizeBraveApiKey(null)).toBe('')
    expect(normalizeBraveApiKey(42)).toBe('42')
  })

  it('strips surrounding ASCII double quotes', () => {
    expect(normalizeBraveApiKey('"BSAabc12345678"')).toBe('BSAabc12345678')
  })

  it('strips surrounding ASCII single quotes', () => {
    expect(normalizeBraveApiKey("'BSAabc12345678'")).toBe('BSAabc12345678')
  })

  it('strips surrounding backticks', () => {
    expect(normalizeBraveApiKey('`BSAabc12345678`')).toBe('BSAabc12345678')
  })

  it('strips curly Unicode double quotes (from rich-text docs paste)', () => {
    expect(normalizeBraveApiKey('\u201CBSAabc12345678\u201D')).toBe('BSAabc12345678')
  })

  it('strips curly Unicode single quotes', () => {
    expect(normalizeBraveApiKey('\u2018BSAabc12345678\u2019')).toBe('BSAabc12345678')
  })

  it('strips only ONE layer of surrounding quotes (nested is user intent)', () => {
    expect(normalizeBraveApiKey('""BSAabc12345678""')).toBe('"BSAabc12345678"')
  })

  it('strips `Bearer ` prefix (case-insensitive)', () => {
    expect(normalizeBraveApiKey('Bearer BSAabc12345678')).toBe('BSAabc12345678')
    expect(normalizeBraveApiKey('bearer BSAabc12345678')).toBe('BSAabc12345678')
    expect(normalizeBraveApiKey('BEARER BSAabc12345678')).toBe('BSAabc12345678')
  })

  it('strips `X-Subscription-Token:` HTTP-header prefix (case-insensitive)', () => {
    expect(normalizeBraveApiKey('X-Subscription-Token: BSAabc12345678')).toBe(
      'BSAabc12345678',
    )
    expect(normalizeBraveApiKey('x-subscription-token:BSAabc12345678')).toBe(
      'BSAabc12345678',
    )
    expect(normalizeBraveApiKey('X-SUBSCRIPTION-TOKEN:   BSAabc12345678')).toBe(
      'BSAabc12345678',
    )
  })

  it('combines: header prefix + surrounding quotes + interior whitespace', () => {
    // Raw curl snippet → wrapping quotes + header prefix + a stray space.
    expect(
      normalizeBraveApiKey('"X-Subscription-Token: BSA abc 12345678"'),
    ).toBe('BSAabc12345678')
  })

  it('strips interior whitespace (Notepad roundtrip inserts \\r\\n)', () => {
    expect(normalizeBraveApiKey('BSAabc\r\n12345678')).toBe('BSAabc12345678')
    expect(normalizeBraveApiKey('BSAabc\t12345678')).toBe('BSAabc12345678')
    expect(normalizeBraveApiKey('BSA abc 12345678')).toBe('BSAabc12345678')
  })

  it('strips NBSP (U+00A0) — common from browser copy', () => {
    expect(normalizeBraveApiKey('BSA\u00A0abc12345678')).toBe('BSAabc12345678')
  })

  it('still strips zero-width chars + BOM (parity with base normalizer)', () => {
    expect(normalizeBraveApiKey('\uFEFFBSAabc12345678\u200B')).toBe(
      'BSAabc12345678',
    )
  })

  it('leading/trailing whitespace around a quoted value is trimmed first', () => {
    expect(normalizeBraveApiKey('   "BSAabc12345678"  ')).toBe(
      'BSAabc12345678',
    )
  })

  it('empty / whitespace-only input returns ""', () => {
    expect(normalizeBraveApiKey('')).toBe('')
    expect(normalizeBraveApiKey('   ')).toBe('')
    expect(normalizeBraveApiKey('\t\r\n')).toBe('')
  })

  it('the SUBSCRIPTION_TOKEN_INVALID worst-case paste shape round-trips clean', () => {
    // What a typical user pastes verbatim from the Brave docs' cURL block:
    //    -H "X-Subscription-Token: BSAabcdef1234567890"
    // After copy-paste the `-H "` is usually omitted, leaving:
    //    "X-Subscription-Token: BSAabcdef1234567890"
    const paste = '"X-Subscription-Token: BSAabcdef1234567890"'
    expect(normalizeBraveApiKey(paste)).toBe('BSAabcdef1234567890')
  })
})

describe('maskBraveApiKeyForDiagnostics', () => {
  it('returns "(none)" for empty / missing', () => {
    expect(maskBraveApiKeyForDiagnostics('')).toBe('(none)')
    expect(maskBraveApiKeyForDiagnostics(undefined)).toBe('(none)')
    expect(maskBraveApiKeyForDiagnostics(null)).toBe('(none)')
  })

  it('fully redacts short keys to avoid leaking test values', () => {
    expect(maskBraveApiKeyForDiagnostics('short')).toBe('(hidden, 5 chars)')
    expect(maskBraveApiKeyForDiagnostics('abcdefghijk')).toBe('(hidden, 11 chars)')
  })

  it('shows first 3 + last 4 chars + length for normal keys', () => {
    expect(maskBraveApiKeyForDiagnostics('BSAabcdefghij1234')).toBe(
      'BSA…1234 (17 chars)',
    )
  })

  it('does not leak more than 7 characters even for very long keys', () => {
    const long = 'BSA' + 'x'.repeat(100) + '9999'
    const masked = maskBraveApiKeyForDiagnostics(long)
    // Masked preview retains exactly 3 + '…' + 4 + metadata
    expect(masked).toMatch(/^BSA…9999 \(\d+ chars\)$/)
  })
})
