import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { generatePairingCode, loadImConfig, saveImConfig, setWechatCredentials, unbindWechat } from './imConfig'

let tmpDir = ''
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-config-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function readSaved(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'adapters.json'), 'utf-8'))
}

describe('imConfig', () => {
  it('defaults to an empty view without a config file', () => {
    const view = loadImConfig()
    expect(view.wechat.hasBotToken).toBe(false)
    expect(view.wechat.botTokenPreview).toBeNull()
    expect(view.pairing.active).toBe(false)
    expect(view.serverUrl).toBe('')
  })

  it('saves wechat credentials and masks the token on read', () => {
    const view = saveImConfig({
      serverUrl: 'ws://127.0.0.1:5174',
      wechat: { accountId: 'acc-1', botToken: 'super-secret-token-1234', baseUrl: 'https://ilink' },
    })
    expect(view.serverUrl).toBe('ws://127.0.0.1:5174')
    expect(view.wechat.accountId).toBe('acc-1')
    expect(view.wechat.hasBotToken).toBe(true)
    // Preview is masked and never the raw token.
    expect(view.wechat.botTokenPreview).toMatch(/••••/)
    expect(view.wechat.botTokenPreview).not.toContain('secret')
    // On disk the real token is stored (the adapter needs it).
    const saved = readSaved() as { wechat: { botToken: string } }
    expect(saved.wechat.botToken).toBe('super-secret-token-1234')
  })

  it('treats a masked token on save as "unchanged"', () => {
    saveImConfig({ wechat: { botToken: 'real-token-abcdef' } })
    const masked = loadImConfig().wechat.botTokenPreview as string
    // Re-save passing the masked preview back → token must be preserved.
    saveImConfig({ wechat: { accountId: 'acc-2', botToken: masked } })
    const saved = readSaved() as { wechat: { botToken: string; accountId: string } }
    expect(saved.wechat.botToken).toBe('real-token-abcdef')
    expect(saved.wechat.accountId).toBe('acc-2')
  })

  it('preserves unrelated fields in adapters.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'adapters.json'),
      JSON.stringify({ telegram: { botToken: 'keep' }, future: { x: 1 } }),
    )
    saveImConfig({ wechat: { accountId: 'acc' } })
    const saved = readSaved() as { telegram: { botToken: string }; future: { x: number } }
    expect(saved.telegram.botToken).toBe('keep')
    expect(saved.future).toEqual({ x: 1 })
  })

  it('normalizes allowedUsers (trims, drops blanks)', () => {
    const view = saveImConfig({ wechat: { allowedUsers: [' u1 ', '', 'u2'] } })
    expect(view.wechat.allowedUsers).toEqual(['u1', 'u2'])
  })

  it('persists QR-bound credentials and reports bound state', () => {
    const view = setWechatCredentials({
      accountId: 'bot-123',
      botToken: 'tok-from-qr',
      baseUrl: 'https://gw.example',
      userId: 'u-9',
    })
    expect(view.wechat.accountId).toBe('bot-123')
    expect(view.wechat.hasBotToken).toBe(true)
    expect(view.wechat.baseUrl).toBe('https://gw.example')
    const saved = readSaved() as { wechat: { botToken: string; userId: string } }
    expect(saved.wechat.botToken).toBe('tok-from-qr')
    expect(saved.wechat.userId).toBe('u-9')
  })

  it('unbinds: clears creds + authorization but keeps other fields', () => {
    setWechatCredentials({ accountId: 'a', botToken: 't', baseUrl: 'https://b' })
    saveImConfig({ wechat: { allowedUsers: ['u1'] }, defaultProjectDir: '/keep' })
    const view = unbindWechat()
    expect(view.wechat.accountId).toBe('')
    expect(view.wechat.hasBotToken).toBe(false)
    expect(view.wechat.allowedUsers).toEqual([])
    expect(view.defaultProjectDir).toBe('/keep')
  })

  it('generates a 6-char pairing code with a future expiry and marks it active', () => {
    const { code, expiresAt } = generatePairingCode()
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(expiresAt).toBeGreaterThan(Date.now())
    const saved = readSaved() as { pairing: { code: string; expiresAt: number } }
    expect(saved.pairing.code).toBe(code)
    expect(loadImConfig().pairing.active).toBe(true)
  })
})
