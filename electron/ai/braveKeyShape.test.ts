/**
 * Unit tests for Brave key shape warnings (local-only diagnostic, no network).
 *
 * These lock the Brave shape spec in place so future refactors can't
 * accidentally regress the "31-char BSA key is VALID" invariant. See the
 * issue history: an earlier revision asserted "exactly 32 chars" and
 * triggered false-positive warnings for legitimate 31-char keys.
 */

import { describe, it, expect } from 'vitest'
import {
  BRAVE_API_KEY_MIN_LENGTH,
  BRAVE_API_KEY_PREFIX,
  BRAVE_API_KEY_REGEX,
  detectBraveKeyShapeWarnings,
} from './advancedTools'

describe('Brave API key shape constants', () => {
  it('prefix is BSA (not BSAI)', () => {
    expect(BRAVE_API_KEY_PREFIX).toBe('BSA')
  })

  it('min length is 23 (BSA + 20 body chars)', () => {
    expect(BRAVE_API_KEY_MIN_LENGTH).toBe(23)
  })

  it('canonical regex accepts BSA + >=20 alnum/underscore/dash', () => {
    expect(BRAVE_API_KEY_REGEX.test('BSA' + 'x'.repeat(20))).toBe(true)
    expect(BRAVE_API_KEY_REGEX.test('BSA' + 'x'.repeat(19))).toBe(false)
    expect(BRAVE_API_KEY_REGEX.test('BSAQjlHkaxSFHbcDl3DYuDhNOgwvBTs')).toBe(true)
    expect(BRAVE_API_KEY_REGEX.test('BSA-' + 'x'.repeat(20))).toBe(true)
    expect(BRAVE_API_KEY_REGEX.test('XYZ' + 'x'.repeat(20))).toBe(false)
  })
})

describe('detectBraveKeyShapeWarnings', () => {
  it('no warnings for a well-formed 32-char BSA key', () => {
    const goodKey = 'BSA' + 'x'.repeat(29)
    expect(detectBraveKeyShapeWarnings(goodKey)).toEqual([])
  })

  it('no warnings for a well-formed 31-char BSA key (real user report)', () => {
    // Exactly the key the user reported — valid per Brave's real spec.
    const userKey = 'BSAQjlHkaxSFHbcDl3DYuDhNOgwvBTs'
    expect(userKey.length).toBe(31)
    expect(detectBraveKeyShapeWarnings(userKey)).toEqual([])
  })

  it('no warnings for min-length 23-char BSA key', () => {
    const minKey = 'BSA' + 'y'.repeat(20) // 23 chars exactly
    expect(detectBraveKeyShapeWarnings(minKey)).toEqual([])
  })

  it('no warnings for keys using _ or - (allowed in charset)', () => {
    expect(detectBraveKeyShapeWarnings('BSA_abc_def_ghi_jkl_mno_pqr')).toEqual([])
    expect(detectBraveKeyShapeWarnings('BSA-abc-def-ghi-jkl-mno-pqr')).toEqual([])
  })

  it('flags too-short when total < 23 chars', () => {
    expect(detectBraveKeyShapeWarnings('BSA' + 'x'.repeat(19))).toEqual([
      'too-short',
    ])
    expect(detectBraveKeyShapeWarnings('BSAshort')).toEqual(['too-short'])
  })

  it('flags wrong-prefix when missing BSA', () => {
    const wrongPrefix = 'XYZ' + 'x'.repeat(29) // 32 chars, wrong prefix
    expect(detectBraveKeyShapeWarnings(wrongPrefix)).toEqual(['wrong-prefix'])
  })

  it('flags invalid-charset when the key contains symbols outside [A-Za-z0-9_-]', () => {
    const withSymbol = 'BSA' + 'x'.repeat(28) + '!' // 32 chars, bad char
    expect(detectBraveKeyShapeWarnings(withSymbol)).toEqual(['invalid-charset'])
    expect(detectBraveKeyShapeWarnings('BSA ' + 'x'.repeat(28))).toEqual([
      'invalid-charset',
    ])
  })

  it('accumulates multiple warnings when more than one anomaly is present', () => {
    // 7 chars, no BSA prefix, contains `$` → all three warnings.
    expect(detectBraveKeyShapeWarnings('abc$def')).toEqual([
      'too-short',
      'wrong-prefix',
      'invalid-charset',
    ])
  })

  it('empty string: flags too-short + wrong-prefix but NOT invalid-charset', () => {
    // We skip the charset check on empty input to avoid a misleading "invalid
    // charset" message when the real issue is the user has no key at all.
    expect(detectBraveKeyShapeWarnings('')).toEqual([
      'too-short',
      'wrong-prefix',
    ])
  })

  it('32-char key with underscore is fine (official charset)', () => {
    const with_underscore = 'BSA' + '_'.repeat(29)
    expect(detectBraveKeyShapeWarnings(with_underscore)).toEqual([])
  })
})
