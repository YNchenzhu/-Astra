/**
 * Shared types for the embedding + reranker subsystems.
 *
 * Deliberately thin — we only use the OpenAI-compatible `/v1/embeddings` and
 * the Jina/Cohere-style `/v1/rerank` shape, which cover every cloud provider
 * we care about today (OpenAI, Jina, Cohere, SiliconFlow, DeepSeek,
 * TogetherAI, Zhipu, Ollama `/api/embed`, LM Studio, vLLM, etc.).
 */

export interface EmbeddingProviderConfig {
  /** Arbitrary label like "openai", "jina", "ollama", "siliconflow". */
  providerId: string
  model: string
  apiKey?: string
  baseUrl?: string
  /** Optional output dimensionality hint (OpenAI text-embedding-3 supports this). */
  dimensions?: number
}

export interface RerankProviderConfig {
  providerId: string
  model: string
  apiKey?: string
  baseUrl?: string
}

export interface EmbedRequest {
  texts: string[]
}

export interface EmbedResponse {
  ok: true
  vectors: number[][]
  model: string
  dim: number
}

export interface EmbedError {
  ok: false
  error: string
}

export interface RerankDocument {
  id: string
  text: string
}

export interface RerankResultItem {
  id: string
  score: number
}

export interface RerankResponse {
  ok: true
  model: string
  results: RerankResultItem[]
}

export interface RerankError {
  ok: false
  error: string
}
