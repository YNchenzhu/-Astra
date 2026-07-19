/**
 * IM adapter configuration manager.
 *
 * Reads/writes `~/.claude/adapters.json` (honouring `CLAUDE_CONFIG_DIR`) — the
 * exact file the ported IM adapters load via `adapters/common/config.ts` and
 * pair against via `adapters/common/pairing.ts`. This is the desktop-side
 * counterpart upstream exposes through its `adapterService`: it lets the user
 * enter WeChat credentials and mint a one-time pairing code without hand-editing
 * JSON.
 *
 * Secrets (`wechat.botToken`, `pairing.code`) are masked on read; a masked
 * value sent back on save is treated as "unchanged" so the UI never has to
 * round-trip the real secret.
 *
 * No Electron dependency — pure Node fs, so it is unit-testable in isolation.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

const SAFE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const PAIRING_CODE_LENGTH = 6
const PAIRING_TTL_MS = 60 * 60 * 1000
const MASK_SENTINEL = '••••••'

export interface ImPairedUser {
  userId: string | number
  displayName: string
  pairedAt: number
}

export interface ImWechatConfigView {
  accountId: string
  baseUrl: string
  botTokenPreview: string | null
  hasBotToken: boolean
  allowedUsers: string[]
  pairedUsers: ImPairedUser[]
}

export interface ImConfigView {
  serverUrl: string
  defaultProjectDir: string
  wechat: ImWechatConfigView
  pairing: { active: boolean; expiresAt: number | null }
}

export interface ImConfigPatch {
  serverUrl?: string
  defaultProjectDir?: string
  wechat?: {
    accountId?: string
    baseUrl?: string
    /** Pass the masked sentinel to keep the existing token. */
    botToken?: string
    allowedUsers?: string[]
  }
}

function getConfigPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'adapters.json')
}

function readRaw(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeRaw(data: Record<string, unknown>): void {
  const filePath = getConfigPath()
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp.${crypto.randomBytes(8).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, filePath)
}

function maskSecret(secret: string): string {
  if (!secret) return ''
  if (secret.length <= 8) return '••••'
  return `${secret.slice(0, 4)}••••${secret.slice(-2)}`
}

function isMasked(value: string | undefined): boolean {
  return typeof value === 'string' && (value === MASK_SENTINEL || value.includes('••••'))
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

export function loadImConfig(): ImConfigView {
  const raw = readRaw()
  const wc = asRecord(raw.wechat)
  const pairing = asRecord(raw.pairing)
  const botToken = typeof wc.botToken === 'string' ? wc.botToken : ''
  const expiresAt = typeof pairing.expiresAt === 'number' ? pairing.expiresAt : null
  return {
    serverUrl: typeof raw.serverUrl === 'string' ? raw.serverUrl : '',
    defaultProjectDir: typeof raw.defaultProjectDir === 'string' ? raw.defaultProjectDir : '',
    wechat: {
      accountId: typeof wc.accountId === 'string' ? wc.accountId : '',
      baseUrl: typeof wc.baseUrl === 'string' ? wc.baseUrl : '',
      botTokenPreview: botToken ? maskSecret(botToken) : null,
      hasBotToken: Boolean(botToken),
      allowedUsers: Array.isArray(wc.allowedUsers) ? wc.allowedUsers.map(String) : [],
      pairedUsers: Array.isArray(wc.pairedUsers) ? (wc.pairedUsers as ImPairedUser[]) : [],
    },
    pairing: {
      active: Boolean(pairing.code) && typeof expiresAt === 'number' && expiresAt > Date.now(),
      expiresAt,
    },
  }
}

export function saveImConfig(patch: ImConfigPatch): ImConfigView {
  const raw = readRaw()
  if (typeof patch.serverUrl === 'string') raw.serverUrl = patch.serverUrl.trim()
  if (typeof patch.defaultProjectDir === 'string') raw.defaultProjectDir = patch.defaultProjectDir.trim()

  if (patch.wechat) {
    const wc = asRecord(raw.wechat)
    if (typeof patch.wechat.accountId === 'string') wc.accountId = patch.wechat.accountId.trim()
    if (typeof patch.wechat.baseUrl === 'string') wc.baseUrl = patch.wechat.baseUrl.trim()
    if (Array.isArray(patch.wechat.allowedUsers)) {
      wc.allowedUsers = patch.wechat.allowedUsers.map((u) => String(u).trim()).filter(Boolean)
    }
    // Only overwrite the token when a real (non-masked) value is supplied.
    if (typeof patch.wechat.botToken === 'string' && !isMasked(patch.wechat.botToken)) {
      wc.botToken = patch.wechat.botToken.trim()
    }
    raw.wechat = wc
  }

  writeRaw(raw)
  return loadImConfig()
}

/**
 * Persist WeChat bot credentials obtained from QR binding. The published
 * desktop would restart the adapter sidecar here so new creds take effect.
 */
export function setWechatCredentials(creds: {
  accountId: string
  botToken: string
  baseUrl: string
  userId?: string
}): ImConfigView {
  const raw = readRaw()
  const wc = asRecord(raw.wechat)
  wc.accountId = creds.accountId
  wc.botToken = creds.botToken
  wc.baseUrl = creds.baseUrl
  if (creds.userId) wc.userId = creds.userId
  raw.wechat = wc
  writeRaw(raw)
  return loadImConfig()
}

/** Unbind the WeChat bot account: clear creds + user authorization (per docs). */
export function unbindWechat(): ImConfigView {
  const raw = readRaw()
  const wc = asRecord(raw.wechat)
  delete wc.accountId
  delete wc.botToken
  delete wc.userId
  wc.allowedUsers = []
  wc.pairedUsers = []
  raw.wechat = wc
  writeRaw(raw)
  return loadImConfig()
}

/** Mint a one-time 6-char pairing code (matches `adapters/common/pairing.ts`). */
export function generatePairingCode(): { code: string; expiresAt: number } {
  let code = ''
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += SAFE_ALPHABET[crypto.randomInt(SAFE_ALPHABET.length)]
  }
  const now = Date.now()
  const expiresAt = now + PAIRING_TTL_MS
  const raw = readRaw()
  raw.pairing = { code, expiresAt, createdAt: now }
  writeRaw(raw)
  return { code, expiresAt }
}
