/**
 * Mode-aware embedding dispatcher.
 *
 * Decides per-call whether to run locally (ONNX) or against a cloud
 * `/v1/embeddings` endpoint. The mode is computed from the caller's config:
 *
 *   - mode === 'local'  → always local; returns error if no model loaded
 *   - mode === 'cloud'  → always cloud; delegates to {@link embed}
 *   - mode === 'auto'   → prefer local when a model is installed; fall back
 *                          to cloud when it isn't or local inference fails
 *
 * This keeps the single-entry contract for every caller (memory recall, RAG
 * chunking, settings test buttons) — they pass a `DispatchConfig` and don't
 * care where the vectors come from.
 */

import { embed as embedCloud, rerank as rerankCloud } from './client'
import { embedLocal } from './localModel'
import { listLocalModels, resolveModelDir } from './localCatalog'
import type {
  EmbedError,
  EmbedResponse,
  EmbeddingProviderConfig,
  RerankError,
  RerankProviderConfig,
  RerankResponse,
  RerankDocument,
} from './types'

export type EmbeddingMode = 'local' | 'cloud' | 'auto'

export interface DispatchEmbeddingConfig {
  mode: EmbeddingMode
  /** Local model id (matches a directory under resources/embeddings/ or userData/downloaded-models/). */
  localModelId?: string
  /** Cloud settings; required when mode=cloud, or fallback when mode=auto. */
  cloud?: EmbeddingProviderConfig
}

function pickLocalModelId(preferred?: string): string | null {
  const models = listLocalModels().filter((m) => m.installed)
  if (models.length === 0) return null
  if (preferred && models.some((m) => m.id === preferred)) return preferred
  // Heuristic default: first installed model (sorted alphabetically).
  return models[0].id
}

export async function dispatchEmbed(
  cfg: DispatchEmbeddingConfig,
  texts: string[],
): Promise<EmbedResponse | EmbedError> {
  if (texts.length === 0) {
    return { ok: true, vectors: [], model: 'empty', dim: 0 }
  }

  const tryLocal = async (): Promise<EmbedResponse | EmbedError | null> => {
    const id = pickLocalModelId(cfg.localModelId)
    if (!id) return null
    const dir = resolveModelDir(id)
    if (!dir) return null
    const r = await embedLocal(id, dir, texts)
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, vectors: r.vectors, model: `local:${id}`, dim: r.dim }
  }

  if (cfg.mode === 'local') {
    const r = await tryLocal()
    if (r) return r
    return { ok: false, error: 'no local embedding model installed' }
  }

  if (cfg.mode === 'cloud') {
    if (!cfg.cloud?.model) return { ok: false, error: 'cloud embedding not configured' }
    return embedCloud(cfg.cloud, texts)
  }

  // mode === 'auto'
  const local = await tryLocal()
  if (local && local.ok) return local
  if (cfg.cloud?.model) return embedCloud(cfg.cloud, texts)
  // Prefer whatever error the local attempt left, so the user sees the real
  // cause (e.g. "No .onnx file found under <dir>").
  return local && !local.ok
    ? local
    : { ok: false, error: 'no local model installed and no cloud embedding configured' }
}

// Rerank is cloud-only for now — open-source cross-encoders add another
// heavyweight dep + ONNX head we'd rather not bundle. Callers that provide
// a rerank config get rerank; callers that don't simply skip it.
export async function dispatchRerank(
  cfg: RerankProviderConfig | null | undefined,
  query: string,
  docs: RerankDocument[],
): Promise<RerankResponse | RerankError> {
  if (!cfg || !cfg.model) return { ok: false, error: 'rerank not configured' }
  return rerankCloud(cfg, query, docs)
}
