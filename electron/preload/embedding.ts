/**
 * Embedding / vector store / workspace-index / attachments bridges.
 *
 * Grouped together because they all participate in the same retrieval
 * pipeline: attachments are ingested → chunked → embedded (under a
 * fingerprint) → stored in a vector namespace → queried by the
 * workspace-index / high-level API.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'

export interface AttachmentsApi {
  ingest: (args: { path?: string; name?: string }) => Promise<unknown>
  ingestBuffer: (args: { base64: string; name: string }) => Promise<unknown>
  cacheGet: (args: { sha256: string; kind?: string }) => Promise<unknown>
  cacheStats: () => Promise<{ files: number; bytes: number }>
  cacheClear: () => Promise<{ removed: number }>
  cacheStageImage: (args: { base64: string; mediaType?: string }) => Promise<{ ok: boolean; sha256?: string; error?: string }>
}

export function buildAttachmentsApi(): AttachmentsApi {
  return {
    ingest: (args) => ipcRenderer.invoke('attachment:ingest', args),
    ingestBuffer: (args) => ipcRenderer.invoke('attachment:ingest-buffer', args),
    cacheGet: (args) => ipcRenderer.invoke('attachment:cache-get', args),
    cacheStats: () => ipcRenderer.invoke('attachment:cache-stats'),
    cacheClear: () => ipcRenderer.invoke('attachment:cache-clear'),
    cacheStageImage: (args) => ipcRenderer.invoke('attachment:cache-stage-image', args),
  }
}

export interface EmbeddingApi {
  embed: (args: { config: Record<string, unknown>; texts: string[] }) => Promise<unknown>
  rerank: (args: { config: Record<string, unknown>; query: string; documents: Array<{ id: string; text: string }> }) => Promise<unknown>
  listLocal: () => Promise<{ installed: unknown[]; downloadable: unknown[]; error?: string }>
  embedLocal: (args: { modelId: string; texts: string[] }) => Promise<unknown>
  embedDispatch: (args: { mode?: 'local' | 'cloud' | 'auto'; localModelId?: string; cloud?: Record<string, unknown>; texts: string[] }) => Promise<unknown>
  downloadLocal: (args: { modelId: string }) => Promise<unknown>
  cancelDownload: (args: { modelId: string }) => Promise<{ ok: boolean; error?: string }>
  deleteLocal: (args: { modelId: string }) => Promise<{ ok: boolean; error?: string }>
  onDownloadProgress: (cb: (p: unknown) => void) => () => void
  /**
   * High-level: index an attachment under the *current* embedding model's
   * fingerprint. Idempotent — same (sha, kind, model) is never re-embedded.
   */
  indexAttachment: (args: {
    sha256: string
    kind: string
    sourceLabel?: string
    chunks: Array<{ id?: string; index: number; text: string; meta?: Record<string, unknown> }>
  }) => Promise<{ ok: boolean; namespace?: string; skipped?: boolean; error?: string }>
  /** High-level: query across multiple attachments under the current fp. */
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
  /** Inventory of every persisted vector namespace, for Settings / GC. */
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
   * Resolve the user's current embedding settings to a fingerprint by
   * doing a 1-vector probe. Used by the Settings UI to highlight which
   * cache entries are stale.
   */
  activeFp: () => Promise<{ ok: boolean; fp?: string; model?: string; dim?: number; error?: string }>
  /**
   * Subscribe to the one-shot v1→v2 vector-store layout migration result.
   * Fires at most once per launch (only when there were artifacts to move).
   */
  onMigrationReport: (cb: (report: {
    migrated: boolean
    archiveDir: string | null
    details: Array<{ from: string; files: number }>
  }) => void) => () => void
}

export function buildEmbeddingApi(): EmbeddingApi {
  return {
    embed: (args) => ipcRenderer.invoke('embedding:embed', args),
    rerank: (args) => ipcRenderer.invoke('embedding:rerank', args),
    listLocal: () => ipcRenderer.invoke('embedding:list-local'),
    embedLocal: (args) => ipcRenderer.invoke('embedding:embed-local', args),
    embedDispatch: (args) => ipcRenderer.invoke('embedding:embed-dispatch', args),
    downloadLocal: (args) => ipcRenderer.invoke('embedding:download-local', args),
    cancelDownload: (args) => ipcRenderer.invoke('embedding:cancel-download', args),
    deleteLocal: (args) => ipcRenderer.invoke('embedding:delete-local', args),
    onDownloadProgress: (cb) => {
      const handler = (_e: IpcRendererEvent, p: unknown) => cb(p)
      ipcRenderer.on('embedding:download-progress', handler)
      return () => ipcRenderer.removeListener('embedding:download-progress', handler)
    },
    indexAttachment: (args) => ipcRenderer.invoke('embedding:index-attachment', args),
    queryAttachments: (args) => ipcRenderer.invoke('embedding:query-attachments', args),
    inventory: () => ipcRenderer.invoke('embedding:inventory'),
    gcStale: (args) => ipcRenderer.invoke('embedding:gc-stale', args),
    activeFp: () => ipcRenderer.invoke('embedding:active-fp'),
    onMigrationReport: (cb) => {
      const handler = (_e: IpcRendererEvent, p: unknown) => cb(p as Parameters<typeof cb>[0])
      ipcRenderer.on('embedding:migration-report', handler)
      return () => ipcRenderer.removeListener('embedding:migration-report', handler)
    },
  }
}

export interface VectorApi {
  upsert: (args: { namespace: string; model?: string; chunks: Array<Record<string, unknown>>; vectors: number[][] }) => Promise<{ ok: boolean; error?: string }>
  query: (args: { vector: number[]; namespaces: string[]; topK?: number }) => Promise<unknown[]>
  has: (args: { namespace: string }) => Promise<boolean>
  drop: (args: { namespace: string }) => Promise<{ ok: boolean; error?: string }>
  stats: () => Promise<{ files: number; bytes: number }>
  clearAll: () => Promise<{ removed: number }>
}

export function buildVectorApi(): VectorApi {
  return {
    upsert: (args) => ipcRenderer.invoke('vector:upsert', args),
    query: (args) => ipcRenderer.invoke('vector:query', args),
    has: (args) => ipcRenderer.invoke('vector:has', args),
    drop: (args) => ipcRenderer.invoke('vector:drop', args),
    stats: () => ipcRenderer.invoke('vector:stats'),
    clearAll: () => ipcRenderer.invoke('vector:clear-all'),
  }
}

type WorkspaceIndexStatus = {
  indexed: boolean
  namespace: string
  filesScanned: number
  filesIndexed: number
  chunkCount: number
  bytesSource: number
  model: string
  dim: number
  builtAt: number
  durationMs: number
  errors: Array<{ file: string; error: string }>
}

export interface WorkspaceIndexApi {
  build: (args: { root: string; force?: boolean }) => Promise<{
    ok: boolean
    error?: string
    status?: WorkspaceIndexStatus
  }>
  status: (args: { root: string }) => Promise<null | WorkspaceIndexStatus>
  query: (args: { root: string; query: string; topK?: number }) => Promise<Array<{
    id: string
    text: string
    score: number
    namespace: string
    filePath: string
    startLine: number
    endLine: number
    meta?: Record<string, unknown>
  }>>
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

export function buildWorkspaceIndexApi(): WorkspaceIndexApi {
  return {
    build: (args) => ipcRenderer.invoke('workspace-index:build', args),
    status: (args) => ipcRenderer.invoke('workspace-index:status', args),
    query: (args) => ipcRenderer.invoke('workspace-index:query', args),
    clear: (args) => ipcRenderer.invoke('workspace-index:clear', args),
    onProgress: (cb) => {
      const listener = (_e: unknown, payload: unknown) => {
        try { cb(payload as Parameters<typeof cb>[0]) } catch { /* ignore cb throw */ }
      }
      ipcRenderer.on('workspace-index:progress', listener)
      return () => ipcRenderer.removeListener('workspace-index:progress', listener)
    },
  }
}
