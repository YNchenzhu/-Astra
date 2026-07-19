import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  corsHeadersForOrigin,
  extractToken,
  isAlwaysAllowedOrigin,
  isLocalNavigationOrigin,
  isLocalTrustedRequest,
  isOriginAllowed,
  isProtectedPath,
  normalizeOrigin,
} from './h5AccessPolicy'

function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('normalizeOrigin', () => {
  it('lowercases and strips trailing slash', () => {
    expect(normalizeOrigin('HTTPS://CC.Example.com/')).toBe('https://cc.example.com')
    expect(normalizeOrigin('  http://localhost:5173  ')).toBe('http://localhost:5173')
  })
})

describe('isOriginAllowed', () => {
  const allowed = ['https://cc.example.com', 'http://192.168.1.20:5173']

  it('matches allow-listed origins (case/slash-insensitive)', () => {
    expect(isOriginAllowed('https://cc.example.com', allowed)).toBe(true)
    expect(isOriginAllowed('https://cc.example.com/', allowed)).toBe(true)
    expect(isOriginAllowed('HTTP://192.168.1.20:5173', allowed)).toBe(true)
  })

  it('rejects unknown / empty origins and never wildcards', () => {
    expect(isOriginAllowed('https://evil.example.com', allowed)).toBe(false)
    expect(isOriginAllowed(null, allowed)).toBe(false)
    expect(isOriginAllowed('https://cc.example.com', [])).toBe(false)
    expect(isOriginAllowed('https://cc.example.com', ['*'])).toBe(false)
  })

  it('always allows loopback / file shell origins regardless of the list', () => {
    expect(isOriginAllowed('http://localhost:5173', [])).toBe(true)
    expect(isOriginAllowed('http://127.0.0.1:9000', [])).toBe(true)
    expect(isOriginAllowed('file://', [])).toBe(true)
    expect(isOriginAllowed('null', [])).toBe(true)
  })
})

describe('isAlwaysAllowedOrigin', () => {
  it('recognizes loopback hosts and the file shell, not LAN/remote', () => {
    expect(isAlwaysAllowedOrigin('http://localhost')).toBe(true)
    expect(isAlwaysAllowedOrigin('https://127.0.0.1:5174')).toBe(true)
    expect(isAlwaysAllowedOrigin('file://')).toBe(true)
    expect(isAlwaysAllowedOrigin('http://192.168.1.20:5173')).toBe(false)
    expect(isAlwaysAllowedOrigin('https://cc.example.com')).toBe(false)
    expect(isAlwaysAllowedOrigin(null)).toBe(false)
  })
})

describe('corsHeadersForOrigin', () => {
  it('returns CORS headers echoing the exact origin when allowed', () => {
    const headers = corsHeadersForOrigin('https://cc.example.com', ['https://cc.example.com'])
    expect(headers['Access-Control-Allow-Origin']).toBe('https://cc.example.com')
    expect(headers['Access-Control-Allow-Methods']).toContain('POST')
    expect(headers['Vary']).toBe('Origin')
  })

  it('returns an empty object for disallowed origins (no ACAO header)', () => {
    expect(corsHeadersForOrigin('https://evil.example.com', ['https://cc.example.com'])).toEqual({})
  })
})

describe('extractToken', () => {
  const url = new URL('http://localhost:5174/api/ping')

  it('reads a Bearer token from Authorization', () => {
    expect(extractToken(fakeReq({ authorization: 'Bearer abc123' }), url)).toBe('abc123')
    expect(extractToken(fakeReq({ authorization: 'bearer  spaced  ' }), url)).toBe('spaced')
  })

  it('falls back to the ?token= query param', () => {
    const withToken = new URL('http://localhost:5174/ws?token=qtok')
    expect(extractToken(fakeReq({}), withToken)).toBe('qtok')
  })

  it('returns null when neither is present', () => {
    expect(extractToken(fakeReq({}), url)).toBeNull()
    expect(extractToken(fakeReq({ authorization: 'Basic xyz' }), url)).toBeNull()
  })
})

describe('isLocalNavigationOrigin', () => {
  it('treats absent / local-shell origins as local navigation', () => {
    expect(isLocalNavigationOrigin(null)).toBe(true)
    expect(isLocalNavigationOrigin(undefined)).toBe(true)
    expect(isLocalNavigationOrigin('file://')).toBe(true)
    expect(isLocalNavigationOrigin('null')).toBe(true)
    expect(isLocalNavigationOrigin('http://localhost:5173')).toBe(true)
    expect(isLocalNavigationOrigin('http://127.0.0.1:9000')).toBe(true)
  })

  it('rejects real cross-site browser origins (even LAN)', () => {
    expect(isLocalNavigationOrigin('https://evil.example.com')).toBe(false)
    expect(isLocalNavigationOrigin('http://192.168.1.20:5173')).toBe(false)
  })
})

describe('isLocalTrustedRequest (H1: loopback + local origin)', () => {
  const loopback = (addr: string | null | undefined) =>
    addr === '127.0.0.1' || addr === '::1'

  it('trusts a loopback peer with no browser Origin (the IM adapter)', () => {
    expect(isLocalTrustedRequest('127.0.0.1', null, loopback)).toBe(true)
    expect(isLocalTrustedRequest('127.0.0.1', 'file://', loopback)).toBe(true)
  })

  it('does NOT trust a loopback peer carrying a remote Origin (malicious page)', () => {
    // A web page on https://evil.com CAN reach 127.0.0.1 — must still be untrusted.
    expect(isLocalTrustedRequest('127.0.0.1', 'https://evil.example.com', loopback)).toBe(false)
  })

  it('does not trust a non-loopback peer regardless of origin', () => {
    expect(isLocalTrustedRequest('192.168.1.50', null, loopback)).toBe(false)
  })
})

describe('isProtectedPath', () => {
  it('protects /api and /ws surfaces only', () => {
    expect(isProtectedPath('/api/chat/send')).toBe(true)
    expect(isProtectedPath('/ws')).toBe(true)
    expect(isProtectedPath('/ws/session-1')).toBe(true)
    expect(isProtectedPath('/health')).toBe(false)
    expect(isProtectedPath('/')).toBe(false)
  })
})
