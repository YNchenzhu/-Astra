/**
 * upstream 报告 §8.5 — 外部通道权限中继（HTTP Webhook + 文本应答格式）。
 *
 * - 短 ID：5 位，字母表为 a–z 去掉 l（25 个字母）。
 * - 应答行：`(y|yes|n|no) <shortId>`（大小写不敏感）。
 * - 配置：`permissionRelayWebhookUrl` / `permissionRelayWebhookUrls`（磁盘设置）或
 *   `ASTRA_PERMISSION_RELAY_URL`（逗号分隔多个 URL）。
 */

import { readDiskSettings } from '../settings/settingsAccess'

/** 25 letters, excluding `l` (upstream report). */
const SHORT_ID_ALPHABET = 'abcdefghjkmnopqrstuvwxyz'

const PROFANITY_SUBSTRINGS = ['fuck', 'shit', 'damn', 'nazi', 'rape']

const shortIdToRequest = new Map<
  string,
  { requestId: string; expiresAt: number }
>()

const TTL_MS = 15 * 60 * 1000

let relayResolver: ((requestId: string, behavior: 'allow' | 'deny') => void) | null = null

export function setPermissionRelayResolver(
  fn: ((requestId: string, behavior: 'allow' | 'deny') => void) | null,
): void {
  relayResolver = fn
}

function cleanupExpired(): void {
  const now = Date.now()
  for (const [k, v] of shortIdToRequest) {
    if (v.expiresAt < now) shortIdToRequest.delete(k)
  }
}

function randomShortId5(): string {
  let s = ''
  for (let i = 0; i < 5; i++) {
    s += SHORT_ID_ALPHABET[Math.floor(Math.random() * SHORT_ID_ALPHABET.length)]!
  }
  return s
}

function isCleanShortId(id: string): boolean {
  const lower = id.toLowerCase()
  return !PROFANITY_SUBSTRINGS.some((w) => lower.includes(w))
}

export function collectPermissionRelayWebhookUrls(): string[] {
  const out: string[] = []
  const env = process.env.ASTRA_PERMISSION_RELAY_URL?.trim()
  if (env) {
    out.push(
      ...env
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
  }
  try {
    const s = readDiskSettings() as Record<string, unknown>
    const multi = s.permissionRelayWebhookUrls
    if (Array.isArray(multi)) {
      for (const u of multi) {
        if (typeof u === 'string' && u.trim()) out.push(u.trim())
      }
    }
    const one = s.permissionRelayWebhookUrl
    if (typeof one === 'string' && one.trim()) out.push(one.trim())
  } catch {
    /* disk settings optional */
  }
  return [...new Set(out)]
}

/**
 * 注册一条权限请求的外部中继：生成 shortId、写入映射、向各 Webhook POST JSON。
 * @returns shortId（写入 `permission_request` 事件供 UI / 机器人侧展示）
 */
export function attachPermissionRelay(payload: {
  requestId: string
  toolName: string
  description: string
  input: Record<string, unknown>
}): string {
  cleanupExpired()
  let shortId = randomShortId5()
  let guard = 0
  while (
    (shortIdToRequest.has(shortId) || !isCleanShortId(shortId)) &&
    guard < 64
  ) {
    shortId = randomShortId5()
    guard += 1
  }
  shortIdToRequest.set(shortId, {
    requestId: payload.requestId,
    expiresAt: Date.now() + TTL_MS,
  })

  const urls = collectPermissionRelayWebhookUrls()
  const body = JSON.stringify({
    type: 'astra_permission_request',
    shortId,
    requestId: payload.requestId,
    toolName: payload.toolName,
    description: payload.description,
    inputSummary: summarizeInput(payload.input),
    replyFormat: `(y|yes|n|no) ${shortId}`,
  })

  for (const url of urls) {
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {
      /* relay is best-effort */
    })
  }

  return shortId
}

function summarizeInput(input: Record<string, unknown>): string {
  try {
    const keys = Object.keys(input).slice(0, 8)
    return keys.length ? keys.join(', ') : '{}'
  } catch {
    return ''
  }
}

/** 解析 `(y|yes|n|no) abcde`（Telegram / Discord 文本回复子集）。 */
export function parsePermissionRelayReplyLine(line: string): {
  allow: boolean
  shortId: string
} | null {
  const t = line.trim()
  const m = t.match(/^(y|yes|n|no)\s+([a-z]{5})\b/i)
  if (!m) return null
  const verb = m[1]!.toLowerCase()
  const shortId = m[2]!.toLowerCase()
  const allow = verb === 'y' || verb === 'yes'
  return { allow, shortId }
}

/** 将一行中继答复应用到挂起的权限请求（若存在）。 */
export function applyPermissionRelayReply(line: string): boolean {
  const p = parsePermissionRelayReplyLine(line)
  if (!p) return false
  cleanupExpired()
  const row = shortIdToRequest.get(p.shortId)
  if (!row) return false
  shortIdToRequest.delete(p.shortId)
  relayResolver?.(row.requestId, p.allow ? 'allow' : 'deny')
  return true
}

/** 报告 §8.5 — 未配置 Webhook 时列出待配置通道（HTTP 中继）。 */
export function getUnconfiguredPermissionRelayChannels(): Array<{
  id: string
  reason: string
}> {
  const urls = collectPermissionRelayWebhookUrls()
  if (urls.length === 0) {
    return [
      {
        id: 'http-webhook',
        reason:
          '未配置 permissionRelayWebhookUrl / permissionRelayWebhookUrls 或 ASTRA_PERMISSION_RELAY_URL',
      },
    ]
  }
  return []
}
