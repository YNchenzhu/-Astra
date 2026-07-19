/**
 * Embedding model fingerprint.
 *
 * A fingerprint is a short, deterministic id that identifies *exactly which
 * embedding model produced a given vector*. It is the missing piece that
 * makes vector caches safe across model switches:
 *
 *   - "I have an attachment indexed already" is meaningful only when paired
 *     with "and it was indexed by the same model my next query will use".
 *   - Cosine similarity between vectors from two different models is
 *     mathematically nonsense; without a fingerprint we used to silently
 *     compare them (and either return zero hits or, worse, junk).
 *
 * Inputs that affect the fingerprint:
 *   - resolved mode (`local` or `cloud` — `auto` must be resolved first)
 *   - providerId (`local` for local mode; the cloud provider id otherwise)
 *   - model name (local model id or cloud model name)
 *   - actual output dimensionality (taken from EmbedResponse.dim, NOT from
 *     the user's `dimensions` setting which may be null/auto)
 *   - cloud endpoint (hostname of baseUrl, when applicable) — distinguishes
 *     two different deployments of the same nominal model
 *
 * The fingerprint is intentionally short (12 hex / 48 bits): collision
 * probability is well under 1e-7 across realistic per-user model sets, while
 * the on-disk filenames stay readable.
 */

import { createHash } from 'crypto'

export interface ResolvedModel {
  /**
   * The mode the dispatcher actually picked for this call. `'auto'` is never
   * a valid value here — the dispatcher resolves auto → local|cloud before
   * we compute a fingerprint, so the resulting vector cache is keyed by the
   * model that actually produced the vector.
   */
  kind: 'local' | 'cloud'
  /** `'local'` for local mode; the cloud provider id ("openai", "jina", …) otherwise. */
  providerId: string
  /** Local: ONNX model id. Cloud: model name as sent over the wire. */
  model: string
  /** Output dimensionality from the actual EmbedResponse — never `'auto'` / null. */
  dim: number
  /** Cloud only: hostname of baseUrl (used to distinguish multiple deployments). */
  endpoint?: string
}

/** Compute the short fingerprint for a resolved model. */
export function fingerprint(rm: ResolvedModel): string {
  if (!Number.isFinite(rm.dim) || rm.dim <= 0) {
    throw new Error(
      `fingerprint(): non-positive dim=${rm.dim} — caller must pass the actual EmbedResponse.dim, not a user setting`,
    )
  }
  const raw = `${rm.kind}|${rm.providerId}|${rm.model}|${rm.dim}|${rm.endpoint ?? ''}`
  return createHash('sha1').update(raw).digest('hex').slice(0, 12)
}

/**
 * Best-effort "endpoint" extraction from a base URL — strips path / query
 * so two callers with the same logical endpoint produce the same fp even
 * if one of them includes `/v1` and the other doesn't.
 */
export function endpointFromBaseUrl(baseUrl?: string): string | undefined {
  const s = (baseUrl || '').trim()
  if (!s) return undefined
  try {
    return new URL(s.startsWith('http') ? s : `https://${s}`).hostname.toLowerCase()
  } catch {
    return s.replace(/^https?:\/\//, '').split('/')[0].toLowerCase() || undefined
  }
}

/** Human-readable label for UI — `local:bge-m3 (1024d)` / `openai:text-embedding-3-small (1536d)`. */
export function modelLabel(rm: ResolvedModel): string {
  const tag = rm.kind === 'local' ? `local:${rm.model}` : `${rm.providerId}:${rm.model}`
  return `${tag} (${rm.dim}d)`
}
