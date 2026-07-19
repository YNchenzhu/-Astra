/**
 * Web Fetch tool — fetch a URL and extract text content.
 */

import { type ToolResult } from './tools'
import { normalizeWebFetchUrlInput } from '../utils/webFetchNormalize'
import { safeSliceCodeUnits } from '../utils/unicodeSanitize'
import { isAbortLikeError } from './abortLikeError'
import { recordToolResourceDelta } from '../orchestration/toolRuntime/state'
import { getToolUseIdFromStopScope } from './toolExecutionScope'

/**
 * Audit A-3 wire-up — feed network bytes from a single WebFetch into the
 * per-tool resource delta. No global `recordNetworkBytes` window exists in
 * `ResourceQuotaManager` today (only token + disk), so this only
 * populates the per-tool snapshot. Operators viewing the snapshot can see
 * the real transfer cost attributed to the calling tool_use slot.
 * Defensive: telemetry must never break the tool result.
 */
function recordNetworkBytesForWebFetch(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return
  try {
    const toolUseId = getToolUseIdFromStopScope()
    if (toolUseId) {
      recordToolResourceDelta(toolUseId, { networkBytes: bytes })
    }
  } catch (e) {
    console.warn('[toolWebFetch] recordToolResourceDelta failed:', e)
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Progress callback shape — kept narrow so the tool stays independent of
 * the renderer-side payload schema. Each call ships a short status text
 * up the IPC pipeline (upstream alignment stage 2: replaces `setToolJSX`).
 */
export type WebFetchProgress = (note: string) => void

export async function toolWebFetch(
  url: string,
  options?: { selector?: string; maxLength?: number; onProgress?: WebFetchProgress }
): Promise<ToolResult> {
  const onProgress = options?.onProgress
  try {
    const normalized = normalizeWebFetchUrlInput(url)
    if (!normalized.ok) {
      return { success: false, error: normalized.error }
    }
    const fetchUrl = normalized.url
    onProgress?.(`Connecting to ${new URL(fetchUrl).host}…`)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    const response = await fetch(fetchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AstraBot/1.0)',
        Accept: 'text/html,application/xhtml+xml,application/json,text/plain,text/markdown',
      },
    })
    clearTimeout(timeout)

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` }
    }

    const contentType = response.headers.get('content-type') || ''
    const maxLength = options?.maxLength || 50000
    onProgress?.(`HTTP ${response.status} · ${contentType || 'unknown content-type'} · downloading…`)

    if (contentType.includes('application/json')) {
      const json = await response.json()
      const text = JSON.stringify(json, null, 2)
      // Audit A-3 wire-up — record bytes received. Content-Length is the
      // server-declared size; fall back to text byte length when missing.
      recordNetworkBytesForWebFetch(
        Number(response.headers.get('content-length')) || Buffer.byteLength(text, 'utf-8'),
      )
      return { success: true, output: safeSliceCodeUnits(text, maxLength) }
    }

    let html = await response.text()
    onProgress?.(`Downloaded ${html.length.toLocaleString()} chars · extracting text…`)
    // Audit A-3 wire-up — record received body size into per-tool delta.
    // Same heuristic as the JSON branch above.
    recordNetworkBytesForWebFetch(
      Number(response.headers.get('content-length')) || Buffer.byteLength(html, 'utf-8'),
    )

    html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
    html = html.replace(/<style[\s\S]*?<\/style>/gi, '')
    html = html.replace(/<[^>]+>/g, ' ')
    html = html.replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
    html = html.replace(/\s+/g, ' ').trim()

    return {
      success: true,
      output:
        safeSliceCodeUnits(html, maxLength) +
        (html.length > maxLength ? '\n\n(truncated)' : ''),
    }
  } catch (error) {
    if (isAbortLikeError(error)) {
      return { success: false, error: 'Request timed out after 15 seconds' }
    }
    return { success: false, error: getErrorMessage(error) }
  }
}
