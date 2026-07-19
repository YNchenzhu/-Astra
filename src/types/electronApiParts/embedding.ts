import type { WorkspaceIndexStatusResult } from '../workspaceModels'

/**
 * Cloud + local embedding / reranker bridges. See
 * electron/embedding/* for server-side. `embedDispatch` picks
 * local-ONNX-first-then-cloud-fallback based on embeddingMode.
 */
export interface ElectronEmbeddingApi {
  embed: (args: {
    config: { providerId: string; model: string; apiKey?: string; baseUrl?: string; dimensions?: number }
    texts: string[]
  }) => Promise<
    | { ok: true; vectors: number[][]; model: string; dim: number }
    | { ok: false; error: string }
  >
  rerank: (args: {
    config: { providerId: string; model: string; apiKey?: string; baseUrl?: string }
    query: string
    documents: Array<{ id: string; text: string }>
  }) => Promise<
    | { ok: true; model: string; results: Array<{ id: string; score: number }> }
    | { ok: false; error: string }
  >
  listLocal: () => Promise<{
    installed: Array<{
      id: string; name: string; description: string; dir: string
      source: 'bundled' | 'downloaded'
      installed: boolean; reason?: string
      sizeBytes?: number; dimensions?: number
    }>
    downloadable: Array<{
      id: string; name: string; description: string; hfRepo: string
      files: string[]; approxSizeBytes: number; dimensions: number
    }>
    error?: string
  }>
  embedLocal: (args: { modelId: string; texts: string[] }) => Promise<
    | { ok: true; vectors: number[][]; model: string; dim: number }
    | { ok: false; error: string }
  >
  embedDispatch: (args: {
    mode: 'local' | 'cloud' | 'auto'
    localModelId?: string
    cloud?: { providerId: string; model: string; apiKey?: string; baseUrl?: string; dimensions?: number }
    texts: string[]
  }) => Promise<
    | { ok: true; vectors: number[][]; model: string; dim: number }
    | { ok: false; error: string }
  >
  downloadLocal: (args: { modelId: string }) => Promise<
    { ok: true } | { ok: false; error: string; canceled?: boolean }
  >
  cancelDownload: (args: { modelId: string }) => Promise<{ ok: boolean; error?: string }>
  deleteLocal: (args: { modelId: string }) => Promise<{ ok: boolean; error?: string }>
  onDownloadProgress: (cb: (p: {
    modelId: string
    fileIndex: number; totalFiles: number; currentFile: string
    currentBytes: number; currentTotal: number
    overallBytes: number; overallTotal: number
    state: 'downloading' | 'done' | 'error'; error?: string
  }) => void) => () => void
  /**
   * High-level: index an attachment. Main process resolves the model
   * fingerprint and routes to a per-(sha, kind, fp) namespace.
   */
  indexAttachment: (args: {
    sha256: string
    kind: string
    sourceLabel?: string
    chunks: Array<{ id?: string; index: number; text: string; meta?: Record<string, unknown> }>
  }) => Promise<{ ok: boolean; namespace?: string; skipped?: boolean; error?: string }>
  /** High-level: query across multiple attachments under the active fp. */
  queryAttachments: (args: {
    query: string
    attachments: Array<{ sha256: string; kind: string }>
    topK?: number
  }) => Promise<{
    ok: boolean
    hits: Array<{ text: string; score: number; namespace: string; meta?: Record<string, unknown> }>
    searched: number
    error?: string
  }>
  /** Inventory of every persisted vector namespace (for Settings / GC). */
  inventory: () => Promise<{
    ok: boolean
    entries: Array<{
      ns: string
      kind: 'attachment' | 'workspace' | 'memory'
      sourceLabel: string
      fp: string
      model: string
      dim: number
      builtAt: number
      chunkCount: number
      sizeBytes: number
    }>
    error?: string
  }>
  /** Drop every namespace whose fingerprint isn't `activeFp`. */
  gcStale: (args: { activeFp: string }) => Promise<{ ok: boolean; removed: number; bytes: number; error?: string }>
  /**
   * Resolve the user's current embedding settings to a 12-hex
   * fingerprint by doing a 1-vector probe. Used by Settings →
   * 缓存管理 to highlight stale cache entries.
   */
  activeFp: () => Promise<{ ok: boolean; fp?: string; model?: string; dim?: number; error?: string }>
  /**
   * Subscribe to the one-shot v1→v2 vector-store layout migration
   * report. Fires at most once per launch (only when archives moved).
   */
  onMigrationReport: (cb: (report: {
    migrated: boolean
    archiveDir: string | null
    details: Array<{ from: string; files: number }>
  }) => void) => () => void
}

/** Flat JSON + in-memory cosine vector store for attachment RAG chunks. */
export interface ElectronVectorApi {
  upsert: (args: {
    namespace: string
    model: string
    chunks: Array<{ id: string; index: number; text: string; meta?: Record<string, unknown> }>
    vectors: number[][]
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  query: (args: { vector: number[]; namespaces: string[]; topK?: number }) => Promise<
    Array<{
      id: string
      index: number
      text: string
      meta?: Record<string, unknown>
      score: number
      namespace: string
    }>
  >
  has: (args: { namespace: string }) => Promise<boolean>
  drop: (args: { namespace: string }) => Promise<{ ok: boolean; error?: string }>
  stats: () => Promise<{ files: number; bytes: number }>
  clearAll: () => Promise<{ removed: number }>
}

/**
 * Workspace-scoped semantic index. One namespace per workspace root
 * (sha1 of the absolute path). `build` walks the tree, chunks each
 * source file into ~120-line windows with 20-line overlap, embeds each
 * chunk, and upserts into the vector store. `query` returns the top-K
 * chunks across that namespace. Progress ticks are streamed via
 * `onProgress` for long cloud embeds. See
 * `electron/embedding/workspaceIndex.ts`.
 */
export interface ElectronWorkspaceIndexApi {
  build: (args: { root: string; force?: boolean }) => Promise<{
    ok: boolean
    error?: string
    status?: WorkspaceIndexStatusResult
  }>
  status: (args: { root: string }) => Promise<WorkspaceIndexStatusResult | null>
  query: (args: { root: string; query: string; topK?: number }) => Promise<
    Array<{
      id: string
      text: string
      score: number
      namespace: string
      filePath: string
      startLine: number
      endLine: number
      meta?: Record<string, unknown>
    }>
  >
  clear: (args: { root: string }) => Promise<{ ok: boolean; error?: string }>
  onProgress: (cb: (payload: {
    root: string
    phase: 'walk' | 'chunk' | 'embed' | 'upsert' | 'done'
    filesScanned: number
    filesIndexed: number
    chunksEmbedded: number
    chunksTotal: number
  }) => void) => () => void
}
