/**
 * Web Search tool — Brave, Baidu, and DuckDuckGo search with key testing.
 */


import { type ToolResult } from './tools'
import {
  resolveBraveSearchApiKeyMeta,
  maskBraveApiKeyForDiagnostics,
  resolveBaiduSearchApiKeyMeta,
  maskBaiduApiKeyForDiagnostics,
  BAIDU_API_KEY_PREFIX,
} from '../settings/webSearchSettings'
import { safeSliceCodeUnits } from '../utils/unicodeSanitize'

/** Registry / worker — keep in sync with `registryBuiltinTools` WebSearch + subAgentWorker. */
export const WEB_SEARCH_MAX_RESULT_CHARS = 24_000

/** DDG JSON responses are sometimes pathological megabytes; cap before `JSON.parse` + string work. */
const DDG_MAX_RESPONSE_CHARS = 512_000
/** Per-field caps — DDG `AbstractText` / topic `Text` can be unbounded. */
const DDG_ABSTRACT_MAX_CHARS = 2_500
const DDG_TOPIC_TEXT_MAX_CHARS = 800
/** Brave/Baidu JSON — bound parse size so a buggy/proxy payload cannot allocate multi‑MB trees in V8. */
const SEARCH_ENGINE_JSON_BODY_MAX_CHARS = 2_000_000

// Re-export so barrel file can forward it for backward compatibility.
export { BAIDU_API_KEY_PREFIX }

// ========== Brave API key tester ==========

export const BRAVE_API_KEY_PREFIX = 'BSA'
export const BRAVE_API_KEY_MIN_LENGTH = BRAVE_API_KEY_PREFIX.length + 20
export const BRAVE_API_KEY_REGEX = /^BSA[A-Za-z0-9_-]{20,}$/

export type BraveKeyShapeWarning =
  | 'too-short'
  | 'wrong-prefix'
  | 'invalid-charset'

export type BraveSecondaryProbeResult =
  | { kind: 'skipped' }
  | { kind: 'ok'; endpoint: string }
  | { kind: 'failed'; endpoint: string; status: number }
  | { kind: 'error'; endpoint: string; message: string }

export type BraveKeyTestResult =
  | {
      ok: true
      status: 200
      keyPreview: string
      message: string
      shapeWarnings?: BraveKeyShapeWarning[]
    }
  | {
      ok: false
      status: number
      reason:
        | 'none'
        | 'subscription_token_invalid'
        | 'validation'
        | 'rate_limit'
        | 'server'
        | 'network'
        | 'other'
      keyPreview: string
      message: string
      detail?: string
      shapeWarnings?: BraveKeyShapeWarning[]
      secondaryProbe?: BraveSecondaryProbeResult
    }

export function detectBraveKeyShapeWarnings(key: string): BraveKeyShapeWarning[] {
  const warnings: BraveKeyShapeWarning[] = []
  if (key.length < BRAVE_API_KEY_MIN_LENGTH) {
    warnings.push('too-short')
  }
  if (!key.startsWith(BRAVE_API_KEY_PREFIX)) {
    warnings.push('wrong-prefix')
  }
  if (key.length > 0 && !/^[A-Za-z0-9_-]+$/.test(key)) {
    warnings.push('invalid-charset')
  }
  return warnings
}

async function probeBraveSecondaryEndpoint(
  key: string,
): Promise<BraveSecondaryProbeResult> {
  const endpoint = 'https://api.search.brave.com/res/v1/summarizer/search'
  try {
    const u = new URL(endpoint)
    u.searchParams.set('q', 'brave api test')
    u.searchParams.set('key', '__probe__')
    const r = await fetch(u.toString(), {
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        'X-Subscription-Token': key,
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (r.ok) {
      return { kind: 'ok', endpoint: '/summarizer/search' }
    }
    let body = ''
    try {
      body = (await r.text()).slice(0, 300)
    } catch {
      /* ignore */
    }
    const tokenInvalid = /SUBSCRIPTION_TOKEN_INVALID/i.test(body)
    if (tokenInvalid) {
      return { kind: 'failed', endpoint: '/summarizer/search', status: r.status }
    }
    return { kind: 'ok', endpoint: '/summarizer/search' }
  } catch (e) {
    return {
      kind: 'error',
      endpoint: '/summarizer/search',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}

export async function testBraveApiKey(
  candidate?: string,
): Promise<BraveKeyTestResult> {
  const { normalizeBraveApiKey } = await import('../settings/webSearchSettings')

  let key: string
  if (candidate !== undefined && candidate !== null) {
    key = normalizeBraveApiKey(candidate)
  } else {
    const resolved = resolveBraveSearchApiKeyMeta().key
    key = resolved ?? ''
  }

  if (!key) {
    return {
      ok: false,
      status: 0,
      reason: 'none',
      keyPreview: maskBraveApiKeyForDiagnostics(''),
      message: '未设置 Brave API Key。在上方输入框填写后再点击「测试」。',
    }
  }

  const preview = maskBraveApiKeyForDiagnostics(key)
  const shapeWarnings = detectBraveKeyShapeWarnings(key)
  try {
    const u = new URL('https://api.search.brave.com/res/v1/web/search')
    u.searchParams.set('q', 'test')
    u.searchParams.set('count', '1')
    const r = await fetch(u.toString(), {
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        'X-Subscription-Token': key,
      },
      signal: AbortSignal.timeout(15_000),
    })

    if (r.ok) {
      return {
        ok: true,
        status: 200,
        keyPreview: preview,
        message: `密钥有效，Brave 返回 HTTP 200。发送的密钥是 ${preview}。`,
        ...(shapeWarnings.length > 0 ? { shapeWarnings } : {}),
      }
    }

    let bodyText = ''
    try {
      bodyText = await r.text()
    } catch {
      /* ignore */
    }
    const snippet =
      bodyText.length > 600 ? `${bodyText.slice(0, 600)}…` : bodyText
    const isTokenInvalid = /SUBSCRIPTION_TOKEN_INVALID/i.test(snippet)
    const isValidation = r.status === 422 && !isTokenInvalid
    const isRateLimit = r.status === 429
    const isServer = r.status >= 500
    const reason: Exclude<BraveKeyTestResult, { ok: true }>['reason'] = isTokenInvalid
      ? 'subscription_token_invalid'
      : isValidation
        ? 'validation'
        : isRateLimit
          ? 'rate_limit'
          : isServer
            ? 'server'
            : 'other'

    let secondaryProbe: BraveSecondaryProbeResult | undefined
    if (isTokenInvalid) {
      secondaryProbe = await probeBraveSecondaryEndpoint(key)
    }

    const baseMsg = (() => {
      if (isTokenInvalid) {
        const parts: string[] = [
          `Brave 拒绝了订阅 token。我们发送的密钥是 ${preview}。`,
        ]
        if (secondaryProbe?.kind === 'ok') {
          parts.push(
            '注意：同一密钥在另一个 Brave 端点通过了认证。这通常意味着你的订阅里没有开通 Web Search 产品——请到订阅页面确认。',
          )
        } else if (secondaryProbe?.kind === 'failed') {
          parts.push(
            '另一个 Brave 端点也返回了 TOKEN_INVALID——密钥本身被全局拒绝，最常见的是订阅未激活或 Key 已在控制台被撤销/重建。',
          )
        }
        return parts.join(' ')
      }
      if (isValidation) return `Brave 返回 HTTP 422 验证失败（非 token 问题）。`
      if (isRateLimit) return `Brave 返回 429 — 套餐每秒/每月限额已达上限，稍后再试。`
      if (isServer) return `Brave 服务端错误 HTTP ${r.status} — 稍后再试。`
      return `Brave HTTP ${r.status} ${r.statusText}。`
    })()

    return {
      ok: false,
      status: r.status,
      reason,
      keyPreview: preview,
      message: baseMsg,
      detail: snippet.trim() || undefined,
      ...(shapeWarnings.length > 0 ? { shapeWarnings } : {}),
      ...(secondaryProbe !== undefined ? { secondaryProbe } : {}),
    }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      reason: 'network',
      keyPreview: preview,
      message: `无法连接 Brave Search：${e instanceof Error ? e.message : String(e)}`,
      ...(shapeWarnings.length > 0 ? { shapeWarnings } : {}),
    }
  }
}

// ========== Baidu AI Search ==========

export const BAIDU_API_KEY_MIN_LENGTH = BAIDU_API_KEY_PREFIX.length + 8

export type BaiduKeyShapeWarning =
  | 'too-short'
  | 'wrong-prefix'
  | 'invalid-charset'

export function detectBaiduKeyShapeWarnings(key: string): BaiduKeyShapeWarning[] {
  const warnings: BaiduKeyShapeWarning[] = []
  if (key.length < BAIDU_API_KEY_MIN_LENGTH) warnings.push('too-short')
  if (!key.startsWith(BAIDU_API_KEY_PREFIX)) warnings.push('wrong-prefix')
  if (key.length > 0 && !/^[A-Za-z0-9_./-]+$/.test(key)) {
    warnings.push('invalid-charset')
  }
  return warnings
}

export type BaiduKeyTestResult =
  | {
      ok: true
      status: 200
      keyPreview: string
      message: string
      shapeWarnings?: BaiduKeyShapeWarning[]
    }
  | {
      ok: false
      status: number
      reason:
        | 'none'
        | 'auth_invalid'
        | 'rate_limit'
        | 'server'
        | 'network'
        | 'other'
      keyPreview: string
      message: string
      detail?: string
      shapeWarnings?: BaiduKeyShapeWarning[]
    }

type BaiduRawReference = {
  title?: string
  url?: string
  content?: string
  snippet?: string
}

function buildBaiduSearchRequestBody(params: {
  query: string
  count: number
  freshness?: string
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content: params.query }],
    search_source: 'baidu_search_v2',
    resource_type_filter: [{ type: 'web', top_k: params.count }],
  }
  const freshness = params.freshness?.trim()
  if (freshness) {
    const now = new Date()
    const fmt = (d: Date): string => d.toISOString().slice(0, 10)
    const endStr = fmt(new Date(now.getTime() + 86_400_000))
    const pdMap: Record<string, number> = { pd: 1, pw: 6, pm: 30, py: 364 }
    const rangeMatch = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/.exec(freshness)
    if (freshness in pdMap) {
      const start = fmt(new Date(now.getTime() - pdMap[freshness]! * 86_400_000))
      body.search_filter = {
        range: { page_time: { gte: start, lt: endStr } },
      }
    } else if (rangeMatch) {
      body.search_filter = {
        range: { page_time: { gte: rangeMatch[1], lt: rangeMatch[2] } },
      }
    }
  }
  return body
}

async function baiduSearchRequest(params: {
  apiKey: string
  query: string
  count: number
  freshness?: string
  timeoutMs?: number
}): Promise<{ references: BaiduRawReference[] }> {
  const body = buildBaiduSearchRequestBody({
    query: params.query,
    count: params.count,
    freshness: params.freshness,
  })
  const r = await fetch('https://qianfan.baidubce.com/v2/ai_search/web_search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'X-Appbuilder-From': 'astra',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(params.timeoutMs ?? 20_000),
  })

  if (!r.ok) {
    let detail = ''
    try {
      const t = await r.text()
      detail = t.length > 600 ? `${t.slice(0, 600)}…` : t
    } catch {
      /* ignore */
    }
    throw new BaiduHttpError(r.status, r.statusText, detail)
  }

  const raw = await r.text()
  if (raw.length > SEARCH_ENGINE_JSON_BODY_MAX_CHARS) {
    throw new BaiduHttpError(
      413,
      'Payload Too Large',
      `response body ${raw.length} chars exceeds ${SEARCH_ENGINE_JSON_BODY_MAX_CHARS}`,
    )
  }
  let j: {
    code?: string | number
    message?: string
    references?: BaiduRawReference[]
  }
  try {
    j = JSON.parse(raw) as typeof j
  } catch {
    throw new BaiduHttpError(502, 'Bad Gateway', 'malformed JSON from Baidu AI Search')
  }
  if (j.code !== undefined && j.code !== null && String(j.code) !== '0') {
    throw new BaiduApiError(
      String(j.code),
      typeof j.message === 'string' ? j.message : 'Baidu API returned error code',
    )
  }
  return { references: Array.isArray(j.references) ? j.references : [] }
}

class BaiduHttpError extends Error {
  readonly status: number
  readonly statusText: string
  readonly detail: string
  constructor(status: number, statusText: string, detail: string) {
    super(`Baidu HTTP ${status} ${statusText}${detail ? ` — ${detail}` : ''}`)
    this.name = 'BaiduHttpError'
    this.status = status
    this.statusText = statusText
    this.detail = detail
  }
}
class BaiduApiError extends Error {
  readonly apiCode: string
  constructor(apiCode: string, message: string) {
    super(`Baidu API ${apiCode}: ${message}`)
    this.name = 'BaiduApiError'
    this.apiCode = apiCode
  }
}

async function toolWebSearchBaidu(
  query: string,
  opts: { maxResults: number; freshness?: string; apiKey: string },
): Promise<ToolResult> {
  try {
    const { references } = await baiduSearchRequest({
      apiKey: opts.apiKey,
      query,
      count: opts.maxResults,
      freshness: opts.freshness,
    })
    if (references.length === 0) {
      return { success: true, output: `No web results for "${query}" (Baidu).` }
    }
    const lines = references.slice(0, opts.maxResults).map((item, i) => {
      const title = safeSliceCodeUnits(
        ((item.title ?? '(no title)') || '').replace(/\s+/g, ' '),
        400,
      )
      const url = safeSliceCodeUnits(((item.url ?? '') || '').replace(/\s+/g, ' '), 2_000)
      const desc = safeSliceCodeUnits(
        ((item.content ?? item.snippet) ?? '').replace(/\s+/g, ' '),
        280,
      )
      return `${i + 1}. ${title}\n   ${url}\n   ${desc}`
    })
    return { success: true, output: safeSliceCodeUnits(lines.join('\n\n'), WEB_SEARCH_MAX_RESULT_CHARS) }
  } catch (e) {
    if (e instanceof BaiduHttpError) {
      return {
        success: false,
        error: `Baidu Search HTTP ${e.status}: ${e.statusText}${e.detail ? ` — ${e.detail}` : ''}`,
      }
    }
    if (e instanceof BaiduApiError) {
      return { success: false, error: e.message }
    }
    return {
      success: false,
      error: `Baidu Search failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

export async function testBaiduApiKey(
  candidate?: string,
): Promise<BaiduKeyTestResult> {
  const { normalizeBaiduApiKey } = await import('../settings/webSearchSettings')

  let key: string
  if (candidate !== undefined && candidate !== null) {
    key = normalizeBaiduApiKey(candidate)
  } else {
    const resolved = resolveBaiduSearchApiKeyMeta().key
    key = resolved ?? ''
  }

  if (!key) {
    return {
      ok: false,
      status: 0,
      reason: 'none',
      keyPreview: maskBaiduApiKeyForDiagnostics(''),
      message: '未设置 Baidu API Key。在上方输入框填写后再点击「测试」。',
    }
  }

  const preview = maskBaiduApiKeyForDiagnostics(key)
  const shapeWarnings = detectBaiduKeyShapeWarnings(key)

  try {
    const { references } = await baiduSearchRequest({
      apiKey: key,
      query: 'test',
      count: 1,
      timeoutMs: 15_000,
    })
    return {
      ok: true,
      status: 200,
      keyPreview: preview,
      message: `密钥有效，Baidu 返回 ${references.length} 条结果。发送的密钥是 ${preview}。`,
      ...(shapeWarnings.length > 0 ? { shapeWarnings } : {}),
    }
  } catch (e) {
    if (e instanceof BaiduHttpError) {
      const status = e.status
      const isAuth = status === 401 || status === 403
      const isRate = status === 429
      const isServer = status >= 500
      const reason: Exclude<BaiduKeyTestResult, { ok: true }>['reason'] = isAuth
        ? 'auth_invalid'
        : isRate
          ? 'rate_limit'
          : isServer
            ? 'server'
            : 'other'
      const baseMsg = (() => {
        if (isAuth) {
          return `Baidu 拒绝了 Authorization token (HTTP ${status})。我们发送的密钥是 ${preview}。请确认 ${BAIDU_API_KEY_PREFIX} 开头的完整密钥一字不差,且百度控制台对应应用已开通 AI Search 服务。`
        }
        if (isRate) return `Baidu 返回 429 — 请求限额已达上限,稍后再试。`
        if (isServer) return `Baidu 服务端错误 HTTP ${status} — 稍后再试。`
        return `Baidu HTTP ${status} ${e.statusText}。`
      })()
      return {
        ok: false,
        status,
        reason,
        keyPreview: preview,
        message: baseMsg,
        detail: e.detail || undefined,
        ...(shapeWarnings.length > 0 ? { shapeWarnings } : {}),
      }
    }
    if (e instanceof BaiduApiError) {
      const isAuthCode = /auth|token|unauthor/i.test(e.apiCode + e.message)
      return {
        ok: false,
        status: 200,
        reason: isAuthCode ? 'auth_invalid' : 'other',
        keyPreview: preview,
        message: `Baidu API 错误 [${e.apiCode}]: ${e.message}`,
        ...(shapeWarnings.length > 0 ? { shapeWarnings } : {}),
      }
    }
    return {
      ok: false,
      status: 0,
      reason: 'network',
      keyPreview: preview,
      message: `无法连接 Baidu AI Search：${e instanceof Error ? e.message : String(e)}`,
      ...(shapeWarnings.length > 0 ? { shapeWarnings } : {}),
    }
  }
}

// ========== WebSearch router ==========

function queryLooksCjkBiased(q: string): boolean {
  const chars = q.replace(/\s+/g, '')
  if (chars.length === 0) return false
  let cjk = 0
  for (const ch of chars) {
    const cp = ch.codePointAt(0) ?? 0
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0x3400 && cp <= 0x4dbf)
    ) {
      cjk++
    }
  }
  return cjk / [...chars].length >= 0.3
}

export type WebSearchEngine = 'auto' | 'brave' | 'baidu' | 'ddg'

export function pickWebSearchEngine(params: {
  engine: WebSearchEngine | undefined
  query: string
  braveKeyPresent: boolean
  baiduKeyPresent: boolean
}): 'brave' | 'baidu' | 'ddg' {
  const mode = params.engine ?? 'auto'
  if (mode === 'brave') return params.braveKeyPresent ? 'brave' : 'ddg'
  if (mode === 'baidu') return params.baiduKeyPresent ? 'baidu' : 'ddg'
  if (mode === 'ddg') return 'ddg'
  if (params.baiduKeyPresent && queryLooksCjkBiased(params.query)) return 'baidu'
  if (params.braveKeyPresent) return 'brave'
  if (params.baiduKeyPresent) return 'baidu'
  return 'ddg'
}

// ========== Engine implementations ==========

async function toolWebSearchBrave(
  query: string,
  opts: { maxResults: number; apiKey: string },
): Promise<ToolResult> {
  const u = new URL('https://api.search.brave.com/res/v1/web/search')
  u.searchParams.set('q', query)
  u.searchParams.set('count', String(opts.maxResults))
  const r = await fetch(u.toString(), {
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      'X-Subscription-Token': opts.apiKey,
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!r.ok) {
    let detail = ''
    try {
      const t = await r.text()
      if (t) {
        const snippet = t.length > 600 ? `${t.slice(0, 600)}…` : t
        detail = snippet.trim() ? ` — ${snippet.trim()}` : ''
      }
    } catch {
      /* ignore */
    }
    let sourceHint = ''
    if (r.status === 422 && /SUBSCRIPTION_TOKEN_INVALID/i.test(detail)) {
      const mask = maskBraveApiKeyForDiagnostics(opts.apiKey)
      sourceHint =
        `\n\n[Brave] 密钥被拒绝。我们发送的密钥经过清理后是 ${mask}。` +
        '\n→ 去「设置 → 工具 → Web 搜索」点「测试」查看详细诊断。'
    }
    return {
      success: false,
      error: `Brave Search HTTP ${r.status}: ${r.statusText}${detail}${sourceHint}`,
    }
  }
  const raw = await r.text()
  if (raw.length > SEARCH_ENGINE_JSON_BODY_MAX_CHARS) {
    return {
      success: false,
      error: `Brave Search returned an oversized JSON payload (${raw.length} chars > ${SEARCH_ENGINE_JSON_BODY_MAX_CHARS}).`,
    }
  }
  let j: {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
  }
  try {
    j = JSON.parse(raw) as typeof j
  } catch {
    return { success: false, error: 'Brave Search returned malformed JSON.' }
  }
  const results = j.web?.results ?? []
  if (results.length === 0) {
    return { success: true, output: `No web results for "${query}" (Brave).` }
  }
  const lines = results.slice(0, opts.maxResults).map((item, i) => {
    const title = safeSliceCodeUnits(
      ((item.title ?? '(no title)') || '').replace(/\s+/g, ' '),
      400,
    )
    const url = safeSliceCodeUnits(((item.url ?? '') || '').replace(/\s+/g, ' '), 2_000)
    const desc = safeSliceCodeUnits(
      (item.description ?? '').replace(/\s+/g, ' '),
      280,
    )
    return `${i + 1}. ${title}\n   ${url}\n   ${desc}`
  })
  return { success: true, output: safeSliceCodeUnits(lines.join('\n\n'), WEB_SEARCH_MAX_RESULT_CHARS) }
}

async function toolWebSearchDdg(
  query: string,
  opts: { maxResults: number },
): Promise<ToolResult> {
  const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`
  const r = await fetch(ddgUrl, { signal: AbortSignal.timeout(15_000) })
  if (!r.ok) {
    return { success: false, error: `DuckDuckGo HTTP ${r.status}` }
  }
  const raw = await r.text()
  if (raw.length > DDG_MAX_RESPONSE_CHARS) {
    return {
      success: false,
      error:
        `DuckDuckGo returned an oversized JSON payload (${raw.length} chars > ${DDG_MAX_RESPONSE_CHARS}). ` +
        'Try again, use engine `brave`/`baidu`, or narrow the query.',
    }
  }
  let j: {
    AbstractText?: string
    AbstractURL?: string
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: unknown[] }>
  }
  try {
    j = JSON.parse(raw) as typeof j
  } catch {
    return { success: false, error: 'DuckDuckGo returned malformed JSON.' }
  }
  const out: string[] = []
  if (j.AbstractText) {
    const summary = safeSliceCodeUnits(j.AbstractText.replace(/\s+/g, ' '), DDG_ABSTRACT_MAX_CHARS)
    out.push(`Summary: ${summary}`)
    if (j.AbstractURL) {
      out.push(`URL: ${safeSliceCodeUnits(String(j.AbstractURL), 2_000)}`)
    }
  }
  const topics = Array.isArray(j.RelatedTopics) ? j.RelatedTopics : []
  let n = 0
  for (const t of topics) {
    if (n >= opts.maxResults) break
    if (t.Text && t.FirstURL) {
      n++
      const text = safeSliceCodeUnits(String(t.Text).replace(/\s+/g, ' '), DDG_TOPIC_TEXT_MAX_CHARS)
      const url = safeSliceCodeUnits(String(t.FirstURL), 2_000)
      out.push(`${n}. ${text}\n   ${url}`)
    }
  }
  if (out.length === 0) {
    return {
      success: true,
      output:
        `No instant results for "${query}" (DuckDuckGo). Set a Brave or Baidu API key in Settings → Tools, or use web_fetch.`,
    }
  }
  const joined = out.join('\n\n')
  return {
    success: true,
    output: safeSliceCodeUnits(joined, WEB_SEARCH_MAX_RESULT_CHARS),
  }
}

export async function toolWebSearch(
  query: string,
  options?: { maxResults?: number; engine?: WebSearchEngine; freshness?: string },
): Promise<ToolResult> {
  try {
    const q = typeof query === 'string' ? query.trim() : ''
    if (!q) {
      return { success: false, error: 'Query is empty.' }
    }
    const max = Math.min(20, Math.max(1, options?.maxResults ?? 8))
    const { key: braveKey } = resolveBraveSearchApiKeyMeta()
    const { key: baiduKey } = resolveBaiduSearchApiKeyMeta()

    const engine = pickWebSearchEngine({
      engine: options?.engine,
      query: q,
      braveKeyPresent: !!braveKey,
      baiduKeyPresent: !!baiduKey,
    })

    
    let result: ToolResult
    if (engine === 'brave' && braveKey) {
      result = await toolWebSearchBrave(q, { maxResults: max, apiKey: braveKey })
    } else if (engine === 'baidu' && baiduKey) {
      result = await toolWebSearchBaidu(q, {
        maxResults: max,
        apiKey: baiduKey,
        ...(options?.freshness ? { freshness: options.freshness } : {}),
      })
    } else {
      result = await toolWebSearchDdg(q, { maxResults: max })
    }
        return result
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}
