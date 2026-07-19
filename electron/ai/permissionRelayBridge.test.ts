import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  parsePermissionRelayReplyLine,
  applyPermissionRelayReply,
  setPermissionRelayResolver,
  attachPermissionRelay,
  collectPermissionRelayWebhookUrls,
} from './permissionRelayBridge'
import { setDiskSettingsLoader } from '../settings/settingsAccess'

describe('permissionRelayBridge', () => {
  beforeEach(() => {
    setPermissionRelayResolver(null)
    setDiskSettingsLoader(() => ({}))
    delete process.env.ASTRA_PERMISSION_RELAY_URL
  })

  it('parses (y|yes|n|no) shortId lines', () => {
    expect(parsePermissionRelayReplyLine('y abcde')).toEqual({ allow: true, shortId: 'abcde' })
    expect(parsePermissionRelayReplyLine('YES ABCDE')).toEqual({ allow: true, shortId: 'abcde' })
    expect(parsePermissionRelayReplyLine('no xyzwv')).toEqual({ allow: false, shortId: 'xyzwv' })
    expect(parsePermissionRelayReplyLine('bogus')).toBeNull()
  })

  it('resolves via relay when shortId registered', () => {
    const spy = vi.fn()
    setPermissionRelayResolver(spy)
    const shortId = attachPermissionRelay({
      requestId: 'perm-test-1',
      toolName: 'Write',
      description: 'x',
      input: {},
    })
    expect(shortId).toHaveLength(5)
    const ok = applyPermissionRelayReply(`y ${shortId}`)
    expect(ok).toBe(true)
    expect(spy).toHaveBeenCalledWith('perm-test-1', 'allow')
  })

  it('collectPermissionRelayWebhookUrls reads env and disk', () => {
    process.env.ASTRA_PERMISSION_RELAY_URL = 'https://a.example/hook,https://b.example/hook'
    setDiskSettingsLoader(() => ({
      permissionRelayWebhookUrl: 'https://c.example/hook',
    }))
    const urls = collectPermissionRelayWebhookUrls()
    expect(urls).toContain('https://a.example/hook')
    expect(urls).toContain('https://b.example/hook')
    expect(urls).toContain('https://c.example/hook')
  })
})
