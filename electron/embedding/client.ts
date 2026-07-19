/**
 * Embedding + rerank HTTP clients.
 *
 * Both speak their respective de-facto standards:
 *   - `POST {baseUrl}/embeddings`  Body: {input, model, dimensions?} → {data:[{embedding}]}
 *   - `POST {baseUrl}/rerank`      Body: {query, documents, model}   → {results:[{index,relevance_score}]}
 *
 * For baseUrls that don't end in `/v1`, we append `/v1` automatically — this
 * matches the convention used elsewhere in the codebase (see ai/client).
 */

import type {
  EmbedError,
  EmbedResponse,
  EmbeddingProviderConfig,
  RerankDocument,
  RerankError,
  RerankProviderConfig,
  RerankResponse,
} from './types'

const DEFAULT_BATCH = 32
const TIMEOUT_MS = 60_000

function normalizeBaseUrl(u: string | undefined, fallback: string): string {
  const raw = (u && u.trim()) || fallback
  const trimmed = raw.replace(/\/+$/, '')
  if (/\/v\d+$/.test(trimmed)) return trimmed
  if (/\.openai\.com$/.test(new URL(trimmed).hostname || '')) return `${trimmed}/v1`
  // Ollama uses `/api/embed` (not `/v1/embeddings`) — caller handles below.
  return trimmed
}

function isOllamaStyle(baseUrl: string): boolean {
  // Heuristic: Ollama uses port 11434 by default, or has `/api` already.
  return /:11434(\/|$)/.test(baseUrl) || /\/api$/.test(baseUrl)
}

function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer))
}

/** Embed a list of texts. Returns all vectors in input order, batched internally. */
export async function embed(
  cfg: EmbeddingProviderConfig,
  texts: string[],
): Promise<EmbedResponse | EmbedError> {
  if (texts.length === 0) return { ok: true, vectors: [], model: cfg.model, dim: 0 }
  try {
    const base = normalizeBaseUrl(cfg.baseUrl, 'https://api.openai.com/v1')
    const ollama = isOllamaStyle(base)
    const all: number[][] = []
    for (let i = 0; i < texts.length; i += DEFAULT_BATCH) {
      const batch = texts.slice(i, i + DEFAULT_BATCH)
      const vectors = ollama
        ? await embedOllama(base, cfg, batch)
        : await embedOpenAI(base, cfg, batch)
      for (const v of vectors) all.push(v)
    }
    const dim = all[0]?.length ?? (cfg.dimensions || 0)
    return { ok: true, vectors: all, model: cfg.model, dim }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function embedOpenAI(
  base: string,
  cfg: EmbeddingProviderConfig,
  batch: string[],
): Promise<number[][]> {
  const url = `${base}/embeddings`
  const body: Record<string, unknown> = { input: batch, model: cfg.model }
  if (cfg.dimensions) body.dimensions = cfg.dimensions
  const r = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    },
    TIMEOUT_MS,
  )
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`embed HTTP ${r.status}: ${text.slice(0, 200)}`)
  }
  const j = (await r.json()) as { data?: Array<{ embedding: number[]; index?: number }> }
  const data = j.data || []
  // Respect `index` if present; else trust array order.
  const out: number[][] = new Array(batch.length)
  for (let k = 0; k < data.length; k++) {
    const idx = typeof data[k].index === 'number' ? (data[k].index as number) : k
    out[idx] = data[k].embedding
  }
  return out
}

async function embedOllama(
  base: string,
  cfg: EmbeddingProviderConfig,
  batch: string[],
): Promise<number[][]> {
  // Ollama accepts a single string *or* array under `input` (newer builds).
  // Fall back to per-item calls for older servers.
  const root = base.replace(/\/v\d+$/, '').replace(/\/api$/, '')
  const url = `${root}/api/embed`
  try {
    const r = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, input: batch }),
      },
      TIMEOUT_MS,
    )
    if (r.ok) {
      const j = (await r.json()) as { embeddings?: number[][] }
      if (Array.isArray(j.embeddings)) return j.embeddings
    }
  } catch { /* fall through */ }
  const out: number[][] = []
  for (const t of batch) {
    const r = await fetchWithTimeout(
      `${root}/api/embeddings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, prompt: t }),
      },
      TIMEOUT_MS,
    )
    if (!r.ok) throw new Error(`ollama embed HTTP ${r.status}`)
    const j = (await r.json()) as { embedding?: number[] }
    if (!Array.isArray(j.embedding)) throw new Error('ollama embed: missing embedding')
    out.push(j.embedding)
  }
  return out
}

/** Rerank documents against a query using Jina/Cohere-style `/rerank`. */
export async function rerank(
  cfg: RerankProviderConfig,
  query: string,
  docs: RerankDocument[],
): Promise<RerankResponse | RerankError> {
  if (docs.length === 0) return { ok: true, model: cfg.model, results: [] }
  try {
    const base = normalizeBaseUrl(cfg.baseUrl, 'https://api.jina.ai/v1')
    const url = `${base}/rerank`
    const r = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          query,
          documents: docs.map((d) => d.text),
          model: cfg.model,
          top_n: docs.length,
        }),
      },
      TIMEOUT_MS,
    )
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      throw new Error(`rerank HTTP ${r.status}: ${text.slice(0, 200)}`)
    }
    const j = (await r.json()) as {
      results?: Array<{ index: number; relevance_score: number }>
    }
    const results = (j.results || []).map((x) => ({
      id: docs[x.index]?.id ?? String(x.index),
      score: x.relevance_score,
    }))
    return { ok: true, model: cfg.model, results }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
