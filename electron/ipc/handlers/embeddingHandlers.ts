/**
 * Embedding / rerank / vector-store / workspace-index / local-model IPC.
 *
 * This aggregator registers every channel under the following namespaces:
 *
 *   - `embedding:*`         cloud + local embed/rerank dispatch, active-fp,
 *                           high-level index/query, inventory + GC, local
 *                           catalog, download lifecycle
 *   - `vector:*`            raw namespace CRUD for RAG chunks
 *   - `workspace-index:*`   workspace-wide semantic index (build/status/
 *                           query/clear)
 *
 * Every subsystem module is loaded lazily through dynamic `import()` so the
 * ONNX runtime + tokenizer assets only hydrate when the user actually uses
 * the feature.
 */
import path from 'node:path'
import { app, type IpcMain } from 'electron'
import { sendToMainWindow } from '../../window/mainWindow'

export function registerEmbeddingHandlers(ipcMain: IpcMain): void {
  // --- Embedding + rerank (cloud providers) ---
  ipcMain.handle('embedding:embed', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const cfg = (p.config && typeof p.config === 'object') ? p.config as Record<string, unknown> : null
    const texts = Array.isArray(p.texts) ? p.texts.filter((t): t is string => typeof t === 'string') : []
    if (!cfg || !cfg.model) return { ok: false, error: 'embedding not configured' }
    try {
      const { embed } = await import('../../embedding/client')
      return await embed({
        providerId: String(cfg.providerId || ''),
        model: String(cfg.model),
        apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey : undefined,
        baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined,
        dimensions: typeof cfg.dimensions === 'number' ? cfg.dimensions : undefined,
      }, texts)
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  ipcMain.handle('embedding:rerank', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const cfg = (p.config && typeof p.config === 'object') ? p.config as Record<string, unknown> : null
    const query = typeof p.query === 'string' ? p.query : ''
    const docs = Array.isArray(p.documents)
      ? p.documents.filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
        .map((d) => ({ id: String(d.id ?? ''), text: String(d.text ?? '') }))
      : []
    if (!cfg || !cfg.model || !query) return { ok: false, error: 'rerank not configured or empty query' }
    try {
      const { rerank } = await import('../../embedding/client')
      return await rerank({
        providerId: String(cfg.providerId || ''),
        model: String(cfg.model),
        apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey : undefined,
        baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined,
      }, query, docs)
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  // --- Vector store (RAG chunks for attachments) ---
  ipcMain.handle('vector:upsert', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const ns = typeof p.namespace === 'string' ? p.namespace : ''
    const model = typeof p.model === 'string' ? p.model : ''
    const chunks = Array.isArray(p.chunks) ? p.chunks as Array<Record<string, unknown>> : []
    const vectors = Array.isArray(p.vectors) ? p.vectors as number[][] : []
    if (!ns) return { ok: false, error: 'namespace required' }
    try {
      const { upsertNamespace } = await import('../../embedding/vectorStore')
      await upsertNamespace(ns, model, chunks.map((c, i) => ({
        id: String(c.id ?? `${ns}-${i}`),
        index: typeof c.index === 'number' ? c.index : i,
        text: String(c.text ?? ''),
        meta: (c.meta && typeof c.meta === 'object') ? c.meta as Record<string, unknown> : undefined,
      })), vectors)
      return { ok: true }
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  ipcMain.handle('vector:query', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const vector = Array.isArray(p.vector) ? p.vector as number[] : []
    const namespaces = Array.isArray(p.namespaces)
      ? (p.namespaces as unknown[]).filter((x): x is string => typeof x === 'string') : []
    const topK = typeof p.topK === 'number' ? p.topK : 6
    if (vector.length === 0 || namespaces.length === 0) return []
    try {
      const { queryTopK } = await import('../../embedding/vectorStore')
      return await queryTopK(vector, { topK, namespaces })
    } catch { return [] }
  })

  ipcMain.handle('vector:has', async (_e, params: unknown) => {
    const ns = params && typeof params === 'object' ? String((params as Record<string, unknown>).namespace || '') : ''
    if (!ns) return false
    try { const { hasNamespace } = await import('../../embedding/vectorStore'); return await hasNamespace(ns) } catch { return false }
  })

  ipcMain.handle('vector:drop', async (_e, params: unknown) => {
    const ns = params && typeof params === 'object' ? String((params as Record<string, unknown>).namespace || '') : ''
    if (!ns) return { ok: true }
    try { const { dropNamespace } = await import('../../embedding/vectorStore'); await dropNamespace(ns); return { ok: true } } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  ipcMain.handle('vector:stats', async () => {
    try { const { storeStats } = await import('../../embedding/vectorStore'); return await storeStats() } catch { return { files: 0, bytes: 0 } }
  })

  ipcMain.handle('vector:clear-all', async () => {
    try { const { clearAll } = await import('../../embedding/vectorStore'); return await clearAll() } catch { return { removed: 0 } }
  })

  // --- Workspace (codebase) semantic index ---
  // Progress events are streamed to the requesting BrowserWindow via
  // `workspace-index:progress` so the Settings panel can show a live gauge
  // during 30-60s cloud embeds on large repos.
  ipcMain.handle('workspace-index:build', async (e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const root = typeof p.root === 'string' ? p.root : ''
    const force = p.force === true
    if (!root) return { ok: false, error: 'root required' }
    try {
      const { buildWorkspaceIndex } = await import('../../embedding/workspaceIndex')
      const status = await buildWorkspaceIndex(root, {
        force,
        onProgress: (tick) => {
          try { e.sender.send('workspace-index:progress', { root, ...tick }) } catch { /* renderer gone */ }
        },
      })
      return { ok: true, status }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('workspace-index:status', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const root = typeof p.root === 'string' ? p.root : ''
    if (!root) return null
    try {
      const { getWorkspaceIndexStatus } = await import('../../embedding/workspaceIndex')
      return await getWorkspaceIndexStatus(root)
    } catch {
      return null
    }
  })

  ipcMain.handle('workspace-index:query', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const root = typeof p.root === 'string' ? p.root : ''
    const query = typeof p.query === 'string' ? p.query : ''
    const topK = typeof p.topK === 'number' ? p.topK : 6
    if (!root || !query) return []
    try {
      const { queryWorkspaceIndex } = await import('../../embedding/workspaceIndex')
      return await queryWorkspaceIndex(root, query, topK)
    } catch {
      return []
    }
  })

  ipcMain.handle('workspace-index:clear', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const root = typeof p.root === 'string' ? p.root : ''
    if (!root) return { ok: false, error: 'root required' }
    try {
      const { clearWorkspaceIndex } = await import('../../embedding/workspaceIndex')
      await clearWorkspaceIndex(root)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // --- Local embedding (onnxruntime-node + bundled/downloaded models) ---
  ipcMain.handle('embedding:list-local', async () => {
    try {
      const { listLocalModels, DOWNLOADABLE_MODELS } = await import('../../embedding/localCatalog')
      return { installed: listLocalModels(), downloadable: DOWNLOADABLE_MODELS }
    } catch (err) {
      return { installed: [], downloadable: [], error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('embedding:embed-local', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const modelId = typeof p.modelId === 'string' ? p.modelId : ''
    const texts = Array.isArray(p.texts) ? p.texts.filter((t): t is string => typeof t === 'string') : []
    if (!modelId) return { ok: false, error: 'modelId required' }
    if (texts.length === 0) return { ok: true, vectors: [], model: `local:${modelId}`, dim: 0 }
    console.log(`[ipc] embedding:embed-local modelId=${modelId} texts=${texts.length}`)
    try {
      const { resolveModelDir } = await import('../../embedding/localCatalog')
      const dir = resolveModelDir(modelId)
      if (!dir) {
        console.warn(`[ipc]   model not installed: ${modelId}`)
        return { ok: false, error: `model "${modelId}" not installed` }
      }
      const { embedLocal } = await import('../../embedding/localModel')

      // Watchdog — prevents the "reply was never sent" opacity when the
      // native ORT session hangs. First-time model load can legit take 30s
      // for bge-m3 (543 MB int8), so the budget is deliberately generous.
      const TIMEOUT_MS = 180_000
      const timer = new Promise<{ ok: false; error: string }>((resolve) => {
        setTimeout(() => resolve({
          ok: false,
          error: `local embedding timed out after ${Math.round(TIMEOUT_MS / 1000)}s — the model may be too large for this machine, or onnxruntime-node crashed. Check main process logs.`,
        }), TIMEOUT_MS)
      })
      const r = await Promise.race([embedLocal(modelId, dir, texts), timer])
      if (!r.ok) {
        console.warn(`[ipc]   embedLocal error:`, r.error)
        return r
      }
      console.log(`[ipc]   embedLocal ok: ${r.vectors.length} x ${r.dim}`)
      return { ok: true, vectors: r.vectors, model: `local:${modelId}`, dim: r.dim }
    } catch (err) {
      const msg = err instanceof Error ? (err.stack || err.message) : String(err)
      console.error(`[ipc] embedding:embed-local crashed:`, msg)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('embedding:embed-dispatch', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const mode = (p.mode === 'local' || p.mode === 'cloud' ? p.mode : 'auto') as 'local' | 'cloud' | 'auto'
    const localModelId = typeof p.localModelId === 'string' ? p.localModelId : undefined
    const cloud = p.cloud && typeof p.cloud === 'object' ? p.cloud as Record<string, unknown> : null
    const texts = Array.isArray(p.texts) ? p.texts.filter((t): t is string => typeof t === 'string') : []
    try {
      const { dispatchEmbed } = await import('../../embedding/dispatch')
      return await dispatchEmbed({
        mode,
        localModelId,
        cloud: cloud ? {
          providerId: String(cloud.providerId || ''),
          model: String(cloud.model || ''),
          apiKey: typeof cloud.apiKey === 'string' ? cloud.apiKey : undefined,
          baseUrl: typeof cloud.baseUrl === 'string' ? cloud.baseUrl : undefined,
          dimensions: typeof cloud.dimensions === 'number' ? cloud.dimensions : undefined,
        } : undefined,
      }, texts)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('embedding:download-local', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const modelId = typeof p.modelId === 'string' ? p.modelId : ''
    if (!modelId) return { ok: false, error: 'modelId required' }
    try {
      const { DOWNLOADABLE_MODELS } = await import('../../embedding/localCatalog')
      const model = DOWNLOADABLE_MODELS.find((m) => m.id === modelId)
      if (!model) return { ok: false, error: `unknown model: ${modelId}` }
      const { downloadModel, isDownloading } = await import('../../embedding/downloader')
      if (isDownloading(modelId)) return { ok: false, error: 'download already running' }
      const handle = downloadModel(model, (progress) => {
        sendToMainWindow('embedding:download-progress', progress)
      })
      return await handle.promise
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('embedding:cancel-download', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const modelId = typeof p.modelId === 'string' ? p.modelId : ''
    if (!modelId) return { ok: true }
    try {
      const { cancelDownload } = await import('../../embedding/downloader')
      cancelDownload(modelId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('embedding:delete-local', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const modelId = typeof p.modelId === 'string' ? p.modelId : ''
    if (!modelId) return { ok: false, error: 'modelId required' }
    try {
      const fsp = await import('node:fs/promises')
      const dir = path.join(app.getPath('userData'), 'downloaded-models', modelId)
      await fsp.rm(dir, { recursive: true, force: true })
      const { unloadLocalModel } = await import('../../embedding/localModel')
      unloadLocalModel(modelId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---------------------------------------------------------------------
  // High-level embedding API — main process owns namespace construction.
  // Renderer no longer needs to know the (kind, fp) layout.
  // ---------------------------------------------------------------------
  ipcMain.handle('embedding:index-attachment', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const sha256 = typeof p.sha256 === 'string' ? p.sha256 : ''
    const kind = typeof p.kind === 'string' ? p.kind : 'unknown'
    const sourceLabel = typeof p.sourceLabel === 'string' ? p.sourceLabel : undefined
    const chunks = Array.isArray(p.chunks) ? p.chunks as Array<Record<string, unknown>> : []
    if (!sha256 || chunks.length === 0) return { ok: true, skipped: true }
    try {
      const { indexAttachment } = await import('../../embedding/highLevelApi')
      return await indexAttachment({
        sha256,
        kind,
        sourceLabel,
        chunks: chunks.map((c, i) => ({
          id: typeof c.id === 'string' ? c.id : undefined,
          index: typeof c.index === 'number' ? c.index : i,
          text: String(c.text ?? ''),
          meta: (c.meta && typeof c.meta === 'object') ? c.meta as Record<string, unknown> : undefined,
        })),
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('embedding:query-attachments', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const query = typeof p.query === 'string' ? p.query : ''
    const topK = typeof p.topK === 'number' ? p.topK : 6
    const attachmentsRaw = Array.isArray(p.attachments) ? p.attachments as Array<Record<string, unknown>> : []
    const attachments = attachmentsRaw
      .map((a) => ({
        sha256: typeof a.sha256 === 'string' ? a.sha256 : '',
        kind: typeof a.kind === 'string' ? a.kind : 'unknown',
      }))
      .filter((a) => a.sha256)
    try {
      const { queryAttachments } = await import('../../embedding/highLevelApi')
      return await queryAttachments({ query, attachments, topK })
    } catch (err) {
      return { ok: false, hits: [], searched: 0, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---------------------------------------------------------------------
  // Registry / GC IPC for the cache panel.
  // ---------------------------------------------------------------------
  ipcMain.handle('embedding:inventory', async () => {
    try {
      const { listAllNamespaces } = await import('../../embedding/registry')
      return { ok: true, entries: await listAllNamespaces() }
    } catch (err) {
      return { ok: false, entries: [], error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('embedding:gc-stale', async (_e, params: unknown) => {
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {}
    const activeFp = typeof p.activeFp === 'string' ? p.activeFp : ''
    if (!activeFp) return { ok: false, removed: 0, bytes: 0, error: 'activeFp required' }
    try {
      const { staleByFp } = await import('../../embedding/registry')
      const { dropNamespace } = await import('../../embedding/vectorStore')
      const stale = await staleByFp(activeFp)
      let removed = 0
      let bytes = 0
      for (const e of stale) {
        await dropNamespace(e.ns)
        removed++
        bytes += e.sizeBytes
      }
      return { ok: true, removed, bytes }
    } catch (err) {
      return { ok: false, removed: 0, bytes: 0, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Resolve the currently-configured embedding model to a fingerprint by
   * actually performing a tiny embed call. This lets the Settings UI know
   * which fp is "active" so it can highlight stale entries in the GC list.
   *
   * Cheap (1 vector × ~50 tokens) and idempotent — the dispatcher uses the
   * same code path the real index/recall flows use, so the fp it returns
   * matches what those flows will write/read.
   */
  ipcMain.handle('embedding:active-fp', async () => {
    try {
      const { dispatchEmbed } = await import('../../embedding/dispatch')
      const { wrapWithFingerprint } = await import('../../embedding/resolved')
      const { readDiskSettings } = await import('../../settings/settingsAccess')
      const s = readDiskSettings() as Record<string, unknown>
      const cfg = {
        mode: (s.embeddingMode === 'local' || s.embeddingMode === 'cloud' ? s.embeddingMode : 'auto') as 'local' | 'cloud' | 'auto',
        localModelId: typeof s.embeddingLocalModelId === 'string' ? s.embeddingLocalModelId : undefined,
        cloud: (typeof s.embeddingProviderId === 'string' && s.embeddingProviderId
          && typeof s.embeddingModel === 'string' && s.embeddingModel)
          ? {
              providerId: s.embeddingProviderId,
              model: s.embeddingModel,
              apiKey: typeof s.embeddingApiKey === 'string' ? s.embeddingApiKey : undefined,
              baseUrl: typeof s.embeddingBaseUrl === 'string' ? s.embeddingBaseUrl : undefined,
              dimensions: typeof s.embeddingDimensions === 'number' ? s.embeddingDimensions : undefined,
            }
          : undefined,
      }
      const r = await dispatchEmbed(cfg, ['fp-probe'])
      if (!r.ok) return { ok: false, error: r.error }
      const w = wrapWithFingerprint(cfg, r)
      return { ok: true, fp: w.fp, model: w.modelLabel, dim: w.dim }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
