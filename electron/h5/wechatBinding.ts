/**
 * WeChat (iLink) QR bot-account binding — main-process port of the QR-login
 * helpers in `adapters/wechat/protocol.ts`. `electron/` cannot import the Bun
 * `adapters/` package (different module system + bun-types), so the small
 * binding surface is re-implemented here.
 *
 * Flow:
 *   1. `startWechatLogin()` → `GET ilink/bot/get_bot_qrcode` → a QR string,
 *      rendered to a PNG data URL for the Settings panel.
 *   2. The panel polls `pollWechatLogin(sessionKey)` → `GET
 *      ilink/bot/get_qrcode_status`; on `confirmed` the gateway returns
 *      `bot_token` / `ilink_bot_id` / `baseurl` / `ilink_user_id`, which we
 *      persist into `~/.claude/adapters.json` so the adapter picks them up.
 */
import crypto from 'node:crypto'
import QRCode from 'qrcode'
import { setWechatCredentials } from './imConfig'

const WECHAT_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const WECHAT_DEFAULT_BOT_TYPE = '3'
const ILINK_APP_ID = 'bot'
const CHANNEL_VERSION = '2.1.7'
const QR_LOGIN_TTL_MS = 5 * 60_000
const QR_STATUS_TIMEOUT_MS = 35_000

function buildClientVersion(version: string): number {
  const parts = version.split('.').map((p) => parseInt(p, 10))
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION)

type QrLoginStatus = 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'

interface ActiveLogin {
  sessionKey: string
  qrcode: string
  startedAt: number
  currentApiBaseUrl: string
}

interface QrStatusResponse {
  status: QrLoginStatus
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

export interface WechatStartResult {
  sessionKey: string
  qrDataUrl: string
  message: string
}

export interface WechatPollResult {
  connected: boolean
  status: QrLoginStatus | 'not_started'
  message: string
}

const activeLogins = new Map<string, ActiveLogin>()

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < QR_LOGIN_TTL_MS
}

function purgeExpiredLogins(): void {
  for (const [key, login] of activeLogins) {
    if (!isLoginFresh(login)) activeLogins.delete(key)
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

function commonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
}

async function apiGet(baseUrl: string, endpoint: string, timeoutMs: number, label: string): Promise<string> {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url.toString(), { method: 'GET', headers: commonHeaders(), signal: controller.signal })
    const text = await res.text()
    if (!res.ok) throw new Error(`${label} ${res.status}: ${text}`)
    return text
  } finally {
    clearTimeout(timer)
  }
}

export async function startWechatLogin(): Promise<WechatStartResult> {
  purgeExpiredLogins()
  const sessionKey = crypto.randomUUID()
  const raw = await apiGet(
    WECHAT_DEFAULT_BASE_URL,
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(WECHAT_DEFAULT_BOT_TYPE)}`,
    15_000,
    'wechatQrStart',
  )
  const qr = JSON.parse(raw) as { qrcode?: string; qrcode_img_content?: string }
  if (!qr.qrcode || !qr.qrcode_img_content) {
    throw new Error('微信网关未返回二维码内容')
  }
  activeLogins.set(sessionKey, {
    sessionKey,
    qrcode: qr.qrcode,
    startedAt: Date.now(),
    currentApiBaseUrl: WECHAT_DEFAULT_BASE_URL,
  })
  // `qrcode_img_content` is the login string to encode into a QR image.
  const qrDataUrl = await QRCode.toDataURL(qr.qrcode_img_content, { margin: 1, width: 240 })
  return { sessionKey, qrDataUrl, message: '使用微信扫描二维码完成绑定。' }
}

async function pollQrStatus(apiBaseUrl: string, qrcode: string): Promise<QrStatusResponse> {
  try {
    const raw = await apiGet(
      apiBaseUrl,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      QR_STATUS_TIMEOUT_MS,
      'wechatQrStatus',
    )
    return JSON.parse(raw) as QrStatusResponse
  } catch {
    return { status: 'wait' }
  }
}

export async function pollWechatLogin(sessionKey: string): Promise<WechatPollResult> {
  purgeExpiredLogins()
  const login = activeLogins.get(sessionKey)
  if (!login) {
    return { connected: false, status: 'not_started', message: '当前没有进行中的微信绑定，请重新生成二维码。' }
  }

  const status = await pollQrStatus(login.currentApiBaseUrl, login.qrcode)
  switch (status.status) {
    case 'wait':
      return { connected: false, status: 'wait', message: '等待扫码。' }
    case 'scaned':
      return { connected: false, status: 'scaned', message: '已扫码，请在微信中确认。' }
    case 'scaned_but_redirect':
      if (status.redirect_host) login.currentApiBaseUrl = `https://${status.redirect_host}`
      return { connected: false, status: 'scaned_but_redirect', message: '已扫码，正在切换微信网关。' }
    case 'expired':
      activeLogins.delete(sessionKey)
      return { connected: false, status: 'expired', message: '二维码已过期，请重新生成。' }
    case 'confirmed': {
      activeLogins.delete(sessionKey)
      if (!status.bot_token || !status.ilink_bot_id) {
        return { connected: false, status: 'confirmed', message: '微信已确认，但服务端未返回完整凭据。' }
      }
      setWechatCredentials({
        accountId: status.ilink_bot_id,
        botToken: status.bot_token,
        baseUrl: status.baseurl || login.currentApiBaseUrl || WECHAT_DEFAULT_BASE_URL,
        userId: status.ilink_user_id ?? '',
      })
      return { connected: true, status: 'confirmed', message: '微信绑定成功。' }
    }
    default:
      return { connected: false, status: 'wait', message: '等待扫码。' }
  }
}
