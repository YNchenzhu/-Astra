import { describe, it, expect } from 'vitest'
import {
  getBuiltinDefaultBaseUrl,
  resolveProviderBaseUrl,
  describeInvalidBaseUrl,
} from './resolveProviderBaseUrl'

describe('resolveProviderBaseUrl', () => {
  it('returns trimmed user URL when non-empty', () => {
    expect(resolveProviderBaseUrl('anthropic', '  https://proxy.example  ')).toBe('https://proxy.example')
  })

  it('returns built-in default when stored is empty', () => {
    expect(resolveProviderBaseUrl('anthropic', '')).toBe('https://api.anthropic.com')
    expect(resolveProviderBaseUrl('anthropic', '   ')).toBe('https://api.anthropic.com')
    expect(resolveProviderBaseUrl('openai2', undefined)).toBe('https://api.openai.com/v1')
  })

  it('compatible has no default', () => {
    expect(getBuiltinDefaultBaseUrl('compatible')).toBe('')
    expect(resolveProviderBaseUrl('compatible', '')).toBe('')
  })
})

describe('describeInvalidBaseUrl', () => {
  it('accepts empty / whitespace (means: use built-in default)', () => {
    expect(describeInvalidBaseUrl('')).toBeNull()
    expect(describeInvalidBaseUrl('   ')).toBeNull()
    expect(describeInvalidBaseUrl(undefined)).toBeNull()
  })

  it('accepts well-formed http(s) URLs', () => {
    expect(describeInvalidBaseUrl('https://api.openai.com/v1')).toBeNull()
    expect(describeInvalidBaseUrl('http://localhost:8000/v1')).toBeNull()
    expect(describeInvalidBaseUrl('  https://proxy.example  ')).toBeNull()
  })

  it('flags Anthropic-style API keys typed into the URL field', () => {
    const keyLikeValue = ['sk', 'example'.repeat(8)].join('-')
    const msg = describeInvalidBaseUrl(keyLikeValue)
    expect(msg).not.toBeNull()
    expect(msg).toContain('API 密钥')
  })

  it('flags Gemini-style API keys typed into the URL field', () => {
    const keyLikeValue = ['AI', 'za', 'sample-key-material'].join('')
    const msg = describeInvalidBaseUrl(keyLikeValue)
    expect(msg).not.toBeNull()
    expect(msg).toContain('API 密钥')
  })

  it('flags non-URL strings that are not key-shaped', () => {
    const msg = describeInvalidBaseUrl('not a url')
    expect(msg).not.toBeNull()
    expect(msg).toContain('http')
  })

  it('rejects non-http(s) protocols', () => {
    expect(describeInvalidBaseUrl('ftp://example.com')).not.toBeNull()
    expect(describeInvalidBaseUrl('file:///etc/hosts')).not.toBeNull()
  })
})
