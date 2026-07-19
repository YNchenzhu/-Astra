/**
 * Helpers that turn a raw `dispatchEmbed` call into a fingerprint-bearing
 * result, so every index/query site can route writes to the correct
 * namespace without each one re-implementing the same plumbing.
 *
 * Why a dedicated module?
 *
 *   - Fingerprints are derived from the *actual* model that produced a
 *     vector, not the user's `embeddingMode`. Auto-mode resolves to either
 *     local or cloud at dispatch time; this wrapper observes that decision
 *     and packages it.
 *   - Three subsystems (workspace index, attachment RAG, memory recall)
 *     all need exactly the same "embed → resolve → fingerprint" plumbing.
 *     Centralizing prevents any of them from drifting on what counts as
 *     "the same model".
 */

import { dispatchEmbed, type DispatchEmbeddingConfig } from './dispatch'
import type { EmbedError, EmbedResponse } from './types'
import { endpointFromBaseUrl, fingerprint, modelLabel, type ResolvedModel } from './fingerprint'

export interface FingerprintedEmbedResponse {
  ok: true
  vectors: number[][]
  /** Provider:model label suitable for UI / registry ("openai:bge-m3"). */
  modelLabel: string
  /** Output dimensionality from the wire response. */
  dim: number
  /** 12-hex model fingerprint — feed straight into `buildNamespace()`. */
  fp: string
  /** The fully-resolved model used for this embedding call. */
  resolved: ResolvedModel
}

export type FingerprintedEmbedResult = FingerprintedEmbedResponse | EmbedError

/**
 * Wrap `dispatchEmbed` so callers receive a fingerprint alongside vectors.
 *
 * Resolution rules (derived from `dispatch.ts`):
 *   - mode='local'  → kind='local',  providerId='local', model=`local:${id}`
 *   - mode='cloud'  → kind='cloud',  providerId/model from cfg.cloud
 *   - mode='auto'   → tries local first; if it produced the vectors, use the
 *                     local resolution; otherwise fall back to cloud
 *
 * We infer which path actually fired by inspecting `EmbedResponse.model`,
 * which the dispatcher prefixes with `local:` for local-path results.
 */
export async function dispatchEmbedFingerprinted(
  cfg: DispatchEmbeddingConfig,
  texts: string[],
): Promise<FingerprintedEmbedResult> {
  const r = await dispatchEmbed(cfg, texts)
  if (!r.ok) return r
  return wrapWithFingerprint(cfg, r)
}

/**
 * Same as above but for callers that already invoked `dispatchEmbed`
 * directly (e.g. the legacy code path during transition). Pure function.
 */
export function wrapWithFingerprint(
  cfg: DispatchEmbeddingConfig,
  r: EmbedResponse,
): FingerprintedEmbedResponse {
  const resolved = resolveActualModel(cfg, r)
  return {
    ok: true,
    vectors: r.vectors,
    modelLabel: modelLabel(resolved),
    dim: r.dim,
    fp: fingerprint(resolved),
    resolved,
  }
}

/**
 * Best-effort reconstruction of the resolved model from the dispatch input
 * and the response. The dispatcher tags local results with `local:` prefix;
 * everything else is treated as cloud.
 */
function resolveActualModel(
  cfg: DispatchEmbeddingConfig,
  r: EmbedResponse,
): ResolvedModel {
  const isLocal = typeof r.model === 'string' && r.model.startsWith('local:')
  if (isLocal) {
    const localModelId = r.model.slice('local:'.length) || cfg.localModelId || 'unknown'
    return {
      kind: 'local',
      providerId: 'local',
      model: localModelId,
      dim: r.dim,
    }
  }
  const cloud = cfg.cloud
  return {
    kind: 'cloud',
    providerId: cloud?.providerId || 'unknown',
    model: cloud?.model || r.model || 'unknown',
    dim: r.dim,
    endpoint: endpointFromBaseUrl(cloud?.baseUrl),
  }
}

/**
 * Given a settings snapshot, resolve the *prospective* model for queries
 * without doing an embed call. Used for "filter namespaces by current fp"
 * paths — we still ultimately verify by re-embedding the query, but the
 * fast path can skip namespaces whose fp doesn't match the user's setting.
 *
 * Returns null when the user has no resolvable model configured (mode=cloud
 * with no cfg). Callers that want a definitive answer should perform an
 * actual embed and use `wrapWithFingerprint`.
 */
export function tentativeResolvedFromConfig(cfg: DispatchEmbeddingConfig): ResolvedModel | null {
  if (cfg.mode === 'cloud' && cfg.cloud?.model) {
    return {
      kind: 'cloud',
      providerId: cfg.cloud.providerId,
      model: cfg.cloud.model,
      // dim: tentative — may be 0 if user hasn't set dimensions and the
      // model uses native dim; consumers that need the real dim must embed.
      dim: cfg.cloud.dimensions || 0,
      endpoint: endpointFromBaseUrl(cfg.cloud.baseUrl),
    }
  }
  if (cfg.mode === 'local' && cfg.localModelId) {
    return {
      kind: 'local',
      providerId: 'local',
      model: cfg.localModelId,
      dim: 0, // unknown until first embed
    }
  }
  // 'auto' is intentionally not resolvable without an embed call.
  return null
}
