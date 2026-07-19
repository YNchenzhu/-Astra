/**
 * Shared query-vector helper.
 *
 * The retrieval prefetch pipeline has three parallel consumers — memory
 * hybrid recall, workspace code top-K, and attachment RAG top-K — that all
 * need exactly the same query embedding under the same resolved embedding
 * model. Before this module each of them called `dispatchEmbed([query])`
 * independently, so a single user prompt cost three forward passes through
 * the local ONNX / cloud /v1/embeddings endpoint.
 *
 * `computeSharedQueryEmbedding` centralizes that call. It reads the current
 * embedding config from disk once, dispatches one embed, fingerprints the
 * result, and returns a snapshot that the three consumers can key off of
 * (to pick the right namespace + compare cosine against stored vectors).
 *
 * Failure contract: on any error — no model configured, network failure,
 * ONNX crash — we return `null`. Consumers are expected to treat `null` as
 * "no shared vector available, do whatever you used to do". The three
 * downstream APIs therefore all accept `shared` as optional and fall back
 * to their own dispatchEmbed call when it's missing, which keeps every
 * standalone callsite working unchanged.
 */

import { readDiskSettings } from '../settings/settingsAccess'
import {
  dispatchEmbed,
  type DispatchEmbeddingConfig,
  type EmbeddingMode,
} from './dispatch'
import { wrapWithFingerprint } from './resolved'
import type { ResolvedModel } from './fingerprint'
import type { EmbeddingProviderConfig } from './types'

export interface SharedQueryEmbedding {
  /** The dispatch config that actually produced `vector` (mode, localModelId, cloud). */
  cfg: DispatchEmbeddingConfig
  /** The raw query vector — same array the downstream `queryTopK` calls will use. */
  vector: number[]
  /** 12-hex model fingerprint (feed straight into `buildNamespace()`). */
  fp: string
  /** Output dimensionality of the vector. */
  dim: number
  /** Provider:model label ("openai:bge-m3", "local:gte-small"), for telemetry. */
  modelLabel: string
  /** Fully-resolved embedding model — same shape as `FingerprintedEmbedResponse.resolved`. */
  resolved: ResolvedModel
}

interface EmbedSettingsSnapshot {
  embeddingProviderId?: string
  embeddingModel?: string
  embeddingApiKey?: string
  embeddingBaseUrl?: string
  embeddingDimensions?: number
  embeddingMode?: EmbeddingMode
  embeddingLocalModelId?: string
}

/**
 * Build the dispatch config from the current disk settings snapshot.
 * Exported so callers that need to hand the exact same config to a
 * downstream API (e.g. `queryTopK` with a different namespace) can do so
 * without re-reading settings and risking drift.
 */
export function buildSharedDispatchConfig(): DispatchEmbeddingConfig {
  const s = readDiskSettings() as EmbedSettingsSnapshot
  const cloud: EmbeddingProviderConfig | undefined =
    s.embeddingProviderId && s.embeddingModel
      ? {
          providerId: s.embeddingProviderId,
          model: s.embeddingModel,
          apiKey: s.embeddingApiKey,
          baseUrl: s.embeddingBaseUrl,
          dimensions: s.embeddingDimensions,
        }
      : undefined
  return {
    mode: s.embeddingMode || 'auto',
    localModelId: s.embeddingLocalModelId || undefined,
    cloud,
  }
}

/**
 * Run `dispatchEmbed([query])` once and return the fingerprinted vector +
 * the dispatch config that produced it. The three retrieval subsystems
 * (memory vector, workspace code, attachment RAG) should share this single
 * call in the prefetch pipeline so we don't pay for three forward passes
 * on the same prompt.
 *
 * Returns `null` (not an error object) on any failure so callers can
 * treat it uniformly and fall back to their own path.
 */
export async function computeSharedQueryEmbedding(
  query: string,
  cfgOverride?: DispatchEmbeddingConfig,
): Promise<SharedQueryEmbedding | null> {
  const trimmed = typeof query === 'string' ? query.trim() : ''
  if (!trimmed) return null

  const cfg = cfgOverride ?? buildSharedDispatchConfig()
  // Cloud-only with no cloud config configured → don't even attempt.
  if (cfg.mode === 'cloud' && !cfg.cloud) return null

  try {
    const r = await dispatchEmbed(cfg, [query])
    if (!r.ok) return null
    if (r.vectors.length === 0 || r.dim <= 0) return null
    const wrapped = wrapWithFingerprint(cfg, r)
    const v = wrapped.vectors[0]
    if (!v || v.length === 0) return null
    return {
      cfg,
      vector: v,
      fp: wrapped.fp,
      dim: wrapped.dim,
      modelLabel: wrapped.modelLabel,
      resolved: wrapped.resolved,
    }
  } catch {
    return null
  }
}
